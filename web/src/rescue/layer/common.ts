/**
 * Rescue layer shared bits: unit colours / lanes / sizes, ground sampling, polyline helpers.
 */
import * as THREE from 'three';
import type { Heightfield, UnitType } from '../../contracts';

/** Main camera only (drone / helicopter gimbal cameras render layer 0 and never see the plan). */
export const RESCUE_LAYER = 10;

export const UNIT_HEX: Record<UnitType, string> = {
  engine: '#ff4b3a',
  truck: '#ff4b3a',
  usar: '#ff9a1f',
  ambulance: '#e6fff0',
  police: '#3d8bff',
  helicopter: '#ffd23f',
};

/** Linear-space colours (THREE.Color hex setters convert sRGB → linear working space). */
export const UNIT_COLOR: Record<UnitType, THREE.Color> = Object.fromEntries(
  Object.entries(UNIT_HEX).map(([k, v]) => [k, new THREE.Color(v)]),
) as Record<UnitType, THREE.Color>;
// Ambulance ribbons: white with a clear green tint so they don't read as plain white lines.
UNIT_COLOR.ambulance.setRGB(0.62, 1.0, 0.74);

export const UNIT_SHORT: Record<UnitType, string> = {
  engine: 'ENG',
  truck: 'TRK',
  usar: 'USAR',
  ambulance: 'AMB',
  police: 'PD',
  helicopter: 'HELO',
};

export const UNIT_LABEL: Record<UnitType, string> = {
  engine: 'Engine',
  truck: 'Truck',
  usar: 'USAR',
  ambulance: 'Ambulance',
  police: 'Police',
  helicopter: 'Helicopter',
};

/** Side-by-side lanes (transit-map style) so routes of different unit types sharing a street don't overlap. */
export const UNIT_LANE: Record<UnitType, number> = {
  engine: 0,
  truck: 0,
  usar: 1,
  ambulance: -1,
  police: 2,
  helicopter: 0,
};

/** Token size (length, width, height) in metres before camera-distance scaling. */
export const UNIT_SIZE: Record<UnitType, [number, number, number]> = {
  engine: [9, 2.6, 3.0],
  truck: [11.5, 2.6, 3.1],
  usar: [10, 2.7, 3.3],
  ambulance: [6.6, 2.4, 2.8],
  police: [5, 2.0, 1.6],
  helicopter: [13, 2.4, 3.2],
};

export const PRIORITY_HEX = ['#ff3b30', '#ff8a1f', '#ffd23f', '#9fb3c8'];
export const PRIORITY_COLOR = PRIORITY_HEX.map((h) => new THREE.Color(h));

export function groundAt(terrain: Heightfield, x: number, z: number): number {
  return Math.max(terrain.heightAt(x, z), 0);
}

/** World size (m) of one screen pixel at 1 m distance for the main camera. */
export function pxPerMetre(camera: THREE.PerspectiveCamera, viewportH: number): number {
  return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportH);
}

export interface Polyline {
  /** Flat xyz. */
  p: Float32Array;
  /** Cumulative distance per vertex. */
  d: Float32Array;
  n: number;
  length: number;
}

export function makePolyline(pts: number[]): Polyline {
  const n = pts.length / 3;
  const p = new Float32Array(pts);
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dx = p[i * 3] - p[i * 3 - 3];
    const dy = p[i * 3 + 1] - p[i * 3 - 2];
    const dz = p[i * 3 + 2] - p[i * 3 - 1];
    d[i] = d[i - 1] + Math.hypot(dx, dy * 0.25, dz); // horizontal-dominant distance (hills don't stretch dashes)
  }
  return { p, d, n, length: n ? d[n - 1] : 0 };
}

/** Sample position + horizontal heading at distance s along the polyline. */
export function sampleAt(pl: Polyline, s: number, out: THREE.Vector3, dir?: THREE.Vector3): void {
  const { p, d, n } = pl;
  if (n === 0) return void out.set(0, 0, 0);
  if (n === 1 || s <= 0) {
    out.set(p[0], p[1], p[2]);
    if (dir && n > 1) dir.set(p[3] - p[0], p[4] - p[1], p[5] - p[2]).normalize();
    return;
  }
  if (s >= pl.length) {
    out.set(p[(n - 1) * 3], p[(n - 1) * 3 + 1], p[(n - 1) * 3 + 2]);
    if (dir) dir.set(p[(n - 1) * 3] - p[(n - 2) * 3], p[(n - 1) * 3 + 1] - p[(n - 2) * 3 + 1], p[(n - 1) * 3 + 2] - p[(n - 2) * 3 + 2]).normalize();
    return;
  }
  // Binary search.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (d[m] <= s) lo = m;
    else hi = m;
  }
  const seg = d[hi] - d[lo] || 1;
  const t = (s - d[lo]) / seg;
  const a = lo * 3;
  const b = hi * 3;
  out.set(p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t);
  if (dir) dir.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]).normalize();
}

/**
 * Road route → smooth draped polyline: rounded corners (fixed small radius so the ribbon never cuts across
 * a corner building), densified to ≤ step metres, draped on terrain (or kept on a bridge deck), lifted.
 */
export function drapeRoad(terrain: Heightfield, pts: [number, number, number][], lift: number, step = 5): number[] {
  // Drop near-duplicate vertices.
  const src: [number, number, number][] = [];
  for (const q of pts) {
    const l = src[src.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[2] - l[2]) > 0.5) src.push(q);
  }
  if (src.length < 2) {
    const q = src[0] ?? [0, 0, 0];
    return [q[0], groundAt(terrain, q[0], q[2]) + lift, q[2], q[0] + 0.1, groundAt(terrain, q[0], q[2]) + lift, q[2]];
  }
  // Rounded corners.
  const R = 7;
  const rounded: [number, number, number][] = [src[0]];
  for (let i = 1; i < src.length - 1; i++) {
    const A = src[i - 1];
    const P = src[i];
    const C = src[i + 1];
    const l1 = Math.hypot(P[0] - A[0], P[2] - A[2]);
    const l2 = Math.hypot(C[0] - P[0], C[2] - P[2]);
    const d1x = (P[0] - A[0]) / l1;
    const d1z = (P[2] - A[2]) / l1;
    const d2x = (C[0] - P[0]) / l2;
    const d2z = (C[2] - P[2]) / l2;
    const turn = 1 - (d1x * d2x + d1z * d2z); // 0 straight .. 2 reversal
    if (turn < 0.03) {
      rounded.push(P);
      continue;
    }
    const t = Math.min(R, l1 * 0.45, l2 * 0.45);
    const s0: [number, number, number] = [P[0] - d1x * t, P[1], P[2] - d1z * t];
    const s1: [number, number, number] = [P[0] + d2x * t, P[1], P[2] + d2z * t];
    const K = 5;
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      rounded.push([a * s0[0] + b * P[0] + c * s1[0], P[1], a * s0[2] + b * P[2] + c * s1[2]]);
    }
  }
  rounded.push(src[src.length - 1]);
  // Densify + drape.
  const out: number[] = [];
  const push = (x: number, y: number, z: number) => {
    const g = groundAt(terrain, x, z);
    // Router y above ground by > 3 m = bridge / deck: keep it; else drape on terrain.
    const base = y > g + 3 ? y : g;
    out.push(x, base + lift, z);
  };
  for (let i = 0; i < rounded.length - 1; i++) {
    const a = rounded[i];
    const b = rounded[i + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const u = j / k;
      push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
    }
  }
  const e = rounded[rounded.length - 1];
  push(e[0], e[1], e[2]);
  return out;
}

/** Air route → arc polyline (uses the router's arc if it really is one, else a parabola). */
export function airArc(terrain: Heightfield, pts: [number, number, number][], step = 8): number[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const ga = groundAt(terrain, a[0], a[2]);
  const gb = groundAt(terrain, b[0], b[2]);
  const maxY = Math.max(...pts.map((q) => q[1] - groundAt(terrain, q[0], q[2])));
  const out: number[] = [];
  if (pts.length >= 8 && maxY > 40) {
    for (const q of pts) out.push(q[0], q[1], q[2]);
    return out;
  }
  const dist = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const y0 = ga + 6;
  const y1 = gb + 55; // hover over the scene
  const apex = Math.max(y0, y1) + 70 + dist * 0.12;
  const n = Math.max(12, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    // Quick climb, long cruise, gentle descent to hover.
    const base = y0 + (y1 - y0) * u;
    const h = Math.sin(Math.PI * Math.pow(u, 0.8)) * (apex - Math.max(y0, y1));
    out.push(a[0] + (b[0] - a[0]) * u, Math.max(base + h, groundAt(terrain, a[0] + (b[0] - a[0]) * u, a[2] + (b[2] - a[2]) * u) + 30 * Math.min(1, u * 8, (1 - u) * 8 + 0.5)), a[2] + (b[2] - a[2]) * u);
  }
  return out;
}

/** Ribbon core half-width (m) at a camera distance — must match RIBBON_VS in ribbons.ts. */
export function coreHalfAt(dist: number, px: number): number {
  const t = THREE.MathUtils.smoothstep(dist, 800, 2500);
  return Math.max(1.8, dist * px * (3.0 + 0.6 * t));
}
