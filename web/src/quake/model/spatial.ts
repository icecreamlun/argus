/**
 * 2-D geometry and spatial indexing in world metres ([x, z]).
 */
import type { BuildingRecord, CityData, XZ } from '../../contracts';
import { hyp } from './math';

export function polygonArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

export function polygonCentroid(ring: XZ[]): XZ {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    // Degenerate: vertex average.
    const n = Math.max(1, ring.length);
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInPolygon(x: number, z: number, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on segment ab to p. */
export function closestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): XZ {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [ax + t * dx, az + t * dz];
}

function segmentsIntersect(a: XZ, b: XZ, c: XZ, d: XZ): boolean {
  const o = (p: XZ, q: XZ, r: XZ) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Scratch result of segPolyDist (reused; copy what you need). */
export const SEG_POLY = { d: 0, qx: 0, qz: 0, px: 0, pz: 0 };

/**
 * Allocation-free variant of segmentPolygonDistance for hot loops: writes into SEG_POLY and returns d.
 */
export function segPolyDist(ax: number, az: number, bx: number, bz: number, ring: XZ[]): number {
  const R = SEG_POLY;
  if (pointInPolygon(ax, az, ring)) return set0(ax, az);
  if (pointInPolygon(bx, bz, ring)) return set0(bx, bz);
  let best = Infinity;
  const sdx = bx - ax;
  const sdz = bz - az;
  const sl2 = sdx * sdx + sdz * sdz;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cx = ring[j][0], cz = ring[j][1], ex = ring[i][0], ez = ring[i][1];
    const edx = ex - cx, edz = ez - cz;
    const el2 = edx * edx + edz * edz;
    // Proper intersection test (orientation signs).
    const o1 = edx * (az - cz) - edz * (ax - cx);
    const o2 = edx * (bz - cz) - edz * (bx - cx);
    const o3 = sdx * (cz - az) - sdz * (cx - ax);
    const o4 = sdx * (ez - az) - sdz * (ex - ax);
    if (o1 * o2 < 0 && o3 * o4 < 0) {
      const t = o1 / (o1 - o2);
      return set0(ax + t * sdx, az + t * sdz);
    }
    // a, b against edge
    for (let k = 0; k < 2; k++) {
      const px = k ? bx : ax, pz = k ? bz : az;
      let t = el2 > 0 ? ((px - cx) * edx + (pz - cz) * edz) / el2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = cx + t * edx, qz = cz + t * edz;
      const d2 = (qx - px) ** 2 + (qz - pz) ** 2;
      if (d2 < best) {
        best = d2;
        R.qx = px; R.qz = pz; R.px = qx; R.pz = qz;
      }
    }
    // c, e against segment
    for (let k = 0; k < 2; k++) {
      const px = k ? ex : cx, pz = k ? ez : cz;
      let t = sl2 > 0 ? ((px - ax) * sdx + (pz - az) * sdz) / sl2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * sdx, qz = az + t * sdz;
      const d2 = (qx - px) ** 2 + (qz - pz) ** 2;
      if (d2 < best) {
        best = d2;
        R.qx = qx; R.qz = qz; R.px = px; R.pz = pz;
      }
    }
  }
  R.d = Math.sqrt(best);
  return R.d;
}

function set0(x: number, z: number): number {
  SEG_POLY.d = 0;
  SEG_POLY.qx = SEG_POLY.px = x;
  SEG_POLY.qz = SEG_POLY.pz = z;
  return 0;
}

/** Distance from point to segment. */
export function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return hyp(ax + t * dx - px, az + t * dz - pz);
}

/**
 * Minimum distance between segment ab and polygon ring, with the closest points
 * (q on the segment, p on the polygon boundary). d = 0 if they intersect or ab lies inside.
 */
export function segmentPolygonDistance(a: XZ, b: XZ, ring: XZ[]): { d: number; q: XZ; p: XZ } {
  if (pointInPolygon(a[0], a[1], ring)) return { d: 0, q: a, p: a };
  if (pointInPolygon(b[0], b[1], ring)) return { d: 0, q: b, p: b };
  let best = { d: Infinity, q: a, p: a };
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const c = ring[j];
    const e = ring[i];
    if (segmentsIntersect(a, b, c, e)) {
      // Intersection point (approximate as the closest point of c on ab — exact point is not needed).
      const q = closestOnSegment(c[0], c[1], a[0], a[1], b[0], b[1]);
      return { d: 0, q, p: q };
    }
    const cands: [XZ, XZ][] = [
      [a, closestOnSegment(a[0], a[1], c[0], c[1], e[0], e[1])],
      [b, closestOnSegment(b[0], b[1], c[0], c[1], e[0], e[1])],
      [closestOnSegment(c[0], c[1], a[0], a[1], b[0], b[1]), c],
      [closestOnSegment(e[0], e[1], a[0], a[1], b[0], b[1]), e],
    ];
    for (const [q, p] of cands) {
      const d = hyp(q[0] - p[0], q[1] - p[1]);
      if (d < best.d) best = { d, q, p };
    }
  }
  return best;
}

/** Uniform hash grid of integer ids over the XZ plane. */
export class Grid {
  private cells = new Map<number, number[]>();
  constructor(readonly cell: number) {}
  private key(ix: number, iz: number) {
    return (ix + 32768) * 65536 + (iz + 32768);
  }
  insertBox(id: number, minX: number, minZ: number, maxX: number, maxZ: number) {
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++)
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const k = this.key(ix, iz);
        let arr = this.cells.get(k);
        if (!arr) this.cells.set(k, (arr = []));
        arr.push(id);
      }
  }
  /** Ids in cells overlapping the box (may contain duplicates for multi-cell items). */
  queryBox(minX: number, minZ: number, maxX: number, maxZ: number, out: number[] = []): number[] {
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++)
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const arr = this.cells.get(this.key(ix, iz));
        if (arr) for (const id of arr) out.push(id);
      }
    return out;
  }
}

/** Per-building derived geometry, computed once per CityData and cached. */
export interface BuildingGeo {
  cx: Float64Array;
  cz: Float64Array;
  area: Float64Array; // footprint m²
  /** Bounding-circle radius about the centroid (m). */
  rad: Float64Array;
  minX: Float64Array;
  minZ: Float64Array;
  maxX: Float64Array;
  maxZ: Float64Array;
  /** Centroid grid (cell 50 m). */
  grid: Grid;
  /** Bounding box of all centroids. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

const geoCache = new WeakMap<CityData, BuildingGeo>();

export function buildingGeo(city: CityData): BuildingGeo {
  const hit = geoCache.get(city);
  if (hit) return hit;
  const n = city.buildings.length;
  const g: BuildingGeo = {
    cx: new Float64Array(n),
    cz: new Float64Array(n),
    area: new Float64Array(n),
    rad: new Float64Array(n),
    minX: new Float64Array(n),
    minZ: new Float64Array(n),
    maxX: new Float64Array(n),
    maxZ: new Float64Array(n),
    grid: new Grid(50),
    bounds: { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity },
  };
  city.buildings.forEach((b: BuildingRecord, i) => {
    const fp = b.footprint;
    const [cx, cz] = fp.length >= 3 ? polygonCentroid(fp) : fp[0] ?? [0, 0];
    g.cx[i] = cx;
    g.cz[i] = cz;
    g.area[i] = fp.length >= 3 ? polygonArea(fp) : 1;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, rr = 0;
    for (const [x, z] of fp) {
      rr = Math.max(rr, hyp(x - cx, z - cz));
      if (x < x0) x0 = x;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (z > z1) z1 = z;
    }
    g.rad[i] = rr;
    g.minX[i] = x0;
    g.minZ[i] = z0;
    g.maxX[i] = x1;
    g.maxZ[i] = z1;
    g.grid.insertBox(i, cx, cz, cx, cz);
    const bb = g.bounds;
    bb.minX = Math.min(bb.minX, cx);
    bb.minZ = Math.min(bb.minZ, cz);
    bb.maxX = Math.max(bb.maxX, cx);
    bb.maxZ = Math.max(bb.maxZ, cz);
  });
  if (n === 0) g.bounds = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };
  geoCache.set(city, g);
  return g;
}

/** Building indices with centroid within r of (x, z). */
export function buildingsNear(geo: BuildingGeo, x: number, z: number, r: number, out: number[] = []): number[] {
  const ids = geo.grid.queryBox(x - r, z - r, x + r, z + r);
  for (const i of ids) if (hyp(geo.cx[i] - x, geo.cz[i] - z) <= r) out.push(i);
  return out;
}

/** Site conditions at an arbitrary point: inverse-distance-weighted log-Vs30 and fill fraction of nearby buildings. */
export function siteAt(city: CityData, geo: BuildingGeo, x: number, z: number): { vs30: number; fill: number } {
  let r = 120;
  let ids = buildingsNear(geo, x, z, r);
  if (ids.length === 0) {
    r = 250;
    ids = buildingsNear(geo, x, z, r);
  }
  if (ids.length === 0) return { vs30: 300, fill: 0 };
  let sw = 0;
  let sv = 0;
  let sf = 0;
  for (const i of ids) {
    const d = hyp(geo.cx[i] - x, geo.cz[i] - z);
    const w = 1 / (d * d + 400);
    const b = city.buildings[i];
    sw += w;
    sv += w * Math.log(b.vs30 > 0 ? b.vs30 : 300);
    sf += w * (b.onFill ? 1 : 0);
  }
  return { vs30: Math.exp(sv / sw), fill: sf / sw };
}
