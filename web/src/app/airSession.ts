/**
 * AIR 1 session (M3 composition): drives the helicopter, scan coverage / veil, off-screen frame capture,
 * chunking + POST /api/reconstruct (gemini-4-argon), the recon layer and the AIR UI from the quake clock.
 *
 * Time base: flightS = simSeconds − AIR_LAUNCH_S. Helicopter pose, coverage/veil, recon reveal and the UI are
 * pure functions of simSeconds (seek-able). Frame capture + network only happen while the quake is PLAYING.
 *
 * Modes (?air=):
 *   live   (default) capture 1 frame / s of flight → 15-frame chunks → server (Gemini, replay cache) → recon;
 *          a failed chunk falls back to the client mock (mode 'mock', console warning).
 *   mock   no capture/network: virtual chunks (frames at every flight second, tags = buildings under the camera
 *          footprint) + deterministic mock results applied for every chunk that ended before t.
 *   replay no capture/network: the server's cached run for this scenario/hour (GET /api/replay), applied like mock.
 */
import type {
  AppContext,
  BuildingsHandle,
  HelicopterHandle,
  PeopleHandle,
  PeopleTruth,
  QuakeResult,
  ReconHandle,
  ReconstructionRequest,
  ReconstructionResult,
  ScanChunk,
  ScanFrame,
  ScanHandle,
  UiHandle,
  AirUiState,
  XZ,
} from '../contracts';
import { createMockReconstruction } from '../argus/mock';
import { buildingLabel } from '../air/scan';

export type AirMode = 'live' | 'mock' | 'replay';

export const AIR_LAUNCH_S = 50;
const CHUNK_FRAMES = 15;
const FRAME_DT = 1.0;
const REQUEST_TIMEOUT_MS = 180_000;
/** Tags in a virtual (mock) frame: buildings whose centroid is under the footprint and within this range. */
const VIRTUAL_TAG_RANGE = 700;

export interface AirChunkLog {
  chunkIndex: number;
  frames: number;
  buildings: number;
  sentAtMs: number;
  status: 'queued' | 'sent' | 'done' | 'failed';
  mode?: ReconstructionResult['mode'];
  latencyMs?: number;
  observed?: number;
  error?: string;
  bytes?: number;
}

export interface AirSessionDeps {
  ctx: AppContext;
  buildings: BuildingsHandle;
  ui: UiHandle;
  heli: HelicopterHandle;
  scan: ScanHandle;
  recon: ReconHandle;
  people: PeopleHandle;
}

export interface AirSession {
  readonly mode: AirMode;
  begin(result: QuakeResult): PeopleTruth;
  /** Call on every quake-tick (playing or seek). */
  tick(simSeconds: number, playing: boolean): void;
  reset(): void;
  /** Refresh the inspector comparison for the selected building. */
  select(id: string | null): void;
  readonly log: AirChunkLog[];
  readonly framesCaptured: number;
  /** Debug: capture one frame now at the current flight time (returns it). */
  captureNow(): ScanFrame | null;
}

function pointInPoly(x: number, z: number, poly: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function createAirSession(deps: AirSessionDeps, opts: { mode: AirMode; maxInFlight?: number }): AirSession {
  const { ctx, ui, heli, scan, recon, people } = deps;
  const city = ctx.city;
  const recs = city.buildings;
  const mode = opts.mode;
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
  const durationS = heli.durationS;
  const lastFrameK = Math.floor(durationS / FRAME_DT + 1e-6);

  const centre: [number, number][] = recs.map((b) => {
    let cx = 0;
    let cz = 0;
    for (const [x, z] of b.footprint) {
      cx += x;
      cz += z;
    }
    const n = Math.max(1, b.footprint.length);
    return [cx / n, cz / n];
  });
  const idIndex = new Map<string, number>();
  recs.forEach((b, i) => idIndex.set(b.id, i));

  // ── Session state ──
  let gen = 0;
  let result: QuakeResult | null = null;
  let truth: PeopleTruth | null = null;
  let nextK = 0; // next flight second to capture (live)
  let frames: ScanFrame[] = [];
  let chunkCounter = 0;
  let framesCaptured = 0;
  let lastSim = -Infinity;
  const queue: { chunk: ScanChunk; req: ReconstructionRequest; log: AirChunkLog }[] = [];
  let inFlight = 0;
  const log: AirChunkLog[] = [];
  // Deterministic (mock / replay): pre-built chunk + result list, applied lazily up to the current flight time.
  let planned: { chunk: ScanChunk; res: ReconstructionResult }[] = [];
  let appliedCount = 0;
  let replayLoaded = false;
  let lastUiAt = 0;
  let lastUiKey = '';
  let selectedId: string | null = null;
  let lastCmpKey = '';
  let shownAir = false;

  const flightOf = (sim: number) => sim - AIR_LAUNCH_S;

  // ── Request building list (identity/geometry only, NO predicted damage) ──
  function requestBuildings(ids: string[]): ReconstructionRequest['buildings'] {
    const out: ReconstructionRequest['buildings'] = [];
    for (const id of ids) {
      const i = idIndex.get(id);
      if (i === undefined) continue;
      const b = recs[i];
      out.push({
        id,
        tag: buildingLabel(b),
        address: b.address,
        name: b.name,
        x: Math.round(centre[i][0] * 10) / 10,
        z: Math.round(centre[i][1] * 10) / 10,
        height: Math.round(b.height * 10) / 10,
        levels: b.levels,
        use: b.use,
      });
    }
    return out;
  }

  function makeChunk(fr: ScanFrame[]): ScanChunk {
    const ids = new Set<string>();
    for (const f of fr) for (const id of f.taggedBuildingIds) ids.add(id);
    return { chunkIndex: chunkCounter++, frames: fr, buildingIds: [...ids], startFlightS: fr[0].flightS, endFlightS: fr[fr.length - 1].flightS };
  }

  // ── Live: queue + POST ──
  function flushChunk() {
    if (!frames.length || !result) return;
    const chunk = makeChunk(frames);
    frames = [];
    if (!chunk.buildingIds.length) {
      console.info(`[air] chunk ${chunk.chunkIndex}: no tagged buildings (over water), not sent`);
      return;
    }
    const req: ReconstructionRequest = {
      chunkIndex: chunk.chunkIndex,
      scenarioId: result.scenario.id,
      localHour: result.scenario.localHour,
      frames: chunk.frames.map((f) => ({
        index: f.index,
        flightS: f.flightS,
        simS: Math.round(f.simS * 100) / 100,
        position: f.pose.position,
        heading: f.pose.heading,
        jpegBase64: f.jpegBase64,
        taggedBuildingIds: f.taggedBuildingIds,
      })),
      buildings: requestBuildings(chunk.buildingIds),
      mode: 'auto',
    };
    const entry: AirChunkLog = { chunkIndex: chunk.chunkIndex, frames: chunk.frames.length, buildings: req.buildings.length, sentAtMs: 0, status: 'queued' };
    log.push(entry);
    recon.markSent?.(chunk.chunkIndex);
    queue.push({ chunk, req, log: entry });
    pump();
  }

  function pump() {
    while (inFlight < maxInFlight && queue.length) {
      const job = queue.shift()!;
      void send(job, gen);
    }
  }

  async function send(job: { chunk: ScanChunk; req: ReconstructionRequest; log: AirChunkLog }, myGen: number) {
    inFlight++;
    const { chunk, req, log: entry } = job;
    entry.status = 'sent';
    entry.sentAtMs = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res: ReconstructionResult;
    try {
      const body = JSON.stringify(req);
      entry.bytes = body.length;
      const r = await fetch('/api/reconstruct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
      const json = (await r.json().catch(() => ({}))) as ReconstructionResult & { error?: string };
      if (!r.ok || !Array.isArray(json.buildings)) throw new Error(json.error || `HTTP ${r.status}`);
      res = json;
      entry.status = 'done';
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      console.warn(`[air] chunk ${chunk.chunkIndex} failed (${msg}); using mock reconstruction`);
      entry.status = 'failed';
      entry.error = msg;
      if (myGen !== gen || !result) return void (inFlight = Math.max(0, inFlight - 1));
      res = createMockReconstruction(chunk, result, truth, 1000 + chunk.chunkIndex, { city });
      res.error = msg;
    } finally {
      window.clearTimeout(timer);
    }
    inFlight = Math.max(0, inFlight - 1);
    if (myGen !== gen) return; // session reset / new quake meanwhile
    entry.mode = res.mode;
    entry.latencyMs = res.mode === 'mock' ? Math.round(performance.now() - entry.sentAtMs) : res.latencyMs;
    entry.observed = res.buildings.length;
    console.info(`[air] chunk ${chunk.chunkIndex}: ${res.mode} ${res.buildings.length}/${req.buildings.length} bldgs in ${((performance.now() - entry.sentAtMs) / 1000).toFixed(1)} s`);
    recon.apply(res, chunk);
    lastUiKey = '';
    if (Number.isFinite(lastSim)) {
      recon.update?.(lastSim);
      pushUi(lastSim, true);
    }
    pump();
  }

  let capturing = false;
  /** Async capture (preferred): render now, read back + overlay + JPEG later; frames stay in order (one at a time). */
  function captureAsyncAt(k: number, sim: number) {
    if (!scan.captureFrameAsync) {
      onFrame(captureAt(k, sim));
      return;
    }
    const myGen = gen;
    const pose = heli.poseAt(k * FRAME_DT);
    capturing = true;
    recon.suspend?.(true);
    let p: Promise<ScanFrame>;
    try {
      p = scan.captureFrameAsync(pose, sim); // renders synchronously before its first await
    } finally {
      recon.suspend?.(false);
    }
    p.then(
      (f) => {
        capturing = false;
        if (myGen === gen) onFrame(f);
      },
      (err) => {
        capturing = false;
        console.warn('[air] frame capture failed', err);
      },
    );
  }

  function onFrame(f: ScanFrame) {
    frames.push(f);
    framesCaptured++;
    if (frames.length >= CHUNK_FRAMES || nextK > lastFrameK) flushChunk();
  }

  function captureAt(k: number, sim: number): ScanFrame {
    const pose = heli.poseAt(k * FRAME_DT);
    recon.suspend?.(true);
    try {
      return scan.captureFrame(pose, sim);
    } finally {
      recon.suspend?.(false);
    }
  }

  // ── Deterministic virtual chunks (mock) ──
  function virtualChunks(): ScanChunk[] {
    const out: ScanChunk[] = [];
    let fr: ScanFrame[] = [];
    let idx = 0;
    const candidates: number[] = [];
    for (let i = 0; i < recs.length; i++) if (!recs[i].isPart && recs[i].footprint.length >= 3) candidates.push(i);
    for (let k = 0; k <= lastFrameK; k++) {
      const pose = heli.poseAt(k * FRAME_DT);
      const fp = pose.footprint;
      const [hx, , hz] = pose.position;
      const tagged: string[] = [];
      if (fp.length >= 3) {
        for (const i of candidates) {
          const [x, z] = centre[i];
          if (Math.hypot(x - hx, z - hz) > VIRTUAL_TAG_RANGE) continue;
          if (pointInPoly(x, z, fp)) tagged.push(recs[i].id);
        }
      }
      fr.push({ index: k, flightS: k * FRAME_DT, simS: AIR_LAUNCH_S + k * FRAME_DT, pose, jpegBase64: '', taggedBuildingIds: tagged });
      if (fr.length === CHUNK_FRAMES || k === lastFrameK) {
        const ids = new Set<string>();
        for (const f of fr) for (const id of f.taggedBuildingIds) ids.add(id);
        out.push({ chunkIndex: idx++, frames: fr, buildingIds: [...ids], startFlightS: fr[0].flightS, endFlightS: fr[fr.length - 1].flightS });
        fr = [];
      }
    }
    return out;
  }

  async function loadReplay(myGen: number) {
    if (!result) return;
    try {
      const r = await fetch(`/api/replay?scenario=${encodeURIComponent(result.scenario.id)}&hour=${result.scenario.localHour}`);
      const j = (await r.json()) as { chunks: { result: ReconstructionResult; chunk: Omit<ScanChunk, 'frames'> & { frames: Omit<ScanFrame, 'pose' | 'jpegBase64'>[] & { position: [number, number, number]; heading: number }[] } }[] };
      if (myGen !== gen) return;
      planned = (j.chunks ?? []).map(({ result: res, chunk }) => ({
        res,
        chunk: {
          ...chunk,
          frames: chunk.frames.map((f) => ({ ...f, jpegBase64: '', pose: heli.poseAt(f.flightS) })),
        } as ScanChunk,
      }));
      planned.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
      if (!planned.length) {
        console.warn('[air] no cached Argon run for this scenario/hour; falling back to mock');
        planned = virtualChunks().map((c) => ({ chunk: c, res: createMockReconstruction(c, result!, truth, 7 + c.chunkIndex, { city }) }));
      } else console.info(`[air] replay: ${planned.length} cached chunks`);
    } catch (err) {
      console.warn('[air] replay fetch failed; falling back to mock', err);
      if (myGen !== gen || !result) return;
      planned = virtualChunks().map((c) => ({ chunk: c, res: createMockReconstruction(c, result!, truth, 7 + c.chunkIndex, { city }) }));
    }
    replayLoaded = true;
    appliedCount = 0;
    lastUiKey = '';
    if (Number.isFinite(lastSim)) {
      // The quake may be paused (no ticks): reveal + refresh the panel now.
      applyPlannedUpTo(lastSim);
      recon.update?.(lastSim);
      pushUi(lastSim, true);
    }
  }

  /** Apply planned chunks whose last frame is at or before simS (re-begin on backwards seek). */
  function applyPlannedUpTo(sim: number) {
    if (!result || !truth) return;
    let want = 0;
    for (const p of planned) {
      const last = p.chunk.frames[p.chunk.frames.length - 1];
      const endSim = last ? last.simS : AIR_LAUNCH_S + p.chunk.endFlightS;
      if (endSim <= sim + 1e-6) want++;
      else break;
    }
    if (want < appliedCount) {
      recon.begin(result, truth);
      appliedCount = 0;
    }
    for (let k = appliedCount; k < want; k++) {
      recon.markSent?.(planned[k].chunk.chunkIndex);
      recon.apply(planned[k].res, planned[k].chunk);
    }
    if (want !== appliedCount) lastUiKey = '';
    appliedCount = want;
  }

  // ── UI ──
  function statusAt(flightS: number): AirUiState['status'] {
    if (flightS < 0) return 'standby';
    if (flightS >= durationS) return 'complete';
    if (flightS < 6) return 'en route';
    if (flightS > durationS - 8) return 'returning';
    return 'scanning';
  }

  function pushUi(sim: number, force = false) {
    if (!result) return;
    const flightS = flightOf(sim);
    if (flightS < -5) {
      if (shownAir) {
        ui.showAir?.(null);
        shownAir = false;
      }
      return;
    }
    const now = performance.now();
    const stats = recon.stats();
    const pending = Math.max(0, stats.chunksSent - stats.chunksDone);
    const status = statusAt(flightS);
    const key = `${status}|${stats.chunksDone}|${stats.chunksSent}|${stats.buildingsObserved}|${pending}`;
    if (!force && key === lastUiKey && now - lastUiAt < 250) return;
    lastUiKey = key;
    lastUiAt = now;
    const fl = Math.max(0, Math.min(durationS, flightS));
    ui.showAir?.({
      callsign: heli.callsign,
      status,
      flightS: fl,
      durationS,
      scannedFraction: scan.scannedFraction(),
      stats,
      pending,
      mode: stats.mode ?? (mode === 'mock' ? 'mock' : mode === 'replay' ? 'replay' : null),
      avgLatencyS: stats.avgLatencyS,
    });
    shownAir = true;
    refreshComparison();
  }

  function refreshComparison() {
    if (!ui.showComparison) return;
    const c = selectedId ? recon.compare(selectedId) : null;
    const key = c ? `${c.id}|${c.observed.chunkIndex}|${c.observed.damage}|${c.observed.confidence}` : '';
    if (key === lastCmpKey) return;
    lastCmpKey = key;
    ui.showComparison(c);
  }

  const session: AirSession = {
    mode,
    get log() {
      return log;
    },
    get framesCaptured() {
      return framesCaptured;
    },
    begin(r) {
      session.reset();
      gen++;
      result = r;
      truth = people.build(r);
      recon.begin(r, truth);
      if (mode === 'mock') {
        planned = virtualChunks().map((c) => ({ chunk: c, res: createMockReconstruction(c, r, truth, 7 + c.chunkIndex, { city }) }));
        replayLoaded = true;
      } else if (mode === 'replay') {
        void loadReplay(gen);
      }
      return truth;
    },
    tick(sim, playing) {
      if (!result) return;
      const dSim = sim - lastSim;
      lastSim = sim;
      people.update(sim);
      const flightS = flightOf(sim);
      heli.setFlightTime(flightS >= 0 && flightS <= durationS ? flightS : null);
      scan.setCoverageUntil(flightS >= 0 ? Math.min(flightS, durationS) : null);

      if (mode === 'live') {
        // Capture only while playing forward (not on seeks): one frame per FRAME_DT of flight time.
        const forward = playing && dSim > 0 && dSim < 2;
        if (forward && flightS >= 0) {
          if (!capturing && nextK <= lastFrameK && flightS >= nextK * FRAME_DT) {
            const k = Math.min(lastFrameK, Math.floor(flightS / FRAME_DT + 1e-6));
            nextK = k + 1;
            captureAsyncAt(k, sim);
          }
          if (!capturing && nextK > lastFrameK && frames.length) flushChunk();
        } else if (!forward && flightS >= 0) {
          // Seek: never capture the past; resume at the next flight second.
          nextK = Math.max(nextK, Math.ceil(Math.max(0, flightS) / FRAME_DT));
        }
      } else if (replayLoaded) {
        applyPlannedUpTo(sim);
      }
      recon.update?.(sim);
      pushUi(sim);
    },
    reset() {
      gen++;
      result = null;
      truth = null;
      nextK = 0;
      frames = [];
      capturing = false;
      chunkCounter = 0;
      framesCaptured = 0;
      lastSim = -Infinity;
      queue.length = 0;
      inFlight = 0;
      log.length = 0;
      planned = [];
      appliedCount = 0;
      replayLoaded = false;
      lastUiKey = '';
      lastCmpKey = '';
      people.reset();
      heli.setFlightTime(null);
      scan.reset();
      recon.reset();
      if (shownAir) ui.showAir?.(null);
      shownAir = false;
      ui.showComparison?.(null);
    },
    select(id) {
      selectedId = id;
      lastCmpKey = '#';
      refreshComparison();
    },
    captureNow() {
      if (!result) return null;
      const f = heli.flightTime;
      if (f === null) return null;
      return captureAt(f / FRAME_DT, AIR_LAUNCH_S + f);
    },
  };
  return session;
}
