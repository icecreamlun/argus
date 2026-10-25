/**
 * Mock Argon reconstruction: a plausible ReconstructionResult derived from the hidden truth with realistic
 * noise (≈80 % exact damage state, otherwise ±1; people counts ±30 %; occasional misses). Used when the
 * server fails, and for deterministic screenshots. Deterministic for (chunk, seed).
 */
import type {
  CityData,
  DamageState,
  ObservedBuilding,
  ObservedCrowd,
  ObservedDamage,
  ObservedRoad,
  PeopleTruth,
  QuakeResult,
  ReconstructionResult,
  ScanChunk,
} from '../contracts';

export const OBSERVED_DAMAGE: readonly ObservedDamage[] = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Truth damage state of a building record (collapsed counts as complete). */
export function truthState(result: QuakeResult, i: number): DamageState {
  const d = result.damage[i];
  return d.collapsed ? 4 : d.state;
}

let defaultCity: CityData | null = null;
/** Registered by createRecon() so callers can use the 4-argument form. */
export function setMockCity(city: CityData): void {
  defaultCity = city;
}

export interface MockOptions {
  /** City data (ids → indices, roads). Defaults to the city registered by createRecon(). */
  city?: CityData;
  /** Simulated latency (ms) reported in the result (no real wait). Default 6–12 s. */
  latencyMs?: number;
}

export function createMockReconstruction(
  chunk: ScanChunk,
  result: QuakeResult,
  people: PeopleTruth | null,
  seed: number,
  opts: MockOptions = {},
): ReconstructionResult {
  const city = opts.city ?? defaultCity;
  if (!city) throw new Error('createMockReconstruction: no city (call createRecon first or pass opts.city)');
  const r = rng(hashStr(`${seed}:${chunk.chunkIndex}`));
  const idx = new Map<string, number>();
  city.buildings.forEach((b, i) => idx.set(b.id, i));
  const nFrames = Math.max(1, chunk.frames.length || Math.round(chunk.endFlightS - chunk.startFlightS) || 1);
  const frameOf = (id: string) => {
    // Frame where the building was tagged (middle occurrence), else random.
    const hits: number[] = [];
    chunk.frames.forEach((f, k) => {
      if (f.taggedBuildingIds.includes(id)) hits.push(k);
    });
    return hits.length ? hits[hits.length >> 1] : Math.floor(r() * nFrames);
  };

  const buildings: ObservedBuilding[] = [];
  const roads: ObservedRoad[] = [];
  let collapsed = 0;
  let trappedSeen = 0;
  let fires = 0;
  for (const id of chunk.buildingIds) {
    const i = idx.get(id);
    if (i === undefined) continue;
    const d = result.damage[i];
    const truth = truthState(result, i);
    // Misses: small/undamaged buildings are skipped more often (nothing remarkable to report).
    const missP = truth === 0 ? 0.12 : 0.05;
    if (r() < missP) continue;
    let s: number = truth;
    const u = r();
    if (u > 0.8) {
      // Errors bias toward under-calling light damage and over-calling heavy rubble.
      const dir = s === 0 ? 1 : s === 4 ? -1 : u > 0.9 ? 1 : -1;
      s = Math.max(0, Math.min(4, s + dir));
    }
    const pv = people?.byBuilding[id]?.visible ?? 0;
    const peopleVisible = pv > 0 && r() > 0.1 ? Math.max(1, Math.round(pv * (0.7 + r() * 0.6))) : 0;
    const trappedSigns = peopleVisible > 0 && truth >= 3;
    const fire = d.fire && r() > 0.08;
    if (s === 4) collapsed++;
    if (trappedSigns) trappedSeen += peopleVisible;
    if (fire) fires++;
    const conf = s === truth ? 0.72 + r() * 0.25 : 0.45 + r() * 0.3;
    buildings.push({
      id,
      damage: OBSERVED_DAMAGE[s],
      confidence: Math.round(conf * 100) / 100,
      peopleVisible,
      trappedSigns,
      fire,
      smoke: fire || (s >= 3 && r() > 0.5),
      evidenceS: frameOf(id),
      notes:
        s === 4
          ? 'Pancaked floors, debris across sidewalk'
          : s === 3
            ? 'Large facade cracks, partial wall failure'
            : s === 2
              ? 'Visible cracking, fallen parapet'
              : undefined,
    });
  }

  // Roads: blockages caused by buildings in this chunk.
  const inChunk = new Set(chunk.buildingIds);
  const roadById = new Map(city.roads.map((rd) => [rd.id, rd]));
  const seenRoads = new Set<string>();
  for (const b of result.roads) {
    if (!inChunk.has(b.causeBuildingId) || b.coverage < 0.35) continue;
    const rd = roadById.get(b.roadId);
    if (!rd?.name) continue;
    const key = `${rd.name}:${b.causeBuildingId}`;
    if (seenRoads.has(key) || r() < 0.15) continue;
    seenRoads.add(key);
    roads.push({
      street: rd.name,
      nearBuildingId: b.causeBuildingId,
      status: b.coverage >= 0.6 ? 'blocked' : 'partial',
      evidenceS: frameOf(b.causeBuildingId),
      notes: b.coverage >= 0.6 ? 'Debris across all lanes' : 'Debris in one lane',
    });
    if (roads.length >= 12) break;
  }

  // Crowds: truth crowds near any frame footprint / candidate building.
  const crowds: ObservedCrowd[] = [];
  if (people) {
    const pts: [number, number][] = [];
    for (const id of chunk.buildingIds) {
      const i = idx.get(id);
      if (i === undefined) continue;
      const fp = city.buildings[i].footprint;
      pts.push(fp[0]);
    }
    const lastSim = chunk.frames.length ? chunk.frames[chunk.frames.length - 1].simS : Infinity;
    for (const c of people.crowds) {
      if (c.appearS > lastSim) continue;
      let best = Infinity;
      let bestId: string | undefined;
      for (let k = 0; k < pts.length; k++) {
        const dd = Math.hypot(pts[k][0] - c.x, pts[k][1] - c.z);
        if (dd < best) {
          best = dd;
          bestId = chunk.buildingIds[k];
        }
      }
      if (best > 120 || r() < 0.1) continue;
      crowds.push({ place: c.name, nearBuildingId: bestId, approxCount: Math.max(5, Math.round((c.count * (0.7 + r() * 0.6)) / 10) * 10), evidenceS: Math.floor(r() * nFrames) });
    }
  }

  const parts = [`${buildings.length} buildings assessed`];
  if (collapsed) parts.push(`${collapsed} collapsed`);
  if (trappedSeen) parts.push(`${trappedSeen} people visible on rubble`);
  if (fires) parts.push(`${fires} active fire${fires > 1 ? 's' : ''}`);
  if (roads.length) parts.push(`${roads.filter((x) => x.status === 'blocked').length} street blockages`);
  if (crowds.length) parts.push(`${crowds.length} crowd${crowds.length > 1 ? 's' : ''} gathering`);

  return {
    chunkIndex: chunk.chunkIndex,
    model: 'gemini-4-argon',
    mode: 'mock',
    latencyMs: opts.latencyMs ?? Math.round(6000 + r() * 6000),
    buildings,
    roads,
    crowds,
    summary: `Chunk ${chunk.chunkIndex + 1}: ${parts.join(', ')}.`,
  };
}
