/**
 * M4 Argon drone planner — client side: builds the PlanRequest sent to POST /api/plan (gemini-4-argon decides).
 *
 * Argon must reason over UNCERTAINTY, never over truth: candidates use only the model's BLIND prediction
 * (damage.predictedExceedance ?? exceedance), helicopter coverage (scanned / not) and Argon's own revealed
 * observations. damage.state / collapsed / people truth are never read here.
 *
 * Candidate categories (one candidate per building or cluster; a building matching several keeps the best
 * score + 25 % of the others, reasons joined):
 *   unscanned       core building AIR 1 has not covered, high model risk × occupants. Neighbours within
 *                   CLUSTER_M are merged into one area candidate ("A-<n>", up to 4 buildings).
 *   unassessed      covered by AIR 1 but Argon could not judge it (occluded / smoke / too small): same as
 *                   unscanned with weight 0.5.
 *   low_confidence  observed extensive/collapsed with confidence < 0.7, or people / trapped signs seen.
 *   disagreement    |xBD(observed) − xBD(model most-likely)| ≥ 2.
 *   fire            observed fire with occupied buildings within FIRE_RADIUS_M.
 * Buildings already observed by a drone are excluded.
 *
 * Score (higher = more life-saving information per drone-minute), with
 *   occ = occupants at the local hour, pD = P(DS4) predicted, pM = P(≥DS2) predicted,
 *   lifeRisk = occ × (pD + 0.05 (pM − pD))            (≈ occupants exposed to collapse; major damage rarely traps)
 *   distF = 1 − 0.15 · min(1, distanceFromBase / 1500) (mild transit-cost penalty)
 *   unscanned     10 · ln(1 + Σ lifeRisk) · (0.5 + max pD) · distF   (unassessed × 0.5; pool: pD ≥ 4 % or pM ≥ 30 %)
 *   low_conf      10 · ln(1 + occ · sev) · (0.4 + max(0.15, 1 − conf)) · (1 + 1.0·trapped + 0.5·[people>0]) · distF
 *                 sev = 1 collapsed, 0.6 extensive, 0.3 otherwise
 *   disagreement  10 · ln(1 + occ · max(pD, sev)) · (0.5 + max(0.15, 1 − conf)) · 0.9 · distF
 *   fire          6 · ln(1 + Σ occupants within 80 m) · distF
 */
import type {
  BuildingRecord,
  CityData,
  DamageState,
  DroneId,
  ObservedDamage,
  PlanCandidate,
  PlanRequest,
  QuakeResult,
  ReconHandle,
  ReconObservation,
} from '../contracts';
import { occupantsAt } from '../quake/model/damage';

export const PLAN_STAGING_BASE: [number, number] = [203, -200]; // Embarcadero Plaza
export const DEFAULT_DRONE: PlanRequest['drone'] = { speedMs: 15, altitudeAGL: 70, orbitS: 18, base: PLAN_STAGING_BASE, enduranceS: 600 };

const CLUSTER_M = 60;
const FIRE_RADIUS_M = 80;
const MAX_CANDIDATES = 36;
const MAX_AREA = 22;
const DAMAGES: ObservedDamage[] = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];
const XBD = [0, 1, 2, 2, 3] as const;

const DISTRICT_NAME: Record<string, string> = {
  chinatown: 'Chinatown',
  fidi: 'FiDi',
  embarcadero: 'Embarcadero',
  jackson_square: 'Jackson Square',
  nob_hill: 'Nob Hill',
  north_beach: 'North Beach',
  soma: 'SoMa',
  other: 'Downtown',
};
const STRUCT_NAME: Record<string, string> = {
  W1: 'wood-frame',
  W1_SOFT: 'soft-story',
  W2: 'wood-frame',
  URM: 'URM',
  RM: 'masonry',
  C1: 'concrete',
  C2: 'concrete',
  C3: 'URM-infill',
  PC: 'precast',
  S1: 'steel',
  S2: 'steel',
  S5: 'URM-infill',
};

export interface BuildPlanArgs {
  city: CityData;
  result: QuakeResult;
  recon: ReconHandle;
  /** Building index (city.buildings order) → covered by AIR 1's camera so far (ScanHandle.isScanned). */
  scanned: (index: number) => boolean;
  scannedFraction: number;
  heliStatus: string;
  chunksDone: number;
  chunksTotal: number;
  simS: number;
  wave: 1 | 2;
  dronesAvailable: DroneId[];
  drone?: PlanRequest['drone'];
  previousPlans?: PlanRequest['previousPlans'];
  mode?: PlanRequest['mode'];
}

/** "318;320 Kearny Street" → "318 Kearny St". */
function shortAddr(a: string): string {
  let s = a.trim();
  const m = s.match(/^([0-9][0-9A-Za-z-]*)(?:\s*[;,]\s*[0-9A-Za-z-]+)*\s+(.*)$/);
  if (m) s = `${m[1]} ${m[2]}`;
  return s
    .replace(/\bStreet\b/i, 'St')
    .replace(/\bAvenue\b/i, 'Ave')
    .replace(/\bBoulevard\b/i, 'Blvd')
    .replace(/\bPlace\b/i, 'Pl')
    .replace(/\bAlley\b/i, 'Aly');
}

export function buildingName(b: BuildingRecord): string {
  return b.name ?? (b.address ? shortAddr(b.address) : `${b.levels}-storey ${b.use}`);
}
export const buildingLabelOf = (b: BuildingRecord) => `${buildingName(b)} (${b.id})`;

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

interface Cand extends PlanCandidate {
  /** Building ids covered (for merging categories). */
  ids: string[];
  extra: number; // sum of secondary-category scores
  reasons: string[];
}

export function buildPlanRequest(args: BuildPlanArgs): PlanRequest {
  const { city, result, recon } = args;
  const drone = args.drone ?? DEFAULT_DRONE;
  const hour = result.scenario.localHour;
  const [bx, bz] = drone.base;
  const obs: ReadonlyMap<string, ReconObservation> = recon.observations?.() ?? new Map();

  // ── Per-building blind-prediction features ──
  const idx = new Map<string, number>();
  city.buildings.forEach((b, i) => idx.set(b.id, i));
  const centre = (b: BuildingRecord): [number, number] => {
    let x = 0;
    let z = 0;
    for (const p of b.footprint) {
      x += p[0];
      z += p[1];
    }
    const n = Math.max(1, b.footprint.length);
    return [x / n, z / n];
  };
  const pred = (i: number) => {
    const d = result.damage[i];
    const [e1, e2, e3, e4] = d.predictedExceedance ?? d.exceedance; // BLIND prediction (never d.state)
    const probs = [1 - e1, e1 - e2, e2 - e3, e3 - e4, e4].map((p) => Math.max(0, p));
    let ml = 0;
    for (let s = 1; s < 5; s++) if (probs[s] > probs[ml]) ml = s;
    const xc = [probs[0], probs[1], probs[2] + probs[3], probs[4]];
    let xb = 0;
    for (let k = 1; k < 4; k++) if (xc[k] > xc[xb]) xb = k;
    return { mostLikely: ml as DamageState, pMajorPlus: round(e2), pDestroyed: round(e4), xbd: xb };
  };
  const distF = (x: number, z: number) => 1 - 0.15 * Math.min(1, Math.hypot(x - bx, z - bz) / 1500);
  const dist = (x: number, z: number) => Math.round(Math.hypot(x - bx, z - bz));

  const core: { b: BuildingRecord; i: number; x: number; z: number; occ: number; p: ReturnType<typeof pred>; lifeRisk: number }[] = [];
  city.buildings.forEach((b, i) => {
    if (b.isPart || b.context || b.overWater) return;
    const [x, z] = centre(b);
    const occ = Math.round(occupantsAt(b, hour));
    const p = pred(i);
    const lifeRisk = occ * (p.pDestroyed + 0.05 * Math.max(0, p.pMajorPlus - p.pDestroyed));
    core.push({ b, i, x, z, occ, p, lifeRisk });
  });
  const byId = new Map(core.map((c) => [c.b.id, c]));
  const droneSeen = (id: string) => obs.get(id)?.source === 'drone';

  const cands = new Map<string, Cand>(); // keyed by candidate id
  const byBuilding = new Map<string, Cand>(); // building id → candidate holding it
  const add = (c: Cand) => {
    // Merge with an existing candidate holding the same (single) building.
    const prev = c.ids.length === 1 ? byBuilding.get(c.ids[0]) : undefined;
    if (prev) {
      if (c.score > prev.score) {
        prev.extra += prev.score;
        prev.score = c.score;
        prev.kind = c.kind;
        prev.reasons.unshift(...c.reasons);
      } else {
        prev.extra += c.score;
        prev.reasons.push(...c.reasons);
      }
      prev.peopleSeen ??= c.peopleSeen;
      prev.fire ||= c.fire;
      return;
    }
    cands.set(c.id, c);
    for (const id of c.ids) byBuilding.set(id, c);
  };
  const single = (e: (typeof core)[number], kind: PlanCandidate['kind'], score: number, reason: string): Cand => {
    const o = obs.get(e.b.id);
    return {
      id: e.b.id,
      buildingId: e.b.id,
      kind,
      label: buildingLabelOf(e.b),
      x: Math.round(e.x),
      z: Math.round(e.z),
      scanned: args.scanned(e.i),
      observed: o?.damage,
      observedConfidence: o ? round(o.confidence) : undefined,
      predicted: { mostLikely: e.p.mostLikely, pMajorPlus: e.p.pMajorPlus, pDestroyed: e.p.pDestroyed },
      occupants: e.occ,
      peopleSeen: o && (o.peopleVisible > 0 || o.trappedSigns) ? o.peopleVisible : undefined,
      fire: o?.fire || undefined,
      reason,
      score: round(score, 1),
      distanceFromBaseM: dist(e.x, e.z),
      ids: [e.b.id],
      extra: 0,
      reasons: [reason],
    };
  };

  // ── (b) low-confidence severe / people seen, (c) disagreement, (d) fire — observed buildings ──
  const observedC: Cand[] = [];
  for (const [id, o] of obs) {
    const e = byId.get(id);
    if (!e || o.source === 'drone') continue;
    const sev = o.damage === 'collapsed' ? 1 : o.damage === 'extensive' ? 0.6 : 0.3;
    const u = Math.max(0.15, 1 - o.confidence);
    const severe = o.damage === 'collapsed' || o.damage === 'extensive';
    const people = o.peopleVisible > 0 || o.trappedSigns;
    if ((severe && o.confidence < 0.7) || people) {
      const s = 10 * Math.log1p(Math.max(1, e.occ) * sev) * (0.4 + u) * (1 + (o.trappedSigns ? 1 : 0) + (o.peopleVisible > 0 ? 0.5 : 0)) * distF(e.x, e.z);
      const why = [
        severe && o.confidence < 0.7 ? `low-confidence ${o.damage} call (${Math.round(o.confidence * 100)}%)` : `${o.damage} (${Math.round(o.confidence * 100)}%)`,
        o.trappedSigns ? 'trapped signs seen' : o.peopleVisible > 0 ? `${o.peopleVisible} people seen` : '',
      ]
        .filter(Boolean)
        .join(', ');
      observedC.push(single(e, 'low_confidence', s, why));
    }
    const ox = XBD[DAMAGES.indexOf(o.damage)];
    if (Math.abs(ox - e.p.xbd) >= 2) {
      const s = 10 * Math.log1p(Math.max(1, e.occ) * Math.max(e.p.pDestroyed, sev)) * (0.5 + u) * 0.9 * distF(e.x, e.z);
      observedC.push(single(e, 'disagreement', s, `model predicts ${['no', 'minor', 'major', 'destroyed'][e.p.xbd]} damage, AIR 1 saw ${o.damage}`));
    }
    if (o.fire) {
      let near = 0;
      for (const n of core) if (n.b.id !== id && Math.hypot(n.x - e.x, n.z - e.z) < FIRE_RADIUS_M) near += n.occ;
      if (near + e.occ > 0) observedC.push(single(e, 'fire', 6 * Math.log1p(near + e.occ) * distF(e.x, e.z), `fire, ~${near + e.occ} occupants within ${FIRE_RADIUS_M} m`));
    }
  }

  // ── (a) unscanned / unassessed high-risk buildings, clustered ──
  const pool = core
    .filter((e) => !obs.has(e.b.id) && e.lifeRisk >= 0.5 && (e.p.pDestroyed >= 0.04 || e.p.pMajorPlus >= 0.3))
    .sort((a, b) => b.lifeRisk - a.lifeRisk);
  const used = new Set<string>();
  const areaC: Cand[] = [];
  let areaN = 0;
  for (const seed of pool) {
    if (areaC.length >= MAX_AREA * 2) break;
    if (used.has(seed.b.id)) continue;
    const scannedSeed = args.scanned(seed.i);
    const members = [seed];
    used.add(seed.b.id);
    for (const n of pool) {
      if (members.length >= 4) break;
      if (used.has(n.b.id) || args.scanned(n.i) !== scannedSeed) continue;
      if (Math.hypot(n.x - seed.x, n.z - seed.z) <= CLUSTER_M) {
        members.push(n);
        used.add(n.b.id);
      }
    }
    const risk = members.reduce((a, m) => a + m.lifeRisk, 0);
    const cx = members.reduce((a, m) => a + m.x, 0) / members.length;
    const cz = members.reduce((a, m) => a + m.z, 0) / members.length;
    const w = scannedSeed ? 0.5 : 1;
    const occ = members.reduce((a, m) => a + m.occ, 0);
    const pD = Math.max(...members.map((m) => m.p.pDestroyed));
    const score = 10 * Math.log1p(risk) * (0.5 + pD) * w * distF(cx, cz);
    const reason = scannedSeed
      ? `seen by AIR 1 but not assessable; model P(destroyed) up to ${Math.round(pD * 100)}%, ~${occ} occupants`
      : `not yet scanned; model P(destroyed) up to ${Math.round(pD * 100)}%, ~${occ} occupants`;
    if (members.length === 1) {
      areaC.push(single(seed, scannedSeed ? 'unassessed' : 'unscanned', score, reason));
      continue;
    }
    // Dominant structure + district name the block.
    const counts = new Map<string, number>();
    for (const m of members) counts.set(STRUCT_NAME[m.b.structure] ?? m.b.structure, (counts.get(STRUCT_NAME[m.b.structure] ?? m.b.structure) ?? 0) + 1);
    const struct = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const district = DISTRICT_NAME[seed.b.district] ?? 'Downtown';
    const lead = buildingName(seed.b);
    const best = members.reduce((a, m) => (m.p.pDestroyed > a.p.pDestroyed ? m : a), seed);
    areaC.push({
      id: `A-${++areaN}`,
      buildingIds: members.map((m) => m.b.id),
      kind: scannedSeed ? 'unassessed' : 'unscanned',
      label: `${district} ${struct} block at ${lead} (${members.length} bldgs: ${members.map((m) => m.b.id).join(', ')})`,
      x: Math.round(cx),
      z: Math.round(cz),
      scanned: scannedSeed,
      predicted: { mostLikely: best.p.mostLikely, pMajorPlus: round(Math.max(...members.map((m) => m.p.pMajorPlus))), pDestroyed: round(pD) },
      occupants: occ,
      reason,
      score: round(score, 1),
      distanceFromBaseM: dist(cx, cz),
      ids: members.map((m) => m.b.id),
      extra: 0,
      reasons: [reason],
    });
  }

  areaC.sort((a, b) => b.score - a.score);
  observedC.sort((a, b) => b.score - a.score);
  for (const c of observedC) if (!c.ids.some(droneSeen)) add(c);
  for (const c of areaC.slice(0, MAX_AREA)) if (!c.ids.some(droneSeen)) add(c);

  const candidates: PlanCandidate[] = [...cands.values()]
    .map((c) => {
      c.score = round(c.score + 0.25 * c.extra, 1);
      c.reason = [...new Set(c.reasons)].join('; ');
      return c;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map(({ ids, extra, reasons, ...pc }) => pc);

  // ── Situation (observations only) ──
  const label = (id: string) => {
    const i = idx.get(id);
    return i === undefined ? id : buildingLabelOf(city.buildings[i]);
  };
  const collapses = [...obs.values()].filter((o) => o.damage === 'collapsed').sort((a, b) => b.confidence - a.confidence);
  const fires = [...obs.values()].filter((o) => o.fire).map((o) => label(o.id));
  const roads = recon.observedRoads?.() ?? [];
  const crowds = recon.observedCrowds?.() ?? [];
  const stats = recon.stats();

  return {
    scenarioId: result.scenario.id,
    localHour: hour,
    simS: Math.round(args.simS),
    wave: args.wave,
    dronesAvailable: args.dronesAvailable,
    drone,
    coverage: {
      scannedFraction: round(args.scannedFraction),
      heliStatus: args.heliStatus,
      chunksDone: args.chunksDone,
      chunksTotal: args.chunksTotal,
    },
    situation: {
      collapsesObserved: collapses.slice(0, 15).map((o) => ({ id: o.id, label: label(o.id), confidence: round(o.confidence) })),
      peopleSeen: [...obs.values()].reduce((a, o) => a + o.peopleVisible, 0),
      crowds: crowds.slice(0, 8).map((c) => ({ place: c.place ?? (c.nearBuildingId ? `near ${label(c.nearBuildingId)}` : 'open space'), approxCount: c.approxCount })),
      fires: fires.slice(0, 10),
      blockedRoads: roads
        .filter((r) => r.status !== 'clear')
        .slice(0, 12)
        .map((r) => `${r.street} ${r.status}${r.nearBuildingId ? ` near ${label(r.nearBuildingId)}` : ''}`),
      latestSummary: stats.lastSummary,
    },
    candidates,
    previousPlans: args.previousPlans,
    mode: args.mode,
  };
}

/** Candidate id(s) → building ids (area candidates expand to their buildings; unknown ids dropped). Shared with planMock. */
export function expandCandidateTargets(req: PlanRequest, targetIds: string[], max = 4): string[] {
  const out: string[] = [];
  for (const t of targetIds) {
    const c = req.candidates.find((k) => k.id === t) ?? req.candidates.find((k) => k.buildingIds?.includes(t));
    if (!c) continue;
    const ids = c.buildingIds?.includes(t) ? [t] : c.buildingIds ?? (c.buildingId ? [c.buildingId] : []);
    for (const id of ids) if (!out.includes(id) && out.length < max) out.push(id);
  }
  return out;
}
