/**
 * M5 situation builder — packages what the commander's copilot (gemini-4-argon) may know: Argon-verified
 * incidents (helicopter / drone observations), unverified model risk (BLIND prediction only), verified and
 * likely road blockages, real facilities and road-network ETAs.
 *
 * NEVER reads truth: damage.state / collapsed / debrisRadius / result.roads (debris from the truth world) and
 * the people truth are not touched. Model inputs are damage.predictedExceedance and database occupancy.
 *
 * Incidents (≤ MAX_INCIDENTS):
 *   verified   trapped   — trapped signs, or extensive/collapsed with people visible
 *              collapse  — observed collapsed, no people seen
 *              fire      — observed fire (not already trapped/collapse; those carry fire=true)
 *              crowd     — ObservedCrowd located by nearBuildingId or a place-name match
 *   unverified suspected_collapse — buildings Argon has not assessed, ranked by occupants × P(destroyed)
 * Roads:
 *   verified_blocked / partial (argon)  — ObservedRoad matched to the nearest same-name segment near nearBuildingId
 *   likely_blocked (argon)              — street segments a verified collapse would bury (expected debris reach)
 *   likely_blocked (model)              — same, for unassessed buildings with predicted P(destroyed) ≥ 0.3
 *                                         (skipped where Argon reported the street clear)
 */
import type {
  BuildingRecord,
  CityData,
  CopilotSituation,
  Facility,
  Heightfield,
  ObservedCrowd,
  ObservedRoad,
  QuakeResult,
  ReconHandle,
  ReconObservation,
  RescueIncident,
  RoadStatus,
  RouterHandle,
  StructureType,
} from '../contracts';
import { occupantsAt } from '../quake/model/damage';
import { buildingLabelOf } from '../argus/planner';
import { FACILITIES } from './facilities';
import { createRouter, ROAD_SPEED_KMH } from './router';

export interface BuildSituationArgs {
  city: CityData;
  result: QuakeResult;
  recon: ReconHandle;
  scenarioId?: string;
  simS: number;
  /** Local hour at origin time (defaults to result.scenario.localHour). */
  localHour?: number;
  facilities?: Facility[];
  router: RouterHandle;
  /** Fraction of the core area covered by AIR 1 (ScanHandle.scannedFraction()). */
  scannedFraction: number;
  /** Optional: building index → covered by AIR 1's camera (ScanHandle.isScanned) for evidence labels. */
  scanned?: (index: number) => boolean;
}

const MAX_INCIDENTS = 30;
const MAX_VERIFIED = 20;
const MAX_CROWDS = 4;
const MAX_SUSPECTED = 8;
const MAX_LIKELY_ROADS = 40;
const SUSPECT_MIN_PD = 0.15;
const LIKELY_MIN_PD = 0.3;
const DEDUP_M = 35;

/** Debris reach of a collapse as a fraction of height (blind expectation, mid-range of the model's ranges). */
const DEBRIS_H: Partial<Record<StructureType, number>> = {
  URM: 0.5,
  RM: 0.45,
  C3: 0.45,
  S5: 0.45,
  C1: 0.4,
  C2: 0.4,
  PC: 0.4,
  W1: 0.35,
  W1_SOFT: 0.35,
  W2: 0.35,
  S1: 0.22,
  S2: 0.22,
};

export const normStreet = (s: string) =>
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

interface CityIndex {
  idx: Map<string, number>;
  centre: [number, number][];
  /** Vehicle road segments: road index, seg index, endpoints, half width. */
  segs: { road: number; seg: number; ax: number; az: number; bx: number; bz: number; hw: number; name: string }[];
  grid: Map<number, number[]>;
  byName: Map<string, number[]>; // normalized street name → seg indices
}
const CELL = 40;
const gkey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
const cache = new WeakMap<CityData, CityIndex>();

function cityIndex(city: CityData): CityIndex {
  const hit = cache.get(city);
  if (hit) return hit;
  const idx = new Map<string, number>();
  const centre: [number, number][] = city.buildings.map((b, i) => {
    idx.set(b.id, i);
    let x = 0;
    let z = 0;
    for (const p of b.footprint) {
      x += p[0];
      z += p[1];
    }
    const n = Math.max(1, b.footprint.length);
    return [x / n, z / n];
  });
  const segs: CityIndex['segs'] = [];
  const grid = new Map<number, number[]>();
  const byName = new Map<string, number[]>();
  city.roads.forEach((r, ri) => {
    if (!ROAD_SPEED_KMH[r.kind] || r.tunnel || (r.layer ?? 0) > 0 || r.bridge) return;
    const name = r.name ? normStreet(r.name) : '';
    for (let k = 0; k + 1 < r.points.length; k++) {
      const [ax, az] = r.points[k];
      const [bx, bz] = r.points[k + 1];
      const si = segs.length;
      segs.push({ road: ri, seg: k, ax, az, bx, bz, hw: (r.width || 6) / 2, name });
      if (name) {
        const l = byName.get(name);
        if (l) l.push(si);
        else byName.set(name, [si]);
      }
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
        for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) {
          const key = gkey(cx, cz);
          const l = grid.get(key);
          if (l) l.push(si);
          else grid.set(key, [si]);
        }
    }
  });
  const ci = { idx, centre, segs, grid, byName };
  cache.set(city, ci);
  return ci;
}

function pointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function predOf(result: QuakeResult, i: number): { pD: number; pM: number } {
  const d = result.damage[i];
  const e = d.predictedExceedance ?? d.exceedance; // BLIND prediction (never d.state)
  return { pD: e[3], pM: e[1] };
}

function evidenceOf(o: ReconObservation): string {
  if (o.source === 'drone') {
    const wave = o.missionId?.split('-')[0] ?? '';
    return `drone ${o.droneId ?? ''}${wave ? ` · ${wave}` : ''} · t+${Math.round(o.evidenceS)} s`;
  }
  return `AIR 1 chunk ${o.chunkIndex} · t+${Math.round(o.flightS)} s`;
}

/** Drone chunk indices are 1000 + wave·100 + drone·10 + k (recon-cache naming); heli chunks are small. */
function crowdEvidence(chunk: number | undefined): string {
  if (chunk === undefined) return 'Argon footage';
  if (chunk >= 1000) return `drone D${Math.floor(chunk / 10) % 10} · W${Math.floor(chunk / 100) % 10}`;
  return `AIR 1 chunk ${chunk}`;
}

function localTimeOf(localHour: number, simS: number): string {
  const mins = Math.round(localHour * 60 + simS / 60);
  const h = Math.floor(mins / 60) % 24;
  const m = ((mins % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} PDT`;
}

export function buildSituation(args: BuildSituationArgs): CopilotSituation {
  const { city, result, recon, router } = args;
  const facilities = args.facilities ?? FACILITIES;
  const hour = args.localHour ?? result.scenario.localHour;
  const ci = cityIndex(city);
  const obs: ReadonlyMap<string, ReconObservation> = recon.observations?.() ?? new Map();
  const obsRoads: readonly ObservedRoad[] = recon.observedRoads?.() ?? [];
  const obsCrowds: readonly ObservedCrowd[] = recon.observedCrowds?.() ?? [];
  const stats = recon.stats();

  // ── Verified building incidents ──
  type Scored = RescueIncident & { score: number };
  const verified: Scored[] = [];
  let trappedSites = 0;
  let fires = 0;
  let collapses = 0;
  let peopleSeen = 0;
  for (const [id, o] of obs) {
    const i = ci.idx.get(id);
    if (i === undefined) continue;
    const b = city.buildings[i];
    peopleSeen += o.peopleVisible;
    if (o.fire) fires++;
    if (o.damage === 'collapsed') collapses++;
    const severe = o.damage === 'collapsed' || o.damage === 'extensive';
    const kind: RescueIncident['kind'] | null =
      o.trappedSigns || (severe && o.peopleVisible > 0) ? 'trapped' : o.damage === 'collapsed' ? 'collapse' : o.fire ? 'fire' : null;
    if (!kind) continue;
    if (kind === 'trapped') trappedSites++;
    const occ = Math.round(occupantsAt(b, hour));
    const occW = Math.min(occ, 400);
    const score =
      kind === 'trapped'
        ? 1000 + 40 * o.peopleVisible + (o.trappedSigns ? 150 : 0) + 0.3 * occW + (o.fire ? 200 : 0)
        : kind === 'fire'
          ? 600 + 0.5 * occW
          : 300 + 150 * o.confidence + 0.6 * occW + (o.fire ? 200 : 0);
    const [x, z] = ci.centre[i];
    verified.push({
      id: `I-${id}`,
      kind,
      buildingId: id,
      label: buildingLabelOf(b),
      x: Math.round(x),
      z: Math.round(z),
      verified: true,
      confidence: r2(o.confidence),
      damage: o.damage,
      peopleSeen: o.peopleVisible || undefined,
      trappedSigns: o.trappedSigns || undefined,
      fire: o.fire || undefined,
      occupants: occ,
      evidence: evidenceOf(o),
      score,
    });
  }
  verified.sort((a, b) => b.score - a.score);
  const incidents: Scored[] = verified.slice(0, MAX_VERIFIED);
  const near = (x: number, z: number, d = DEDUP_M) => incidents.some((n) => Math.hypot(n.x - x, n.z - z) < d);

  // ── Crowds ──
  const areaByName = new Map<string, [number, number]>();
  for (const a of city.areas) {
    if (!a.name || a.polygon.length === 0) continue;
    let x = 0;
    let z = 0;
    for (const p of a.polygon) {
      x += p[0];
      z += p[1];
    }
    areaByName.set(a.name.toLowerCase(), [x / a.polygon.length, z / a.polygon.length]);
  }
  const locatePlace = (place: string): [number, number] | null => {
    const p = place.toLowerCase().replace(/^near\s+/, '').trim();
    if (!p) return null;
    const exact = areaByName.get(p);
    if (exact) return exact;
    for (const [n, c] of areaByName) if (n.includes(p) || p.includes(n)) return c;
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i];
      if (b.isPart) continue;
      const n = b.name?.toLowerCase();
      if (n && n.length > 3 && (n.includes(p) || p.includes(n))) return ci.centre[i];
    }
    return null;
  };
  let crowdN = 0;
  const crowdInc: Scored[] = [];
  for (const c of [...obsCrowds].sort((a, b) => b.approxCount - a.approxCount)) {
    let pos: [number, number] | null = null;
    let label = c.place ?? '';
    const bi = c.nearBuildingId ? ci.idx.get(c.nearBuildingId) : undefined;
    if (bi !== undefined) {
      pos = ci.centre[bi];
      if (!label) label = `near ${buildingLabelOf(city.buildings[bi])}`;
    } else if (c.place) pos = locatePlace(c.place);
    if (!pos || crowdInc.some((n) => Math.hypot(n.x - pos![0], n.z - pos![1]) < 30)) continue;
    crowdInc.push({
      id: `I-CROWD-${++crowdN}`,
      kind: 'crowd',
      label: `${label || 'crowd'} (~${c.approxCount} people)`,
      x: Math.round(pos[0]),
      z: Math.round(pos[1]),
      verified: true,
      confidence: 0.8,
      crowdSize: c.approxCount,
      evidence: crowdEvidence((c as { chunkIndex?: number }).chunkIndex),
      score: 200 + c.approxCount,
    });
    if (crowdInc.length >= MAX_CROWDS) break;
  }
  incidents.push(...crowdInc);

  // ── Unverified model risk (blind prediction × occupants) ──
  const suspects: { i: number; b: BuildingRecord; occ: number; pD: number; risk: number }[] = [];
  city.buildings.forEach((b, i) => {
    if (b.isPart || b.context || b.overWater || obs.has(b.id)) return;
    const { pD } = predOf(result, i);
    if (pD < SUSPECT_MIN_PD) return;
    const occ = Math.round(occupantsAt(b, hour));
    if (occ < 5) return;
    suspects.push({ i, b, occ, pD, risk: occ * pD });
  });
  suspects.sort((a, b) => b.risk - a.risk);
  let nSus = 0;
  for (const s of suspects) {
    if (nSus >= MAX_SUSPECTED || incidents.length >= MAX_INCIDENTS) break;
    const [x, z] = ci.centre[s.i];
    if (near(x, z)) continue;
    const scanned = args.scanned?.(s.i);
    incidents.push({
      id: `I-${s.b.id}`,
      kind: 'suspected_collapse',
      buildingId: s.b.id,
      label: buildingLabelOf(s.b),
      x: Math.round(x),
      z: Math.round(z),
      verified: false,
      confidence: r2(s.pD),
      occupants: s.occ,
      pDestroyed: r2(s.pD),
      evidence: scanned === true ? 'model only · AIR 1 passed, not assessable' : scanned === false ? 'model only · not yet scanned' : 'model only · not assessed by Argon',
      score: s.risk,
    });
    nSus++;
  }
  const finalIncidents: RescueIncident[] = incidents.slice(0, MAX_INCIDENTS).map(({ score, ...inc }) => inc);

  // ── Roads ──
  const roads: RoadStatus[] = [];
  const statusKey = new Map<string, RoadStatus>();
  // Priority: Argon-observed (blocked 6, partial 5) > inferred from a verified collapse (4) > model (3).
  const prio = (status: RoadStatus['status'], source: RoadStatus['source']) =>
    status === 'verified_blocked' ? 6 : status === 'partial' ? 5 : source === 'argon' ? 4 : 3;
  const put = (si: number, status: RoadStatus['status'], source: RoadStatus['source']) => {
    const s = ci.segs[si];
    const rd = city.roads[s.road];
    const key = `${rd.id}:${s.seg}`;
    const prev = statusKey.get(key);
    if (prev) {
      if (prio(status, source) > prio(prev.status, prev.source)) {
        prev.status = status;
        prev.source = source;
      }
      return;
    }
    const r: RoadStatus = { roadId: rd.id, segment: s.seg, name: rd.name, status, source };
    statusKey.set(key, r);
    roads.push(r);
  };
  // Verified (Argon ObservedRoad).
  const clearSpots: { name: string; x: number; z: number }[] = [];
  for (const r of obsRoads) {
    const bi = r.nearBuildingId ? ci.idx.get(r.nearBuildingId) : undefined;
    if (bi === undefined) continue;
    const [px, pz] = ci.centre[bi];
    const name = normStreet(r.street);
    if (r.status === 'clear') {
      clearSpots.push({ name, x: px, z: pz });
      continue;
    }
    const cands = ci.byName.get(name);
    if (!cands) continue;
    let best = -1;
    let bd = 90;
    for (const si of cands) {
      const s = ci.segs[si];
      const d = pointSeg(px, pz, s.ax, s.az, s.bx, s.bz);
      if (d < bd) {
        bd = d;
        best = si;
      }
    }
    if (best < 0) continue;
    const st = r.status === 'blocked' ? 'verified_blocked' : 'partial';
    put(best, st, 'argon');
    // Same-name segments meeting at the debris spot (vertex right at the pile / dual carriageway).
    const b = ci.segs[best];
    const dx = b.bx - b.ax;
    const dz = b.bz - b.az;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - b.ax) * dx + (pz - b.az) * dz) / L2));
    const qx = b.ax + dx * t;
    const qz = b.az + dz * t;
    for (const si of cands) {
      if (si === best) continue;
      const s = ci.segs[si];
      if (pointSeg(qx, qz, s.ax, s.az, s.bx, s.bz) < 12) put(si, st, 'argon');
    }
  }
  // Likely blocked: expected debris reach of verified collapses (argon) and unassessed high-risk buildings (model).
  const debrisCands: { i: number; source: RoadStatus['source']; w: number }[] = [];
  for (const [id, o] of obs) {
    if (o.damage !== 'collapsed') continue;
    const i = ci.idx.get(id);
    if (i !== undefined) debrisCands.push({ i, source: 'argon', w: 1 });
  }
  city.buildings.forEach((b, i) => {
    if (b.isPart || b.overWater || obs.has(b.id)) return;
    const { pD } = predOf(result, i);
    if (pD >= LIKELY_MIN_PD) debrisCands.push({ i, source: 'model', w: pD });
  });
  debrisCands.sort((a, b) => b.w - a.w);
  let nLikely = 0;
  for (const c of debrisCands) {
    if (nLikely >= MAX_LIKELY_ROADS) break;
    const b = city.buildings[c.i];
    const reach = Math.min(30, (DEBRIS_H[b.structure] ?? 0.35) * b.height * 0.75);
    if (reach < 3) continue;
    const [cx, cz] = ci.centre[c.i];
    const seen = new Set<number>();
    const r0 = Math.floor((cx - 120) / CELL);
    const r1 = Math.floor((cx + 120) / CELL);
    const s0 = Math.floor((cz - 120) / CELL);
    const s1 = Math.floor((cz + 120) / CELL);
    for (let gx = r0; gx <= r1; gx++)
      for (let gz = s0; gz <= s1; gz++) {
        const list = ci.grid.get(gkey(gx, gz));
        if (!list) continue;
        for (const si of list) {
          if (seen.has(si)) continue;
          seen.add(si);
          const s = ci.segs[si];
          let d = Infinity;
          for (const p of b.footprint) d = Math.min(d, pointSeg(p[0], p[1], s.ax, s.az, s.bx, s.bz));
          const w = s.hw * 2;
          const coverage = Math.max(0, Math.min(w, reach - Math.max(0, d - s.hw))) / w;
          if (coverage < 0.6) continue;
          if (c.source === 'model' && s.name && clearSpots.some((k) => k.name === s.name && pointSeg(k.x, k.z, s.ax, s.az, s.bx, s.bz) < 80)) continue;
          const key = `${city.roads[s.road].id}:${s.seg}`;
          if (!statusKey.has(key)) nLikely++;
          put(si, 'likely_blocked', c.source);
        }
      }
  }

  router.setRoadStatus(roads);
  const travelTimes = router.travelTimes(facilities, finalIncidents);

  return {
    scenarioId: args.scenarioId ?? result.scenario.id,
    simS: Math.round(args.simS),
    localTime: localTimeOf(hour, args.simS),
    minutesSinceQuake: Math.round((args.simS / 60) * 10) / 10,
    summary: {
      buildingsAssessed: stats.buildingsObserved,
      collapsesVerified: collapses,
      peopleSeen: Math.max(peopleSeen, stats.peopleObserved),
      trappedSitesVerified: trappedSites,
      fires,
      crowds: obsCrowds.length,
      areaScannedPct: Math.round(args.scannedFraction * 100),
      latestArgonSummary: stats.lastSummary,
    },
    incidents: finalIncidents,
    roads,
    facilities,
    travelTimes,
  };
}

/**
 * Compact travel-time table for the LLM prompt: per incident the `perIncident` fastest road facilities plus the
 * fastest air option (helipad), instead of the full facilities × incidents matrix.
 */
export function topTravelTimes(sit: CopilotSituation, perIncident = 3): CopilotSituation['travelTimes'] {
  const byInc = new Map<string, CopilotSituation['travelTimes']>();
  for (const t of sit.travelTimes) {
    const l = byInc.get(t.incidentId);
    if (l) l.push(t);
    else byInc.set(t.incidentId, [t]);
  }
  const heli = new Set(sit.facilities.filter((f) => (f.units?.helicopter ?? 0) > 0 || f.kind === 'helipad').map((f) => f.id));
  const out: CopilotSituation['travelTimes'] = [];
  for (const list of byInc.values()) {
    const road = list.filter((t) => t.roadMin !== null).sort((a, b) => a.roadMin! - b.roadMin!);
    const keep = new Set(road.slice(0, perIncident));
    const air = list.filter((t) => heli.has(t.fromFacilityId)).sort((a, b) => a.airMin - b.airMin)[0];
    if (air) keep.add(air);
    out.push(...keep);
  }
  return out;
}

const routerCache = new WeakMap<CityData, RouterHandle>();

/**
 * Loose convenience wrapper (harness / copilot session): accepts window.__argus.handles-style args.
 * Creates (and caches per city) a router when none is given, using args.terrain or window.__argus.ctx.terrain.
 */
export function buildCopilotSituation(args: {
  city: CityData;
  result: QuakeResult;
  recon: ReconHandle;
  simS: number;
  scan?: { scannedFraction(): number; isScanned(i: number): boolean };
  router?: RouterHandle;
  terrain?: Heightfield;
  facilities?: Facility[];
  scannedFraction?: number;
}): CopilotSituation {
  let router = args.router ?? routerCache.get(args.city);
  if (!router) {
    const terrain = args.terrain ?? (globalThis as { __argus?: { ctx?: { terrain?: Heightfield } } }).__argus?.ctx?.terrain;
    if (!terrain) throw new Error('buildCopilotSituation: router or terrain required');
    router = createRouter(args.city, terrain);
    routerCache.set(args.city, router);
  }
  return buildSituation({
    city: args.city,
    result: args.result,
    recon: args.recon,
    simS: args.simS,
    router,
    facilities: args.facilities,
    scannedFraction: args.scannedFraction ?? args.scan?.scannedFraction() ?? 0,
    scanned: args.scan ? (i) => args.scan!.isScanned(i) : undefined,
  });
}
