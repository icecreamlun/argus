/**
 * Road network queries and debris blockage.
 *
 * Blockage geometry: a damaged building's debris zone is its footprint buffered by debrisRadius r. A road
 * segment (centreline a→b, carriageway width w) is affected when the zone reaches the carriageway, i.e. the
 * centreline-to-footprint distance d satisfies d − w/2 < r (sidewalks lie between facade and kerb, so they
 * are already inside d). Across the street the pile covers the carriageway from the near kerb (d − w/2) out
 * to r, so coverage = clamp(r − max(0, d − w/2), 0, w) / w; ≥ 0.6 means impassable for vehicles.
 * The pile centre is the midpoint of the covered strip on the line from the facade to the centreline.
 * Several buildings hitting one segment are merged (largest coverage wins, it names the cause).
 * Only segments with coverage ≥ BLOCKED_COVERAGE (0.5: at most one lane of a two-lane street left) are reported
 * as blockages: glass, cladding and parapet spill that reaches the kerb lane is debris, not a closure — US&R
 * route reconnaissance after 1989/1994 classified such streets as passable with care. Lighter spill is still
 * drawn around each building from its debrisRadius.
 * Tunnels and elevated structures (bridge/layer ≥ 1) cannot be buried by street-level debris.
 */
import type { CityData, RoadBlockage, RoadKind, XZ } from '../../contracts';
import { Grid, segPolyDist, pointSegDist, closestOnSegment, SEG_POLY, type BuildingGeo } from './spatial';
import { hyp } from './math';

export interface RoadSeg {
  road: number;
  seg: number;
  a: XZ;
  b: XZ;
  halfWidth: number;
  kind: RoadKind;
}

export interface RoadIndex {
  segs: RoadSeg[];
  grid: Grid;
  /** Grid of street-kind segments only (for frontage lookups). */
  streetGrid: Grid;
  maxHalfWidth: number;
}

const cache = new WeakMap<CityData, RoadIndex>();

/** Kinds that count as a street frontage for lean bias (vehicles or people). */
const STREET_KINDS = new Set<RoadKind>(['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'pedestrian']);

export function roadIndex(city: CityData): RoadIndex {
  const hit = cache.get(city);
  if (hit) return hit;
  const segs: RoadSeg[] = [];
  const grid = new Grid(40);
  const streetGrid = new Grid(40);
  let maxHalfWidth = 0;
  (city.roads ?? []).forEach((r, ri) => {
    if (r.tunnel) return;
    if (r.bridge && (r.layer ?? 1) >= 1) return;
    const hw = Math.max(0.75, (r.width || 6) / 2);
    maxHalfWidth = Math.max(maxHalfWidth, hw);
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const id = segs.length;
      segs.push({ road: ri, seg: i, a, b, halfWidth: hw, kind: r.kind });
      grid.insertBox(id, Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw);
      if (STREET_KINDS.has(r.kind)) streetGrid.insertBox(id, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  });
  const idx = { segs, grid, streetGrid, maxHalfWidth };
  cache.set(city, idx);
  return idx;
}

/** Unit vector from (x, z) toward the nearest street centreline within maxR, or null. */
const scratchIds: number[] = [];

export function towardNearestStreet(idx: RoadIndex, x: number, z: number, maxR = 50): XZ | null {
  scratchIds.length = 0;
  const ids = idx.streetGrid.queryBox(x - maxR, z - maxR, x + maxR, z + maxR, scratchIds);
  let best = maxR;
  let dir: XZ | null = null;
  for (const id of ids) {
    const s = idx.segs[id];
    const q = closestOnSegment(x, z, s.a[0], s.a[1], s.b[0], s.b[1]);
    const d = hyp(q[0] - x, q[1] - z);
    if (d < best && d > 1e-6) {
      best = d;
      dir = [(q[0] - x) / d, (q[1] - z) / d];
    }
  }
  return dir;
}

/** Minimum carriageway coverage for a segment to count as blocked. */
export const BLOCKED_COVERAGE = 0.5;

export interface DebrisSource {
  building: number;
  radius: number;
}

export function computeBlockages(city: CityData, geo: BuildingGeo, sources: DebrisSource[]): RoadBlockage[] {
  const idx = roadIndex(city);
  if (idx.segs.length === 0) return [];
  const bySeg = new Map<number, RoadBlockage>();
  const stamp = new Int32Array(idx.segs.length).fill(-1);
  const scratch: number[] = [];
  for (const { building: bi, radius: r } of sources) {
    if (r <= 0.05) continue;
    const b = city.buildings[bi];
    if (!b || b.footprint.length < 3) continue;
    const pad = r + idx.maxHalfWidth;
    scratch.length = 0;
    const ids = idx.grid.queryBox(geo.minX[bi] - pad, geo.minZ[bi] - pad, geo.maxX[bi] + pad, geo.maxZ[bi] + pad, scratch);
    const cx = geo.cx[bi];
    const cz = geo.cz[bi];
    for (const id of ids) {
      if (stamp[id] === bi) continue;
      stamp[id] = bi;
      const s = idx.segs[id];
      // Cheap reject with the footprint's bounding circle.
      if (pointSegDist(cx, cz, s.a[0], s.a[1], s.b[0], s.b[1]) - geo.rad[bi] >= r + s.halfWidth) continue;
      const w = s.halfWidth * 2;
      const d = segPolyDist(s.a[0], s.a[1], s.b[0], s.b[1], b.footprint);
      const nearKerb = Math.max(0, d - s.halfWidth);
      if (nearKerb >= r) continue;
      const coverage = Math.min(1, Math.min(w, r - nearKerb) / w);
      if (coverage < 0.05) continue;
      const prev = bySeg.get(id);
      if (prev && coverage <= prev.coverage) continue;
      // Pile centre: midpoint of the covered strip, measured from the facade toward the centreline.
      const { qx, qz, px, pz } = SEG_POLY;
      let at: XZ = [qx, qz];
      if (d > 1e-6) {
        const mid = (nearKerb + Math.min(d + s.halfWidth, r)) / 2;
        at = [px + ((qx - px) / d) * mid, pz + ((qz - pz) / d) * mid];
      }
      bySeg.set(id, {
        roadId: city.roads[s.road].id,
        segment: s.seg,
        coverage: Math.round(coverage * 1000) / 1000,
        causeBuildingId: b.id,
        at: [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100],
      });
    }
  }
  return [...bySeg.entries()]
    .filter(([, v]) => v.coverage >= BLOCKED_COVERAGE)
    .sort((x, y) => x[0] - y[0])
    .map(([, v]) => v);
}
