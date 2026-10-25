/**
 * Street-centreline segments with a coarse spatial hash, so dust can be channelled along the street canyons
 * around a collapse and the S-wave shock dust can be scattered along the streets.
 */
import type { RoadKind, RoadRecord } from '../../contracts';

export interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit direction a→b and length. */
  ux: number;
  uz: number;
  len: number;
  width: number;
  kind: RoadKind;
}

const SKIP: ReadonlySet<RoadKind> = new Set(['rail', 'cable_car', 'motorway', 'steps']);
const CELL = 40;

export class RoadIndex {
  readonly segs: Seg[] = [];
  private readonly cells = new Map<number, number[]>();

  constructor(roads: RoadRecord[]) {
    for (const r of roads) {
      if (SKIP.has(r.kind) || r.tunnel || r.bridge) continue;
      for (let i = 0; i + 1 < r.points.length; i++) {
        const [ax, az] = r.points[i];
        const [bx, bz] = r.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const k = this.segs.length;
        this.segs.push({ ax, az, bx, bz, ux: (bx - ax) / len, uz: (bz - az) / len, len, width: r.width, kind: r.kind });
        const x0 = Math.floor(Math.min(ax, bx) / CELL);
        const x1 = Math.floor(Math.max(ax, bx) / CELL);
        const z0 = Math.floor(Math.min(az, bz) / CELL);
        const z1 = Math.floor(Math.max(az, bz) / CELL);
        for (let ix = x0; ix <= x1; ix++)
          for (let iz = z0; iz <= z1; iz++) {
            const key = (ix + 5000) * 10000 + iz + 5000;
            let c = this.cells.get(key);
            if (!c) this.cells.set(key, (c = []));
            c.push(k);
          }
      }
    }
  }

  /** Segments within r of (x, z), nearest first, with the closest point on each. */
  near(x: number, z: number, r: number): { seg: Seg; d: number; px: number; pz: number }[] {
    const out: { seg: Seg; d: number; px: number; pz: number }[] = [];
    const seen = new Set<number>();
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL);
    const z1 = Math.floor((z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const c = this.cells.get((ix + 5000) * 10000 + iz + 5000);
        if (!c) continue;
        for (const k of c) {
          if (seen.has(k)) continue;
          seen.add(k);
          const s = this.segs[k];
          const t = Math.max(0, Math.min(s.len, (x - s.ax) * s.ux + (z - s.az) * s.uz));
          const px = s.ax + s.ux * t;
          const pz = s.az + s.uz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d <= r) out.push({ seg: s, d, px, pz });
        }
      }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
}
