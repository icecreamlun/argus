/** Small 2D polygon helpers (footprints are [x, z] rings in world metres). */
import type { XZ } from '../../contracts';

export function ringArea(r: XZ[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/** Area centroid (falls back to the vertex mean for degenerate rings). */
export function ringCentroid(r: XZ[]): XZ {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let mx = 0;
    let mz = 0;
    for (const p of r) {
      mx += p[0];
      mz += p[1];
    }
    return [mx / Math.max(1, r.length), mz / Math.max(1, r.length)];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, r: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0];
    const zi = r[i][1];
    const xj = r[j][0];
    const zj = r[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the ring boundary, plus the closest boundary point and its outward edge normal. */
export function closestOnRing(x: number, z: number, r: XZ[]): { d: number; px: number; pz: number; nx: number; nz: number } {
  let best = Infinity;
  let bx = x;
  let bz = z;
  let bnx = 0;
  let bnz = 0;
  const ccw = ringArea(r) > 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ax = r[j][0];
    const az = r[j][1];
    const ex = r[i][0] - ax;
    const ez = r[i][1] - az;
    const l2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    const qx = ax + ex * t;
    const qz = az + ez * t;
    const d = (x - qx) ** 2 + (z - qz) ** 2;
    if (d < best) {
      best = d;
      bx = qx;
      bz = qz;
      const l = Math.sqrt(l2);
      // Outward normal of a CCW ring (in x/z with +z south) is (ez, -ex) rotated depending on winding.
      bnx = (ccw ? ez : -ez) / l;
      bnz = (ccw ? -ex : ex) / l;
    }
  }
  return { d: Math.sqrt(best), px: bx, pz: bz, nx: bnx, nz: bnz };
}

/** Signed distance to the ring (negative inside). */
export function signedDistance(x: number, z: number, r: XZ[]): number {
  const d = closestOnRing(x, z, r).d;
  return pointInRing(x, z, r) ? -d : d;
}

export function ringPerimeter(r: XZ[]): number {
  let p = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) p += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]);
  return p;
}

/** Random point on the ring boundary (u in [0,1) along the perimeter) with the edge's outward normal. */
export function pointOnRing(r: XZ[], u: number): { x: number; z: number; nx: number; nz: number } {
  const per = ringPerimeter(r);
  let s = u * per;
  const ccw = ringArea(r) > 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ex = r[i][0] - r[j][0];
    const ez = r[i][1] - r[j][1];
    const l = Math.hypot(ex, ez);
    if (s <= l || i === r.length - 1) {
      const t = l > 0 ? Math.min(1, s / l) : 0;
      return {
        x: r[j][0] + ex * t,
        z: r[j][1] + ez * t,
        nx: (ccw ? ez : -ez) / (l || 1),
        nz: (ccw ? -ex : ex) / (l || 1),
      };
    }
    s -= l;
  }
  return { x: r[0][0], z: r[0][1], nx: 1, nz: 0 };
}

export function ringBounds(r: XZ[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}
