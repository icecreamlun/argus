/**
 * World-space raster helpers for the scan module: a fixed cell grid over the context area and a
 * scanline polygon fill (even-odd) with an optional range limit around a point.
 */
import type { XZ } from '../../contracts';

export interface GridRect {
  minX: number;
  minZ: number;
  cell: number;
  w: number;
  h: number;
}

export function makeGrid(minX: number, minZ: number, maxX: number, maxZ: number, cell: number): GridRect {
  return { minX, minZ, cell, w: Math.ceil((maxX - minX) / cell), h: Math.ceil((maxZ - minZ) / cell) };
}

/** Cell index for world x/z, or -1 outside. */
export function cellAt(g: GridRect, x: number, z: number): number {
  const i = Math.floor((x - g.minX) / g.cell);
  const j = Math.floor((z - g.minZ) / g.cell);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return -1;
  return j * g.w + i;
}

const xs: number[] = [];

/**
 * Calls fn(cellIndex) for every cell whose centre lies inside `poly` (even-odd) and, when `range` is given,
 * within `range` metres (horizontal) of [cx, cz].
 */
export function fillPolygon(g: GridRect, poly: XZ[], fn: (k: number) => void, cx = 0, cz = 0, range = Infinity): void {
  const n = poly.length;
  if (n < 3) return;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of poly) {
    if (p[1] < zMin) zMin = p[1];
    if (p[1] > zMax) zMax = p[1];
  }
  if (range < Infinity) {
    zMin = Math.max(zMin, cz - range);
    zMax = Math.min(zMax, cz + range);
  }
  const j0 = Math.max(0, Math.ceil((zMin - g.minZ) / g.cell - 0.5));
  const j1 = Math.min(g.h - 1, Math.floor((zMax - g.minZ) / g.cell - 0.5));
  for (let j = j0; j <= j1; j++) {
    const z = g.minZ + (j + 0.5) * g.cell;
    xs.length = 0;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const za = poly[a][1];
      const zb = poly[b][1];
      if (za > z !== zb > z) xs.push(poly[a][0] + ((z - za) / (zb - za)) * (poly[b][0] - poly[a][0]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    let rx0 = -Infinity;
    let rx1 = Infinity;
    if (range < Infinity) {
      const dz = z - cz;
      const r2 = range * range - dz * dz;
      if (r2 <= 0) continue;
      const r = Math.sqrt(r2);
      rx0 = cx - r;
      rx1 = cx + r;
    }
    const row = j * g.w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(xs[k], rx0);
      const x1 = Math.min(xs[k + 1], rx1);
      if (x1 <= x0) continue;
      const i0 = Math.max(0, Math.ceil((x0 - g.minX) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor((x1 - g.minX) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) fn(row + i);
    }
  }
}

export function centroid(poly: XZ[]): XZ {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

export function polygonArea(poly: XZ[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}
