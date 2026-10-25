/**
 * M4 drone session: Argon-planned, commander-approved drone verification on top of the AIR 1 session.
 *
 * Flow (any scenario; demo = san_andreas_1906 at 15:00):
 *   heli / drone result revealed → (debounce 3 s sim) → POST /api/plan (gemini-4-argon, text-only) with
 *   buildPlanRequest(...) → 'thinking' card → dispatch=false: 'hold' card, retry on the next result;
 *   dispatch=true: PAUSE the sim + 'proposed' card → Approve: fleet.assign(missions, simS), resume, 'executing'
 *   card (progress from fleet.schedule()); Reject: resume, 'rejected' card (doesn't count as a wave).
 *   Wave 1 waits for the full helicopter pass (flight complete, every sent chunk reconstructed; 60 s safety valve);
 *   wave 2 needs wave 1 finished (every target's chunk applied). Max 2 waves.
 *
 * Drone capture (live): while playing, every drone orbiting a target captures one frame / 1.5 s sim (one capture
 * at a time, drones staggered) via scan.captureFrameAsync(dronePose); frames accumulate per (mission, target);
 * when the target's orbit ends the chunk goes to /api/reconstruct (source 'drone', droneId, missionId,
 * targetBuildingIds=[target], chunkIndex 1000 + wave·100 + drone·10 + target) → recon.apply.
 *
 * Modes (?air=): live (above; plans + decisions + a few thumbnails are recorded to /api/m4run for replay);
 *   mock (heuristic plans, virtual drone chunks + deterministic mock results, no network);
 *   replay (recorded plans auto-approved at their recorded sim time, drone results from the server replay index).
 */
import type {
  AppContext,
  DroneFeed,
  DroneFleetHandle,
  DroneId,
  DronePlan,
  DronePose,
  DroneScheduleEntry,
  PeopleTruth,
  PlanRequest,
  PlanUiState,
  QuakeResult,
  ReconHandle,
  ReconstructionRequest,
  ReconstructionResult,
  ScanChunk,
  ScanFrame,
  ScanHandle,
  UiHandle,
} from '../contracts';
import { buildPlanRequest, buildingName } from '../argus/planner';
import { requestPlan } from '../argus/planClient';
import { createMockPlan } from '../argus/planMock';
import { createMockReconstruction } from '../argus/mock';
import { buildingLabel } from '../air/scan';
import type { AirMode, AirSession } from './airSession';

const DRONE_IDS: DroneId[] = ['D1', 'D2', 'D3'];
const MAX_WAVES = 2;
const DEBOUNCE_S = 3;
const CAPTURE_DT = 1.5;
const MIN_HELI_CHUNKS = 2;
const REQUEST_TIMEOUT_MS = 180_000;
const PLAN_TIMEOUT_MS = 90_000;
/** Thumbnails kept per target in the run record (air=replay feeds). */
const THUMBS_PER_TARGET = 4;

type Decision = 'approved' | 'rejected' | 'hold';

export interface WaveRecord {
  wave: 1 | 2;
  plan: DronePlan;
  /** Sim time the plan arrived (sim paused there when dispatch=true). */
  proposedAtS: number;
  decision: Decision;
  decidedAtS: number;
}

export interface M4RunRecord {
  version: 1;
  scenarioId: string;
  localHour: number;
  waves: WaveRecord[];
  /** `${missionId}#${targetIndex}` → a few captured frames (replay thumbnails). */
  thumbs: Record<string, { simS: number; jpeg: string }[]>;
}

export interface DronePlanLog {
  wave: number;
  requestedAtS: number;
  proposedAtS?: number;
  latencyMs?: number;
  wallMs?: number;
  mode?: DronePlan['mode'];
  model?: string;
  dispatch?: boolean;
  candidates: number;
  dronesAvailable: DroneId[];
  missions?: { id: string; droneId: DroneId; kind: string; targets: string[]; purpose: string }[];
  rationale?: string;
  holdReason?: string;
  decision?: Decision;
  error?: string;
}

export interface DroneChunkLog {
  chunkIndex: number;
  missionId: string;
  droneId: DroneId;
  target: string;
  frames: number;
  buildings: number;
  sentAtS: number;
  sentAtMs: number;
  status: 'empty' | 'sent' | 'done' | 'failed';
  mode?: ReconstructionResult['mode'];
  latencyMs?: number;
  observed?: number;
  targetObserved?: { damage: string; confidence: number; peopleVisible: number; trappedSigns: boolean } | null;
  error?: string;
}

export interface DroneSessionDeps {
  ctx: AppContext;
  ui: UiHandle;
  fleet: DroneFleetHandle;
  scan: ScanHandle;
  recon: ReconHandle;
  air: AirSession;
  /** Current quake sim time (fx.simSeconds). */
  simNow(): number;
  /** Sim clock running (quake playing, not paused). */
  running(): boolean;
  pause(): void;
  resume(): void;
}

export interface DroneSession {
  readonly mode: AirMode;
  begin(result: QuakeResult, truth: PeopleTruth): void;
  /** Call on every quake tick (playing or seek). */
  tick(simSeconds: number, playing: boolean): void;
  approve(): void;
  reject(): void;
  reset(): void;
  readonly plans: DronePlanLog[];
  readonly chunks: DroneChunkLog[];
  readonly waves: WaveRecord[];
  readonly framesCaptured: number;
  /** 'idle' | 'thinking' | 'proposed'. */
  readonly planState: 'idle' | 'thinking' | 'proposed';
  readonly pendingPlan: DronePlan | null;
}

interface Acc {
  key: string;
  missionId: string;
  wave: 1 | 2;
  droneId: DroneId;
  target: string;
  targetIndex: number;
  arriveS: number;
  leaveS: number;
  nextS: number;
  frames: ScanFrame[];
  capturing: boolean;
  flushed: boolean;
}

const keyOf = (missionId: string, i: number) => `${missionId}#${i}`;

/**
 * Drone results count for the mission's TARGET buildings only. The drone orbits and centres its target; neighbours
 * at the frame edges are seen obliquely / partially and were often under-called with high confidence (live run:
 * applying them dropped model+Argon macro-F1 0.508 → 0.478; targets only: 0.508 → 0.551). Roads / crowds are kept.
 * The rule never looks at truth.
 */
function focusOnTargets(res: ReconstructionResult, chunk: Pick<ScanChunk, 'targetBuildingIds'>): ReconstructionResult {
  const t = chunk.targetBuildingIds ?? [];
  return t.length ? { ...res, buildings: res.buildings.filter((b) => t.includes(b.id)) } : res;
}

/** Downscale a frame for the run record (replay thumbnails): ~480 px wide JPEG. */
async function shrinkJpeg(b64: string, width = 480): Promise<string> {
  try {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((width * img.naturalHeight) / Math.max(1, img.naturalWidth));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? b64;
  } catch {
    return b64;
  }
}
const droneNum = (id: DroneId) => Number(id.slice(1));
const chunkIndexOf = (wave: number, id: DroneId, i: number) => 1000 + wave * 100 + droneNum(id) * 10 + i;

export function createDroneSession(deps: DroneSessionDeps, opts: { mode: AirMode }): DroneSession {
  const { ctx, ui, fleet, scan, recon, air } = deps;
  const mode = opts.mode;
  const city = ctx.city;
  const recs = city.buildings;
  const idIndex = new Map<string, number>();
  recs.forEach((b, i) => idIndex.set(b.id, i));
  const centreOf = (i: number): [number, number] => {
    let cx = 0;
    let cz = 0;
    for (const [x, z] of recs[i].footprint) {
      cx += x;
      cz += z;
    }
    const n = Math.max(1, recs[i].footprint.length);
    return [cx / n, cz / n];
  };
  const nameOf = (id: string) => {
    const i = idIndex.get(id);
    return i === undefined ? id : buildingName(recs[i]).replace(/;[^ ]*/g, '');
  };

  // ── State ──
  let gen = 0;
  let result: QuakeResult | null = null;
  let truth: PeopleTruth | null = null;
  let planState: 'idle' | 'thinking' | 'proposed' = 'idle';
  let pending: { wave: 1 | 2; plan: DronePlan; proposedAtS: number; log: DronePlanLog } | null = null;
  let wantPlanAt: number | null = null;
  let lastHistLen = 0;
  let waves: WaveRecord[] = [];
  const planLog: DronePlanLog[] = [];
  const chunkLog: DroneChunkLog[] = [];
  const accs = new Map<string, Acc>();
  const targetDone = new Set<string>();
  const finishedWaves = new Set<number>();
  const latestFrame: Partial<Record<DroneId, string>> = {};
  let thumbs: M4RunRecord['thumbs'] = {};
  let capturing = false;
  let framesCaptured = 0;
  let lastFrameSim = -Infinity;
  let holdUntilMs = 0;
  let rejectedUntilMs = 0;
  let feedsShown = false;
  let lastCardKey = '';
  let mockExtra: { chunk: ScanChunk; res: ReconstructionResult }[] = [];

  const approvedWaves = () => waves.filter((w) => w.decision === 'approved');
  const scheduleOf = (w: WaveRecord, sched = fleet.schedule()) => sched.filter((e) => w.plan.missions.some((m) => m.id === e.missionId));

  // ── Request helpers ──
  function requestBuildings(ids: string[]): ReconstructionRequest['buildings'] {
    const out: ReconstructionRequest['buildings'] = [];
    for (const id of ids) {
      const i = idIndex.get(id);
      if (i === undefined) continue;
      const b = recs[i];
      const [x, z] = centreOf(i);
      out.push({ id, tag: buildingLabel(b), address: b.address, name: b.name, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, height: Math.round(b.height * 10) / 10, levels: b.levels, use: b.use });
    }
    return out;
  }

  /** Drones with no target still ahead (returning drones count as free: assign() queues after landing). */
  function freeDrones(sim: number): DroneId[] {
    const sched = fleet.schedule();
    return DRONE_IDS.filter((id) => !sched.some((e) => e.droneId === id && (e.targets.length ? e.targets[e.targets.length - 1].leaveS : e.endS) > sim));
  }

  function previousPlans(): PlanRequest['previousPlans'] {
    const obs = recon.observations?.();
    return waves
      .filter((w) => w.decision !== 'hold')
      .map((w) => {
        const outcome: string[] = [];
        if (w.decision === 'approved' && obs) {
          for (const m of w.plan.missions)
            for (const id of m.targetBuildingIds) {
              const o = obs.get(id);
              if (o && o.source === 'drone') outcome.push(`${nameOf(id)} (${id}): ${o.damage} conf ${o.confidence.toFixed(2)}${o.trappedSigns ? ', trapped signs' : ''}${o.peopleVisible ? `, ${o.peopleVisible} people` : ''}`);
              else if (finishedWaves.has(w.wave)) outcome.push(`${nameOf(id)} (${id}): not assessable from drone footage`);
            }
        }
        return {
          wave: w.wave,
          approved: w.decision === 'approved',
          missions: w.plan.missions.map((m) => `${m.droneId} → ${m.targetBuildingIds.map((id) => `${nameOf(id)} (${id})`).join(', ')}`),
          outcome: outcome.length ? `drone observations: ${outcome.join('; ')}` : undefined,
        };
      });
  }

  /** Sim time the helicopter pass was first seen complete (wave-1 safety valve). */
  let heliCompleteAt: number | null = null;
  function heliDone(): number {
    return (recon.stats().history ?? []).filter((h) => h.source === 'heli').length;
  }

  // ── Run record (live → replay) ──
  let saveTimer = 0;
  function saveRecord() {
    if (mode !== 'live' || !result) return;
    const rec: M4RunRecord = { version: 1, scenarioId: result.scenario.id, localHour: result.scenario.localHour, waves, thumbs };
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const q = `scenario=${encodeURIComponent(rec.scenarioId)}&hour=${rec.localHour}`;
      fetch(`/api/m4run?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) }).catch((e) => console.warn('[drones] run record save failed', e));
    }, 200);
  }

  // ── Planning ──
  function canPlan(sim: number): 1 | 2 | 0 {
    if (mode === 'replay' || !result) return 0;
    const aw = approvedWaves();
    if (aw.length >= MAX_WAVES) return 0;
    if (!freeDrones(sim).length) return 0;
    // Wave 1 waits for the whole helicopter pass: flight complete and every sent heli chunk reconstructed, so the
    // plan is made on the full aerial picture (and the corrected-model gain is visible before drones launch).
    // Safety valve: plan anyway once ≥ MIN_HELI_CHUNKS are back and the flight ended > 60 s ago.
    if (aw.length === 0) {
      const done = heliDone();
      if (air.heliStatus(sim) !== 'complete' || done < MIN_HELI_CHUNKS) {
        heliCompleteAt = null;
        return 0;
      }
      if (heliCompleteAt === null) heliCompleteAt = sim;
      const st = recon.stats();
      const allBack = st.chunksDone >= st.chunksSent;
      return allBack || sim - heliCompleteAt > 60 ? 1 : 0;
    }
    return finishedWaves.has(aw[aw.length - 1].wave) ? 2 : 0;
  }

  async function makePlan(sim: number, wave: 1 | 2) {
    if (!result) return;
    const myGen = gen;
    planState = 'thinking';
    lastCardKey = '';
    ui.showPlan?.(null, 'thinking', { wavesUsed: approvedWaves().length });
    const req = buildPlanRequest({
      city,
      result,
      recon,
      scanned: (i) => scan.isScanned(i),
      scannedFraction: scan.scannedFraction(),
      heliStatus: air.heliStatus(sim),
      chunksDone: heliDone(),
      chunksTotal: air.chunksTotal,
      simS: Math.round(sim * 10) / 10,
      wave,
      dronesAvailable: freeDrones(sim),
      drone: { speedMs: fleet.speedMs, altitudeAGL: fleet.altitudeAGL, orbitS: fleet.orbitS, base: fleet.base, enduranceS: fleet.enduranceS },
      previousPlans: previousPlans(),
      mode: 'auto',
    });
    const entry: DronePlanLog = { wave, requestedAtS: req.simS, candidates: req.candidates.length, dronesAvailable: req.dronesAvailable };
    planLog.push(entry);
    const t0 = performance.now();
    const plan = mode === 'mock' ? createMockPlan(req) : await requestPlan(req, { timeoutMs: PLAN_TIMEOUT_MS });
    if (myGen !== gen || !result) return;
    const now = deps.simNow();
    Object.assign(entry, {
      proposedAtS: Math.round(now * 10) / 10,
      latencyMs: plan.latencyMs,
      wallMs: Math.round(performance.now() - t0),
      mode: plan.mode,
      model: plan.model,
      dispatch: plan.dispatch,
      missions: plan.missions.map((m) => ({ id: m.id, droneId: m.droneId, kind: m.kind, targets: m.targetBuildingIds, purpose: m.purpose })),
      rationale: plan.rationale,
      holdReason: plan.holdReason,
      error: plan.error,
    });
    console.info(
      `[drones] plan wave ${wave}: ${plan.mode} dispatch=${plan.dispatch} in ${entry.wallMs} ms — ${plan.missions.map((m) => `${m.droneId}→${m.targetBuildingIds.join('+')}`).join(' ') || plan.holdReason}`,
    );
    lastCardKey = '';
    if (!plan.dispatch || !plan.missions.length) {
      entry.decision = 'hold';
      waves.push({ wave, plan, proposedAtS: now, decision: 'hold', decidedAtS: now });
      planState = 'idle';
      holdUntilMs = performance.now() + 7000;
      ui.showPlan?.(plan, 'hold', { wavesUsed: approvedWaves().length });
      saveRecord();
      return;
    }
    pending = { wave, plan, proposedAtS: now, log: entry };
    planState = 'proposed';
    deps.pause();
    ui.showPlan?.(plan, 'proposed', { wavesUsed: approvedWaves().length, simS: now });
  }

  // ── Mock drone chunks (deterministic, no network) ──
  function mockChunksFor(entries: DroneScheduleEntry[], wave: 1 | 2): { chunk: ScanChunk; res: ReconstructionResult }[] {
    if (!result) return [];
    const out: { chunk: ScanChunk; res: ReconstructionResult }[] = [];
    for (const e of entries) {
      e.targets.forEach((t, i) => {
        const frames: ScanFrame[] = [];
        let k = 0;
        for (let s = t.arriveS + 0.75; s < t.leaveS; s += CAPTURE_DT) {
          const pose = fleet.posesAt(s).find((p) => p.droneId === e.droneId)!;
          frames.push({ index: k++, flightS: pose.flightS, simS: s, pose, jpegBase64: '', taggedBuildingIds: [t.buildingId] });
        }
        if (!frames.length) return;
        const chunk: ScanChunk = {
          source: 'drone',
          droneId: e.droneId,
          missionId: e.missionId,
          targetBuildingIds: [t.buildingId],
          chunkIndex: chunkIndexOf(wave, e.droneId, i),
          frames,
          buildingIds: [t.buildingId],
          startFlightS: frames[0].flightS,
          endFlightS: frames[frames.length - 1].flightS,
        };
        const res = focusOnTargets(createMockReconstruction(chunk, result!, truth, 77 + chunk.chunkIndex, { city }), chunk);
        out.push({ chunk, res });
      });
    }
    return out;
  }

  function startWave(rec: WaveRecord) {
    const sched = scheduleOf(rec);
    if (mode === 'live') {
      for (const e of sched)
        e.targets.forEach((t, i) => {
          const key = keyOf(e.missionId, i);
          if (accs.has(key)) return;
          accs.set(key, {
            key,
            missionId: e.missionId,
            wave: rec.wave,
            droneId: e.droneId,
            target: t.buildingId,
            targetIndex: i,
            arriveS: t.arriveS,
            leaveS: t.leaveS,
            nextS: t.arriveS + 0.4 + 0.5 * (droneNum(e.droneId) - 1),
            frames: [],
            capturing: false,
            flushed: false,
          });
        });
    } else if (mode === 'mock') {
      mockExtra = [...mockExtra, ...mockChunksFor(sched, rec.wave)];
      air.setExtraPlanned(mockExtra);
    }
  }

  // ── Live drone capture + send ──
  function captureFor(acc: Acc, sim: number) {
    const pose = fleet.posesAt(sim).find((p) => p.droneId === acc.droneId);
    if (!pose || pose.phase !== 'orbit' || pose.missionId !== acc.missionId) {
      acc.nextS = sim + 0.25;
      return;
    }
    acc.nextS = sim + CAPTURE_DT;
    if (!scan.captureFrameAsync) return;
    const myGen = gen;
    capturing = true;
    acc.capturing = true;
    recon.suspend?.(true);
    let p: Promise<ScanFrame>;
    try {
      p = scan.captureFrameAsync(pose as DronePose, sim);
    } finally {
      recon.suspend?.(false);
    }
    p.then(
      (f) => {
        capturing = false;
        acc.capturing = false;
        if (myGen !== gen) return;
        acc.frames.push(f);
        framesCaptured++;
        latestFrame[acc.droneId] = f.jpegBase64;
        const th = (thumbs[acc.key] ??= []);
        const every = Math.max(1, Math.round((acc.leaveS - acc.arriveS) / CAPTURE_DT / THUMBS_PER_TARGET));
        if ((acc.frames.length - 1) % every === 0 && th.length < THUMBS_PER_TARGET) {
          const item = { simS: Math.round(f.simS * 100) / 100, jpeg: '' };
          th.push(item);
          void shrinkJpeg(f.jpegBase64).then((j) => (item.jpeg = j));
        }
      },
      (err) => {
        capturing = false;
        acc.capturing = false;
        console.warn('[drones] frame capture failed', err);
      },
    );
  }

  function markTargetDone(acc: Acc) {
    targetDone.add(acc.key);
    checkWavesFinished(deps.simNow());
  }

  async function flush(acc: Acc) {
    acc.flushed = true;
    if (!result) return;
    const myGen = gen;
    const sim = deps.simNow();
    const fr = acc.frames;
    const entry: DroneChunkLog = {
      chunkIndex: chunkIndexOf(acc.wave, acc.droneId, acc.targetIndex),
      missionId: acc.missionId,
      droneId: acc.droneId,
      target: acc.target,
      frames: fr.length,
      buildings: 0,
      sentAtS: Math.round(sim * 10) / 10,
      sentAtMs: performance.now(),
      status: 'sent',
    };
    chunkLog.push(entry);
    if (!fr.length) {
      entry.status = 'empty';
      console.info(`[drones] ${acc.key}: no frames captured (seek / paused), skipped`);
      markTargetDone(acc);
      return;
    }
    const ids = [acc.target];
    for (const f of fr) for (const id of f.taggedBuildingIds) if (!ids.includes(id)) ids.push(id);
    const chunk: ScanChunk = {
      source: 'drone',
      droneId: acc.droneId,
      missionId: acc.missionId,
      targetBuildingIds: [acc.target],
      chunkIndex: entry.chunkIndex,
      frames: fr,
      buildingIds: ids,
      startFlightS: fr[0].flightS,
      endFlightS: fr[fr.length - 1].flightS,
    };
    const req: ReconstructionRequest = {
      chunkIndex: chunk.chunkIndex,
      scenarioId: result.scenario.id,
      localHour: result.scenario.localHour,
      frames: fr.map((f, k) => ({
        index: k,
        flightS: Math.round(f.flightS * 100) / 100,
        simS: Math.round(f.simS * 100) / 100,
        position: f.pose.position,
        heading: f.pose.heading,
        jpegBase64: f.jpegBase64,
        taggedBuildingIds: f.taggedBuildingIds,
      })),
      buildings: requestBuildings(ids),
      mode: 'auto',
      source: 'drone',
      droneId: acc.droneId,
      missionId: acc.missionId,
      targetBuildingIds: [acc.target],
    };
    entry.buildings = req.buildings.length;
    recon.markSent?.(chunk.chunkIndex);
    air.refresh();
    saveRecord(); // thumbnails for this target
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: ReconstructionResult;
    try {
      const r = await fetch('/api/reconstruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: ac.signal });
      const json = (await r.json().catch(() => ({}))) as ReconstructionResult & { error?: string };
      if (!r.ok || !Array.isArray(json.buildings)) throw new Error(json.error || `HTTP ${r.status}`);
      res = json;
      entry.status = 'done';
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      console.warn(`[drones] ${acc.key} chunk ${chunk.chunkIndex} failed (${msg}); using mock reconstruction`);
      entry.status = 'failed';
      entry.error = msg;
      if (myGen !== gen || !result) return;
      res = createMockReconstruction(chunk, result, truth, 77 + chunk.chunkIndex, { city });
      res.error = msg;
    } finally {
      window.clearTimeout(timer);
    }
    if (myGen !== gen) return;
    entry.mode = res.mode;
    entry.latencyMs = res.mode === 'mock' ? Math.round(performance.now() - entry.sentAtMs) : res.latencyMs;
    entry.observed = res.buildings.length;
    const tb = res.buildings.find((b) => b.id === acc.target);
    entry.targetObserved = tb ? { damage: tb.damage, confidence: tb.confidence, peopleVisible: tb.peopleVisible, trappedSigns: tb.trappedSigns } : null;
    console.info(
      `[drones] ${acc.key} (${acc.target}) chunk ${chunk.chunkIndex}: ${res.mode} ${res.buildings.length}/${req.buildings.length} bldgs, target ${tb ? `${tb.damage} ${tb.confidence}` : 'n/a'} in ${((performance.now() - entry.sentAtMs) / 1000).toFixed(1)} s`,
    );
    recon.apply(focusOnTargets(res, chunk), chunk);
    air.refresh();
    markTargetDone(acc);
  }

  function checkWavesFinished(sim: number) {
    const sched = fleet.schedule();
    for (const w of approvedWaves()) {
      if (finishedWaves.has(w.wave)) continue;
      const entries = scheduleOf(w, sched);
      if (!entries.length) continue;
      let done: boolean;
      if (mode === 'live') done = entries.every((e) => e.targets.every((_, i) => targetDone.has(keyOf(e.missionId, i))));
      else done = entries.every((e) => e.targets.every((t) => sim >= t.leaveS));
      if (done) {
        finishedWaves.add(w.wave);
        lastCardKey = '';
        console.info(`[drones] wave ${w.wave} finished at sim ${sim.toFixed(1)} s`);
        if (approvedWaves().length < MAX_WAVES) wantPlanAt = sim + DEBOUNCE_S;
      }
    }
  }

  /** Per animation frame: smooth drone visuals + live capture scheduling. */
  function frame() {
    if (!result) return;
    const sim = deps.simNow();
    fleet.setTime(sim);
    if (mode !== 'live' || !accs.size) return;
    const dSim = sim - lastFrameSim;
    lastFrameSim = sim;
    const forward = deps.running() && dSim > 0 && dSim < 3;
    // Targets whose orbit ended → send (wait for an in-flight capture of that target).
    for (const acc of accs.values()) if (!acc.flushed && !acc.capturing && sim >= acc.leaveS) void flush(acc);
    if (!forward || capturing || air.captureBusy) return;
    // At most one capture per animation frame: the most overdue orbiting drone.
    let best: Acc | null = null;
    for (const acc of accs.values()) {
      if (acc.flushed || sim < acc.arriveS || sim >= acc.leaveS || sim < acc.nextS) continue;
      if (!best || acc.nextS < best.nextS) best = acc;
    }
    if (best) captureFor(best, sim);
  }
  ctx.onUpdate(() => frame());
  air.blockCapture = () => capturing;

  // ── Replay ──
  async function loadReplay(myGen: number) {
    if (!result) return;
    const q = `scenario=${encodeURIComponent(result.scenario.id)}&hour=${result.scenario.localHour}`;
    try {
      const [rec, dr] = await Promise.all([
        fetch(`/api/m4run?${q}`).then((r) => r.json() as Promise<Partial<M4RunRecord>>),
        fetch(`/api/replay?${q}&source=drone`).then((r) => r.json() as Promise<{ chunks?: { result: ReconstructionResult; chunk: Omit<ScanChunk, 'frames'> & { frames: { index: number; flightS: number; simS: number; position: [number, number, number]; heading: number; taggedBuildingIds: string[] }[] } }[] }>),
      ]);
      if (myGen !== gen || !result) return;
      waves = (rec.waves ?? []).filter((w) => w.decision === 'approved').sort((a, b) => a.decidedAtS - b.decidedAtS);
      thumbs = rec.thumbs ?? {};
      for (const w of waves) fleet.assign(w.plan.missions, w.decidedAtS);
      const sched = fleet.schedule();
      const items: { chunk: ScanChunk; res: ReconstructionResult }[] = [];
      for (const { result: res, chunk } of dr.chunks ?? []) {
        const e = sched.find((s) => s.missionId === chunk.missionId);
        const target = chunk.targetBuildingIds?.[0];
        if (!e || !target || !e.targets.some((t) => t.buildingId === target)) continue;
        items.push({
          res: focusOnTargets(res, chunk),
          chunk: {
            ...chunk,
            frames: chunk.frames.map((f) => ({
              ...f,
              jpegBase64: '',
              pose: { flightS: f.flightS, position: f.position, heading: f.heading, cameraTarget: f.position, fovDeg: 34, footprint: [] },
            })),
          },
        });
      }
      air.setExtraPlanned(items);
      console.info(`[drones] replay: ${waves.length} approved wave(s), ${items.length} drone chunks`);
      lastCardKey = '';
      const sim = deps.simNow();
      fleet.setTime(sim);
      checkWavesFinished(sim);
      pushUi(sim);
    } catch (err) {
      console.warn('[drones] replay load failed', err);
    }
  }

  // ── UI ──
  function pushUi(sim: number) {
    const aw = approvedWaves().filter((w) => mode !== 'replay' || sim >= w.decidedAtS);
    const sched = fleet.schedule();
    // Plan card (thinking / proposed are shown by the planner itself; hold / rejected auto-hide in the UI).
    if (planState === 'idle' && performance.now() > holdUntilMs && performance.now() > rejectedUntilMs) {
      const cur = aw[aw.length - 1];
      if (cur) {
        const finished = mode === 'replay' ? scheduleOf(cur, sched).every((e) => e.targets.every((t) => sim >= t.leaveS)) : finishedWaves.has(cur.wave);
        const state: PlanUiState = finished ? 'done' : 'executing';
        const key = `${state}|${cur.wave}|${aw.length}`;
        if (state === 'executing' || key !== lastCardKey) ui.showPlan?.(cur.plan, state, { schedule: sched, simS: sim, wavesUsed: aw.length });
        lastCardKey = key;
      } else if (lastCardKey !== 'none') {
        if (lastCardKey) ui.showPlan?.(null, 'done');
        lastCardKey = 'none';
      }
    }
    // Drone feeds (after the first approved wave).
    if (!aw.length) {
      if (feedsShown) ui.showDroneFeeds?.([]);
      feedsShown = false;
      return;
    }
    const poses = fleet.posesAt(sim);
    const feeds: DroneFeed[] = poses.map((p) => {
      const e = p.missionId ? sched.find((s) => s.missionId === p.missionId) : undefined;
      const tIdx = p.targetIndex ?? -1;
      const tgt = e && tIdx >= 0 ? e.targets[tIdx]?.buildingId : undefined;
      const label = tgt ? `${p.droneId} · ${p.phase} ${nameOf(tgt)}` : `${p.droneId} · ${p.phase}`;
      let jpeg: string | null = latestFrame[p.droneId] ?? null;
      if (mode === 'replay') {
        jpeg = null;
        if (p.missionId && tIdx >= 0) {
          const th = thumbs[keyOf(p.missionId, tIdx)] ?? [];
          for (const t of th) if (t.simS <= sim + 0.01 && t.jpeg) jpeg = t.jpeg;
          if (!jpeg && th.length && p.phase === 'orbit') jpeg = th[0].jpeg || null;
        }
        if (!jpeg) {
          // Ended: the last thumbnail of the drone's latest finished target.
          let best: { simS: number; jpeg: string } | null = null;
          for (const [k, th] of Object.entries(thumbs)) {
            const m = sched.find((s) => k.startsWith(`${s.missionId}#`) && s.droneId === p.droneId);
            if (!m) continue;
            for (const t of th) if (t.jpeg && t.simS <= sim && (!best || t.simS > best.simS)) best = t;
          }
          jpeg = best?.jpeg ?? null;
        }
      }
      return { droneId: p.droneId, phase: p.phase, label, jpegBase64: jpeg, missionId: p.missionId };
    });
    ui.showDroneFeeds?.(feeds);
    feedsShown = true;
  }

  const session: DroneSession = {
    mode,
    get plans() {
      return planLog;
    },
    get chunks() {
      return chunkLog;
    },
    get waves() {
      return waves;
    },
    get framesCaptured() {
      return framesCaptured;
    },
    get planState() {
      return planState;
    },
    get pendingPlan() {
      return pending?.plan ?? null;
    },
    begin(r, t) {
      session.reset();
      gen++;
      result = r;
      truth = t;
      if (mode === 'replay') void loadReplay(gen);
    },
    tick(sim, playing) {
      if (!result) return;
      // A new revealed result (heli or drone) → (debounced) planning trigger.
      const hist = recon.stats().history ?? [];
      if (hist.length !== lastHistLen) {
        if (hist.length > lastHistLen && planState === 'idle') wantPlanAt = Math.max(wantPlanAt ?? -Infinity, sim + DEBOUNCE_S);
        lastHistLen = hist.length;
      }
      checkWavesFinished(sim);
      if (playing && planState === 'idle' && wantPlanAt !== null && sim >= wantPlanAt) {
        wantPlanAt = null;
        const w = canPlan(sim);
        if (w) void makePlan(sim, w);
      }
      pushUi(sim);
    },
    approve() {
      if (planState !== 'proposed' || !pending) return;
      const sim = deps.simNow();
      const { plan, wave, proposedAtS, log } = pending;
      pending = null;
      planState = 'idle';
      log.decision = 'approved';
      try {
        fleet.assign(plan.missions, sim);
      } catch (err) {
        console.warn('[drones] fleet.assign failed', err); // never leave the sim paused on a planning bug
      }
      const rec: WaveRecord = { wave, plan, proposedAtS, decision: 'approved', decidedAtS: sim };
      waves.push(rec);
      startWave(rec);
      saveRecord();
      lastCardKey = '';
      console.info(`[drones] wave ${wave} approved at sim ${sim.toFixed(1)} s: ${plan.missions.map((m) => `${m.id}→${m.targetBuildingIds.join('+')}`).join(' ')}`);
      ui.showPlan?.(plan, 'executing', { schedule: fleet.schedule(), simS: sim, wavesUsed: approvedWaves().length });
      deps.resume();
      pushUi(sim);
    },
    reject() {
      if (planState !== 'proposed' || !pending) return;
      const sim = deps.simNow();
      const { plan, wave, proposedAtS, log } = pending;
      pending = null;
      planState = 'idle';
      log.decision = 'rejected';
      waves.push({ wave, plan, proposedAtS, decision: 'rejected', decidedAtS: sim });
      saveRecord();
      rejectedUntilMs = performance.now() + 6000;
      lastCardKey = '';
      ui.showPlan?.(plan, 'rejected', { wavesUsed: approvedWaves().length });
      deps.resume();
    },
    reset() {
      gen++;
      heliCompleteAt = null;
      result = null;
      truth = null;
      planState = 'idle';
      pending = null;
      wantPlanAt = null;
      lastHistLen = 0;
      waves = [];
      planLog.length = 0;
      chunkLog.length = 0;
      accs.clear();
      targetDone.clear();
      finishedWaves.clear();
      for (const id of DRONE_IDS) delete latestFrame[id];
      thumbs = {};
      capturing = false;
      framesCaptured = 0;
      lastFrameSim = -Infinity;
      holdUntilMs = 0;
      rejectedUntilMs = 0;
      mockExtra = [];
      window.clearTimeout(saveTimer);
      fleet.reset();
      ui.showPlan?.(null, 'done');
      lastCardKey = '';
      if (feedsShown) ui.showDroneFeeds?.([]);
      feedsShown = false;
    },
  };
  return session;
}
