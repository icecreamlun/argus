/**
 * Argus recon layer (M3): applies Argon reconstruction results to the city, and compares them with the quake
 * model's prediction and the hidden truth.
 *
 * Visuals (only for results revealed at the current simSeconds, see update()):
 *   - observed buildings tinted by OBSERVED damage (BuildingsHandle.setOverlayColor, 5-step ramp)
 *   - HTML pins projected each frame for collapses, people / trapped signs, fires and crowds (decluttered,
 *     hidden behind terrain)
 *   - blocked / partially blocked streets as short red / amber dashes on the carriageway
 * Markers live on render layer RECON_LAYER (enabled on the main camera only) and the pins are DOM, so the
 * helicopter's off-screen camera never films them; suspend() also strips the building tints around a capture.
 */
import * as THREE from 'three';
import type {
  AppContext,
  BuildingComparison,
  BuildingsHandle,
  DamageState,
  LandmarksHandle,
  ObservedBuilding,
  ObservedCrowd,
  ObservedDamage,
  ObservedRoad,
  OverlayMode,
  PeopleTruth,
  QuakeResult,
  ReconHandle,
  ReconHistoryPoint,
  ReconObservation,
  ReconStats,
  ReconstructionResult,
  RoadRecord,
  ScanChunk,
  StructureType,
} from '../contracts';
import { OBSERVED_DAMAGE, setMockCity, truthState } from './mock';
import { createPins, type PinSpec } from './pins';
import { ruinShape } from '../quake/fx/rules';

export { createMockReconstruction, setMockCity, OBSERVED_DAMAGE } from './mock';

/** Render layer for recon markers (main camera only; helicopter camera keeps the default layer 0). */
export const RECON_LAYER = 2;
/** Fallback helicopter launch time (s after origin) when a chunk carries no frames. */
const AIR_LAUNCH_FALLBACK_S = 50;

/** Display (sRGB) tint per observed damage: none green → collapsed deep red. */
export const OBSERVED_RAMP: Record<ObservedDamage, [number, number, number]> = {
  none: [0.55, 0.75, 0.58],
  slight: [0.78, 0.8, 0.5],
  moderate: [0.9, 0.72, 0.42],
  extensive: [0.88, 0.48, 0.32],
  collapsed: [0.68, 0.18, 0.14],
};

/** HAZUS: fraction of complete-damage buildings that collapse, by model building type. */
const COLLAPSE_SHARE: Record<StructureType, number> = {
  W1: 0.03,
  W1_SOFT: 0.1,
  W2: 0.03,
  URM: 0.15,
  RM: 0.13,
  C1: 0.13,
  C2: 0.13,
  C3: 0.15,
  PC: 0.15,
  S1: 0.08,
  S2: 0.08,
  S5: 0.1,
};

export const obsState = (d: ObservedDamage): DamageState => OBSERVED_DAMAGE.indexOf(d) as DamageState;
/** HAZUS state (collapsed = 4) → xBD class: 0 no damage, 1 minor, 2 major (DS2–3), 3 destroyed. */
export const XBD = [0, 1, 2, 2, 3] as const;

type Observed = ReconObservation;
interface Entry {
  res: ReconstructionResult;
  chunk: ScanChunk;
  revealS: number;
  /** Unique per chunk: heli and drone chunks may reuse chunk indices. */
  key: string;
  source: 'heli' | 'drone';
}
const entryKey = (res: ReconstructionResult, chunk: ScanChunk) =>
  chunk.source === 'drone' ? `drone:${chunk.missionId ?? chunk.droneId ?? ''}:${res.chunkIndex}` : `heli:${res.chunkIndex}`;
/** Fusion: a drone close-up is trusted at least this much (Argon's own confidence otherwise). */
const DRONE_MIN_CONFIDENCE = 0.85;
interface Predicted {
  mostLikely: DamageState;
  pCollapse: number;
  probs: [number, number, number, number, number];
}

const normStreet = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\balley\b/g, 'aly')
    .replace(/\s+/g, ' ')
    .trim();

export function createRecon(ctx: AppContext, deps: { buildings: BuildingsHandle; landmarks: LandmarksHandle }): ReconHandle {
  const { city, terrain } = ctx;
  const { buildings } = deps;
  setMockCity(city);
  ctx.camera.layers.enable(RECON_LAYER);

  const object = new THREE.Group();
  object.name = 'argus-recon';
  const roadGroup = new THREE.Group();
  object.add(roadGroup);

  // ── Static lookups ──
  const idx = new Map<string, number>();
  const centre: [number, number][] = [];
  const groupOf = new Map<string, number[]>(); // anchor id → indices of anchor + parts
  city.buildings.forEach((b, i) => {
    idx.set(b.id, i);
    let cx = 0;
    let cz = 0;
    for (const [x, z] of b.footprint) {
      cx += x;
      cz += z;
    }
    const n = Math.max(1, b.footprint.length);
    centre.push([cx / n, cz / n]);
    const key = b.parentId ?? b.id;
    const g = groupOf.get(key);
    if (g) g.push(i);
    else groupOf.set(key, [i]);
  });
  const roadsByName = new Map<string, RoadRecord[]>();
  for (const r of city.roads) {
    if (!r.name) continue;
    const k = normStreet(r.name);
    const list = roadsByName.get(k);
    if (list) list.push(r);
    else roadsByName.set(k, [r]);
  }

  // ── Session state ──
  let result: QuakeResult | null = null;
  let people: PeopleTruth | null = null;
  let predCache: (Predicted | undefined)[] = [];
  const entries: Entry[] = [];
  const sent = new Set<number>();
  let simNow = Infinity;
  let visible = true;
  let suspended = false;
  let overlayMode: OverlayMode = 'none';

  // Effective (revealed) state, rebuilt when the revealed set changes.
  let revealKey = '';
  let effective = new Map<string, Observed>();
  let effRoads: (ObservedRoad & { chunkIndex: number })[] = [];
  let effCrowds: (ObservedCrowd & { chunkIndex: number })[] = [];
  let covered = new Set<string>();
  let revealed: Entry[] = [];
  let statsCache: ReconStats | null = null;
  let history: ReconHistoryPoint[] = [];
  const tinted = new Set<number>();

  const pins = createPins(ctx);

  function predicted(i: number): Predicted {
    const c = predCache[i];
    if (c) return c;
    const d = result!.damage[i];
    const [e1, e2, e3, e4] = d.predictedExceedance ?? d.exceedance;
    const probs: Predicted['probs'] = [1 - e1, e1 - e2, e2 - e3, e3 - e4, e4].map((p) => Math.max(0, p)) as Predicted['probs'];
    let mostLikely = 0 as DamageState;
    for (let s = 1; s < 5; s++) if (probs[s] > probs[mostLikely]) mostLikely = s as DamageState;
    const p: Predicted = { mostLikely, pCollapse: e4 * (COLLAPSE_SHARE[city.buildings[i].structure] ?? 0.1), probs };
    predCache[i] = p;
    return p;
  }

  function flightOf(chunk: ScanChunk, evidenceS: number): number {
    const fr = chunk.frames;
    if (fr.length) return fr[Math.max(0, Math.min(fr.length - 1, Math.round(evidenceS)))].flightS;
    return Math.min(chunk.endFlightS, chunk.startFlightS + Math.max(0, evidenceS));
  }

  function revealTime(chunk: ScanChunk): number {
    const fr = chunk.frames;
    return fr.length ? fr[fr.length - 1].simS : AIR_LAUNCH_FALLBACK_S + chunk.endFlightS;
  }

  // ── Rebuild effective state ──
  function rebuild(force = false) {
    const rev = entries.filter((e) => e.revealS <= simNow + 1e-6);
    const key = rev.map((e) => e.key).join(',');
    if (!force && key === revealKey) return;
    revealKey = key;
    revealed = rev;
    statsCache = null;
    effective = new Map();
    effRoads = [];
    effCrowds = [];
    covered = new Set();
    history = [];
    for (const e of rev) {
      for (const id of e.chunk.buildingIds) covered.add(id);
      for (const b of e.res.buildings) {
        if (!idx.has(b.id)) continue;
        covered.add(b.id);
        const prev = effective.get(b.id);
        // Drone close-ups outrank helicopter observations regardless of confidence; within the same source,
        // later chunks win unless clearly less confident.
        if (prev && prev.source === 'drone' && e.source === 'heli') continue;
        if (prev && prev.source === e.source && b.confidence < prev.confidence - 0.05) continue;
        effective.set(b.id, {
          ...b,
          chunkIndex: e.res.chunkIndex,
          flightS: flightOf(e.chunk, b.evidenceS),
          source: e.source,
          droneId: e.chunk.droneId,
          missionId: e.chunk.missionId,
          revealS: e.revealS,
        });
      }
      for (const r of e.res.roads) {
        const k = `${normStreet(r.street)}|${r.nearBuildingId ?? ''}`;
        effRoads = effRoads.filter((x) => `${normStreet(x.street)}|${x.nearBuildingId ?? ''}` !== k);
        effRoads.push({ ...r, chunkIndex: e.res.chunkIndex });
      }
      for (const c of e.res.crowds) {
        const k = c.place ?? c.nearBuildingId ?? '';
        effCrowds = effCrowds.filter((x) => (x.place ?? x.nearBuildingId ?? '') !== k || !k);
        effCrowds.push({ ...c, chunkIndex: e.res.chunkIndex });
      }
      // Accuracy timeline: one point per revealed result (recomputed from scratch ⇒ consistent on seek).
      if (result) history.push({ simS: e.revealS, source: e.source, ...metricsOf(effective) });
    }
    applyVisuals();
  }

  // ── Visuals ──
  function clearTints() {
    for (const i of tinted) buildings.setOverlayColor(i, null);
    tinted.clear();
  }

  function applyTints() {
    // FX owns the overlay texture while the ShakeMap overlay is on (damage overlay wins in the shader anyway).
    if (overlayMode === 'shakemap') {
      tinted.clear();
      return;
    }
    const want = new Map<number, [number, number, number]>();
    if (visible && !suspended) {
      for (const [id, o] of effective) {
        const rgb = OBSERVED_RAMP[o.damage];
        for (const i of groupOf.get(id) ?? [idx.get(id)!]) want.set(i, rgb);
      }
    }
    for (const i of tinted) if (!want.has(i)) buildings.setOverlayColor(i, null);
    tinted.clear();
    for (const [i, rgb] of want) {
      buildings.setOverlayColor(i, rgb);
      tinted.add(i);
    }
  }

  /** Pin anchor: live roof height of the (possibly ruined) building, from the same ruin shape the FX draws. */
  function roofY(i: number): number {
    const b = city.buildings[i];
    const d = result?.damage[i];
    let h = b.height;
    if (d?.collapsed) h = ruinShape(b.height, d.collapseFraction, 0).top; // shells cap at ~40 % H
    else if (d && d.state >= 4) h = b.height - 2.5; // complete but standing: roof broken in, ~2–3 m lower
    return b.baseElevation + Math.max(3, h) + 2;
  }

  function applyPins() {
    const specs: PinSpec[] = [];
    if (visible) {
      for (const [id, o] of effective) {
        const collapsed = o.damage === 'collapsed';
        if (!collapsed && !o.fire && o.peopleVisible <= 0 && !o.trappedSigns) continue;
        const i = idx.get(id)!;
        const parts: string[] = [];
        // Collapse-only pins stay icon-only (less clutter); text once people / fire are involved.
        if (collapsed && (o.peopleVisible > 0 || o.trappedSigns || o.fire)) parts.push('Collapsed');
        if (o.peopleVisible > 0) parts.push(`${o.peopleVisible} ${o.peopleVisible === 1 ? 'person' : 'people'}${o.trappedSigns ? ' · trapped' : ''}`);
        else if (o.trappedSigns) parts.push('Trapped signs');
        if (o.fire) parts.push('Fire');
        const kind: PinSpec['kind'] = o.trappedSigns || (collapsed && o.peopleVisible > 0) ? 'trapped' : collapsed ? 'collapse' : o.fire ? 'fire' : 'people';
        const priority = (o.trappedSigns ? 4 : 0) + (collapsed ? 3 : 0) + (o.fire ? 2 : 0) + Math.min(2, o.peopleVisible / 5);
        specs.push({ key: id, kind, text: parts.join(' · '), x: centre[i][0], y: roofY(i), z: centre[i][1], priority, buildingId: id });
      }
      for (const c of effCrowds) {
        let x: number | undefined;
        let z: number | undefined;
        const tc = people?.crowds.find((t) => t.name && c.place && t.name === c.place);
        if (tc) {
          x = tc.x;
          z = tc.z;
        } else if (c.nearBuildingId && idx.has(c.nearBuildingId)) {
          [x, z] = centre[idx.get(c.nearBuildingId)!];
        }
        if (x === undefined || z === undefined) continue;
        specs.push({
          key: `crowd:${c.place ?? c.nearBuildingId}`,
          kind: 'crowd',
          text: `≈${c.approxCount.toLocaleString('en-US')} people${c.place ? ` · ${c.place}` : ''}`,
          x,
          y: terrain.heightAt(x, z) + 6,
          z,
          priority: 1 + Math.min(2, c.approxCount / 200),
        });
      }
    }
    pins.set(specs);
  }

  const dashGeo = new THREE.BoxGeometry(6, 0.5, 2.4);
  const matBlocked = new THREE.MeshBasicMaterial({ color: new THREE.Color('#e3261c'), toneMapped: false, fog: false });
  const matPartial = new THREE.MeshBasicMaterial({ color: new THREE.Color('#f0a020'), toneMapped: false, fog: false });

  function applyRoads() {
    roadGroup.clear();
    if (!visible) return;
    for (const r of effRoads) {
      if (r.status === 'clear' || !r.nearBuildingId) continue;
      const bi = idx.get(r.nearBuildingId);
      const cands = roadsByName.get(normStreet(r.street));
      if (bi === undefined || !cands) continue;
      const [px, pz] = centre[bi];
      let best = Infinity;
      let bx = 0;
      let bz = 0;
      let ang = 0;
      for (const rd of cands) {
        for (let k = 0; k + 1 < rd.points.length; k++) {
          const [ax, az] = rd.points[k];
          const [cx, cz] = rd.points[k + 1];
          const dx = cx - ax;
          const dz = cz - az;
          const L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
          const qx = ax + dx * t;
          const qz = az + dz * t;
          const d = Math.hypot(px - qx, pz - qz);
          if (d < best) {
            best = d;
            bx = qx;
            bz = qz;
            ang = Math.atan2(dz, dx);
          }
        }
      }
      if (best > 90) continue;
      const mat = r.status === 'blocked' ? matBlocked : matPartial;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      for (let k = -1; k <= 1; k++) {
        const x = bx + ux * k * 9;
        const z = bz + uz * k * 9;
        const m = new THREE.Mesh(dashGeo, mat);
        m.position.set(x, terrain.heightAt(x, z) + 0.6, z);
        m.rotation.y = -ang;
        m.layers.set(RECON_LAYER);
        m.renderOrder = 2;
        roadGroup.add(m);
      }
    }
  }

  function applyVisuals() {
    applyTints();
    applyPins();
    applyRoads();
  }

  ctx.events.on('overlay-changed', ({ overlay }) => {
    overlayMode = overlay;
    // FX clears every overlay colour when leaving the ShakeMap; re-apply ours afterwards.
    tinted.clear();
    applyTints();
  });

  // ── Stats ──
  /** Model's xBD class: argmax over class-aggregated HAZUS probabilities (major = DS2 + DS3). */
  function xbdPredicted(i: number): number {
    const q = predicted(i).probs;
    const c = [q[0], q[1], q[2] + q[3], q[4]];
    let best = 0;
    for (let k = 1; k < 4; k++) if (c[k] > c[best]) best = k;
    return best;
  }

  /** Model corrected by Argon: xBD prior (model) × likelihood of Argon's call given its confidence → argmax. */
  function xbdFused(i: number, o: ObservedBuilding & { source?: 'heli' | 'drone' }): number {
    const q = predicted(i).probs;
    const prior = [q[0], q[1], q[2] + q[3], q[4]].map((v) => Math.max(v, 1e-4));
    const ox = XBD[obsState(o.damage)];
    const conf = o.source === 'drone' ? Math.max(o.confidence, DRONE_MIN_CONFIDENCE) : o.confidence;
    const c = Math.min(0.95, Math.max(0.3, conf));
    let best = 0;
    let bestP = -1;
    for (let t = 0; t < 4; t++) {
      const like = t === ox ? c : ((1 - c) / 3) * (Math.abs(t - ox) === 1 ? 1.5 : 0.75);
      const post = prior[t] * like;
      if (post > bestP) (bestP = post), (best = t);
    }
    return best;
  }

  /** Macro-F1 and balanced accuracy of a 4×4 confusion matrix (rows = truth, cols = estimate). */
  function classMetrics(m: number[][]): { f1: number; bal: number } {
    let f1 = 0;
    let bal = 0;
    let classes = 0;
    for (let c = 0; c < 4; c++) {
      const row = m[c].reduce((a, b) => a + b, 0);
      if (!row) continue; // class absent from truth among observed buildings
      classes++;
      const tp = m[c][c];
      const col = m.reduce((a, r) => a + r[c], 0);
      const rec = tp / row;
      const pre = col ? tp / col : 0;
      bal += rec;
      f1 += rec + pre ? (2 * rec * pre) / (rec + pre) : 0;
    }
    return { f1: classes ? f1 / classes : 0, bal: classes ? bal / classes : 0 };
  }

  /** Timeline metrics over an effective observation map (truth used for the audience chart only). */
  function metricsOf(eff: Map<string, Observed>): Omit<ReconHistoryPoint, 'simS' | 'source'> {
    const cmP = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const cmR = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const cmF = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    let fx = 0;
    let collapses = 0;
    let ppl = 0;
    for (const [id, o] of eff) {
      const i = idx.get(id)!;
      const tx = XBD[truthState(result!, i)];
      const ob = obsState(o.damage);
      const fxc = xbdFused(i, o);
      cmP[tx][xbdPredicted(i)]++;
      cmR[tx][XBD[ob]]++;
      cmF[tx][fxc]++;
      if (fxc === tx) fx++;
      if (ob === 4) collapses++;
      ppl += o.peopleVisible;
    }
    return {
      observed: eff.size,
      predictionF1: classMetrics(cmP).f1,
      reconF1: classMetrics(cmR).f1,
      fusedF1: classMetrics(cmF).f1,
      fusedXbd: eff.size ? fx / eff.size : 0,
      collapsesConfirmed: collapses,
      peopleSeen: ppl,
    };
  }

  function computeStats(): ReconStats {
    const s: ReconStats = {
      chunksSent: Math.max(sent.size, entries.length),
      chunksDone: entries.length,
      buildingsObserved: effective.size,
      predictionAccuracy: 0,
      reconAccuracy: 0,
      predictionWithinOne: 0,
      reconWithinOne: 0,
      collapsesTruth: 0,
      collapsesPredicted: 0,
      collapsesObserved: 0,
      peopleTruthVisible: 0,
      peopleObserved: 0,
      crowdsObserved: effCrowds.length,
      surprises: [],
      lastSummary: '',
      model: entries.length ? entries[entries.length - 1].res.model : 'gemini-4-argon',
      mode: entries.length ? entries[entries.length - 1].res.mode : null,
      buildingsCovered: covered.size,
      history: history.slice(),
      droneObserved: [...effective.values()].filter((o) => o.source === 'drone').length,
    };
    const lastRev = revealed[revealed.length - 1];
    s.lastSummary = lastRev?.res.summary ?? '';
    if (entries.length) s.avgLatencyS = entries.reduce((a, e) => a + e.res.latencyMs, 0) / entries.length / 1000;
    if (!result) return s;
    let pe = 0;
    let re = 0;
    let px = 0;
    let rx = 0;
    let p1 = 0;
    let r1 = 0;
    let expCollapse = 0;
    let fx = 0;
    const cmP = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const cmR = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const cmF = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const surprises: (ReconStats['surprises'][number] & { w: number })[] = [];
    for (const [id, o] of effective) {
      const i = idx.get(id)!;
      const t = truthState(result, i);
      const p = predicted(i).mostLikely;
      const ob = obsState(o.damage);
      if (p === t) pe++;
      if (ob === t) re++;
      const tx = XBD[t];
      const pxc = xbdPredicted(i);
      const fxc = xbdFused(i, o);
      if (pxc === tx) px++;
      if (XBD[ob] === tx) rx++;
      if (fxc === tx) fx++;
      cmP[tx][pxc]++;
      cmR[tx][XBD[ob]]++;
      cmF[tx][fxc]++;
      if (Math.abs(p - t) <= 1) p1++;
      if (Math.abs(ob - t) <= 1) r1++;
      if (ob === 4) s.collapsesObserved++;
      s.peopleObserved += o.peopleVisible;
      if (ob !== p && ob === t) surprises.push({ id, predicted: p, observed: o.damage, truth: t, w: Math.abs(ob - p) * 10 + o.confidence + (ob === 4 ? 5 : 0) });
    }
    for (const id of covered) {
      const i = idx.get(id);
      if (i === undefined) continue;
      // Counted like the accuracy metric: complete damage (HAZUS DS4, incl. collapse) ⇔ observed 'collapsed'.
      if (truthState(result, i) === 4) s.collapsesTruth++;
      expCollapse += predicted(i).probs[4];
      s.peopleTruthVisible += people?.byBuilding[id]?.visible ?? 0;
    }
    const n = Math.max(1, effective.size);
    s.predictionXbd = effective.size ? px / n : 0;
    s.reconXbd = effective.size ? rx / n : 0;
    s.fusedXbd = effective.size ? fx / n : 0;
    const mP = classMetrics(cmP);
    const mR = classMetrics(cmR);
    const mF = classMetrics(cmF);
    s.predictionF1 = mP.f1;
    s.reconF1 = mR.f1;
    s.fusedF1 = mF.f1;
    s.predictionBal = mP.bal;
    s.reconBal = mR.bal;
    s.fusedBal = mF.bal;
    s.predictionAccuracy = effective.size ? pe / n : 0;
    s.reconAccuracy = effective.size ? re / n : 0;
    s.predictionWithinOne = effective.size ? p1 / n : 0;
    s.reconWithinOne = effective.size ? r1 / n : 0;
    s.collapsesPredicted = Math.round(expCollapse);
    surprises.sort((a, b) => b.w - a.w);
    s.surprises = surprises.slice(0, 8).map(({ id, predicted, observed, truth }) => ({ id, predicted, observed, truth }));
    return s;
  }

  const handle: ReconHandle & { results: ReconstructionResult[]; debug: unknown } = {
    object,
    get results() {
      return entries.map((e) => e.res);
    },
    debug: { entries, get effective() { return effective; }, pins },
    begin(r, p) {
      handle.reset();
      result = r;
      people = p;
      predCache = new Array(r.damage.length);
    },
    apply(res, chunk) {
      const key = entryKey(res, chunk);
      const at = entries.findIndex((e) => e.key === key);
      const entry: Entry = { res, chunk, revealS: revealTime(chunk), key, source: chunk.source === 'drone' ? 'drone' : 'heli' };
      if (at >= 0) entries[at] = entry;
      else entries.push(entry);
      // Reveal order (heli chunk order == time order; drone chunks interleave by their last frame's simS).
      entries.sort((a, b) => a.revealS - b.revealS || (a.source === b.source ? a.res.chunkIndex - b.res.chunkIndex : a.source === 'heli' ? -1 : 1));
      sent.add(res.chunkIndex);
      rebuild(true);
    },
    setVisible(on) {
      if (visible === on) return;
      visible = on;
      applyVisuals();
    },
    stats() {
      if (!statsCache) statsCache = computeStats();
      return statsCache;
    },
    observations() {
      return effective;
    },
    observedRoads() {
      return effRoads;
    },
    observedCrowds() {
      return effCrowds;
    },
    compare(id) {
      if (!result) return null;
      let oid = id;
      let o = effective.get(id);
      if (!o) {
        const anchor = city.buildings[idx.get(id) ?? -1]?.parentId;
        if (anchor && effective.has(anchor)) {
          oid = anchor;
          o = effective.get(anchor);
        }
      }
      if (!o) return null;
      const i = idx.get(oid)!;
      const d = result.damage[i];
      const pb = people?.byBuilding[oid];
      const c: BuildingComparison = {
        id: oid,
        predicted: predicted(i),
        observed: o,
        truth: { state: truthState(result, i), collapsed: d.collapsed, trappedVisible: pb?.visible ?? 0, trappedHidden: pb?.hidden ?? 0 },
      };
      return c;
    },
    reset() {
      entries.length = 0;
      sent.clear();
      result = null;
      people = null;
      predCache = [];
      simNow = Infinity;
      revealKey = '';
      revealed = [];
      effective = new Map();
      effRoads = [];
      effCrowds = [];
      covered = new Set();
      history = [];
      statsCache = null;
      clearTints();
      pins.set([]);
      roadGroup.clear();
    },
    update(simSeconds) {
      simNow = simSeconds;
      rebuild();
    },
    markSent(chunkIndex) {
      if (sent.has(chunkIndex)) return;
      sent.add(chunkIndex);
      statsCache = null;
    },
    suspend(on) {
      if (suspended === on) return;
      suspended = on;
      applyTints();
      roadGroup.visible = !on;
      pins.setSuspended(on);
      buildings.commit();
    },
  };
  return handle;
}
