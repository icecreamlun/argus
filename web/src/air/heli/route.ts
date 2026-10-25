/**
 * AIR 1 hard-coded flight plan + deterministic pose sampling (pure: depends only on terrain + city data).
 *
 * Route (world metres, +X east, +Z south), counter-clockwise loop, observer camera looks LEFT = into the loop:
 *   1. Launch over the bay ~600 m east of the Ferry Building           (980, -330)
 *   2. West over the Ferry Building clock tower + Embarcadero Plaza     (400, -225) → (230, -215)
 *   3. West along the Washington/Clay corridor (passes just north of the Transamerica Pyramid)
 *                                                                        (0, -258) → (-424, -262) → (-640, -172)
 *   4. Over Chinatown (Grant Ave / Portsmouth Sq), left turn south      (-790, -120)
 *   5. South between Grant & Stockton to Bush St                        (-815, 60) → (-790, 260) → (-700, 300)
 *   6. East between Pine & Bush (just south of 555 California) back to the Financial District
 *                                                                        (-500, 250) → (-300, 214) → (0, 150)
 *   7. Exit north-east over the Ferry Building back to the bay          (230, -40) → (410, -215) → (1000, -520)
 * Smoothed with a centripetal Catmull-Rom spline, flown at constant ground speed (SPEED_MS).
 * Altitude: 180 m above terrain (water clamped to 0), smoothed over ±300 m so it doesn't bob, raised where a
 * tower would come within 35 m (clearance + 35 m), then re-smoothed.
 */
import * as THREE from 'three';
import type { BuildingRecord, Heightfield, XZ } from '../../contracts';

export const ROUTE_WAYPOINTS: XZ[] = [
  [980, -330],
  [700, -272],
  [400, -225],
  [230, -215],
  [0, -258],
  [-220, -258],
  [-424, -262],
  [-640, -172],
  [-790, -120],
  [-830, -20],
  [-815, 90],
  [-790, 240],
  [-720, 290],
  [-500, 252],
  [-300, 214],
  [-100, 172],
  [40, 140],
  [230, -40],
  [410, -215],
  [640, -380],
  [1000, -520],
];

export const ALTITUDE_AGL = 150;
export const SPEED_MS = 38;
export const CAM_FOV_DEG = 30;
export const CAM_ASPECT = 16 / 9;
/** Gimbal: depression below horizon and yaw offset to the LEFT of the heading (police observer sits left). */
export const CAM_DEPRESSION_DEG = 42;
export const CAM_YAW_LEFT_DEG = 28;
export const FOOTPRINT_MAX_DIST = 900;

const SAMPLE_STEP = 2; // metres between precomputed samples

export interface RouteSamples {
  step: number;
  length: number;
  n: number;
  x: Float64Array;
  z: Float64Array;
  y: Float64Array;
  heading: Float64Array; // rad, 0 = north (-Z), clockwise +
  bank: Float64Array; // rad, + = right wing down
  pitch: Float64Array; // rad, + = nose up
}

/** Visible ground height: terrain, but the bay surface is at 0. */
export function groundAt(terrain: Heightfield, x: number, z: number): number {
  return Math.max(terrain.heightAt(x, z), 0);
}

function boxSmooth(src: Float64Array, halfWin: number): Float64Array {
  const n = src.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWin);
    const b = Math.min(n - 1, i + halfWin);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

/** Two box passes ≈ triangular window. */
function smooth(src: Float64Array, halfWin: number): Float64Array {
  return boxSmooth(boxSmooth(src, Math.max(1, halfWin >> 1)), Math.max(1, halfWin >> 1));
}

function unwrap(a: Float64Array) {
  for (let i = 1; i < a.length; i++) {
    let d = a[i] - a[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    a[i] = a[i - 1] + d;
  }
}

export function buildRoute(terrain: Heightfield, buildings: BuildingRecord[]): RouteSamples {
  const curve = new THREE.CatmullRomCurve3(
    ROUTE_WAYPOINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'centripetal',
  );
  curve.arcLengthDivisions = 2000;
  const length = curve.getLength();
  const n = Math.floor(length / SAMPLE_STEP) + 1;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    curve.getPointAt(Math.min(1, (i * SAMPLE_STEP) / length), p);
    x[i] = p.x;
    z[i] = p.z;
  }

  // Heading from the tangent (unwrapped so smoothing / curvature are continuous).
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    heading[i] = Math.atan2(x[b] - x[a], -(z[b] - z[a]));
  }
  unwrap(heading);
  const hs = smooth(heading, 10);

  // Bank from curvature: tan(bank) = v² κ / g, clamped to 28°, smoothed.
  const bank = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 8);
    const b = Math.min(n - 1, i + 8);
    const kappa = (hs[b] - hs[a]) / ((b - a) * SAMPLE_STEP || 1);
    bank[i] = THREE.MathUtils.clamp(Math.atan((SPEED_MS * SPEED_MS * kappa) / 9.81), -0.49, 0.49);
  }
  const bankS = smooth(bank, 40);

  // Altitude: smoothed terrain + AGL, then tower clearance.
  const ground = new Float64Array(n);
  for (let i = 0; i < n; i++) ground[i] = groundAt(terrain, x[i], z[i]);
  const gs = smooth(ground, 150); // ±300 m
  const need = new Float64Array(n);
  for (let i = 0; i < n; i++) need[i] = gs[i] + ALTITUDE_AGL;

  // Tower clearance (only buildings tall enough to matter).
  const minTop = Math.min(...Array.from(gs)) + ALTITUDE_AGL - 40;
  for (const b of buildings) {
    const top = b.baseElevation + b.height;
    if (top < minTop) continue;
    const f = b.footprint;
    let cx = 0;
    let cz = 0;
    for (const q of f) {
      cx += q[0];
      cz += q[1];
    }
    cx /= f.length;
    cz /= f.length;
    let r = 0;
    for (const q of f) r = Math.max(r, Math.hypot(q[0] - cx, q[1] - cz));
    const reach = r + 35;
    for (let i = 0; i < n; i += 1) {
      const dx = x[i] - cx;
      const dz = z[i] - cz;
      if (dx * dx + dz * dz < reach * reach) need[i] = Math.max(need[i], top + 35);
    }
  }
  // Spread clearance needs forward/back so the climb starts early, then smooth.
  let y = smooth(need, 120);
  for (let i = 0; i < n; i++) y[i] = Math.max(y[i], need[i] - 8);
  y = smooth(y, 40);

  // Pitch: slight nose-down cruise attitude plus climb angle.
  const pitch = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 5);
    const b = Math.min(n - 1, i + 5);
    const climb = Math.atan2(y[b] - y[a], (b - a) * SAMPLE_STEP || 1);
    pitch[i] = -0.07 + climb * 0.5;
  }

  return { step: SAMPLE_STEP, length, n, x, z, y, heading: hs, bank: bankS, pitch };
}

export interface RawPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  bank: number;
  pitch: number;
  /** Fractional sample index (route progress). */
  idx: number;
}

export function sampleRoute(r: RouteSamples, flightS: number, durationS: number, out: RawPose): RawPose {
  const t = THREE.MathUtils.clamp(flightS, 0, durationS);
  const f = Math.min(((t * SPEED_MS) / r.step), r.n - 1);
  const i = Math.min(Math.floor(f), r.n - 2);
  const u = f - i;
  const L = (a: Float64Array) => a[i] + (a[i + 1] - a[i]) * u;
  out.x = L(r.x);
  out.y = L(r.y);
  out.z = L(r.z);
  out.heading = L(r.heading);
  out.bank = L(r.bank);
  out.pitch = L(r.pitch);
  out.idx = f;
  return out;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * March a ray against the visible ground (terrain, bay at 0). Returns the hit, or the point at maxDist
 * dropped onto the ground if nothing is hit.
 */
export function rayGround(terrain: Heightfield, o: THREE.Vector3, d: THREE.Vector3, maxDist: number, out: THREE.Vector3): THREE.Vector3 {
  _o.copy(o);
  _d.copy(d).normalize();
  const step = 8;
  let prev = 0;
  for (let s = step; s <= maxDist + 1e-6; s += step) {
    const px = _o.x + _d.x * s;
    const py = _o.y + _d.y * s;
    const pz = _o.z + _d.z * s;
    if (py <= groundAt(terrain, px, pz)) {
      let lo = prev;
      let hi = s;
      for (let k = 0; k < 8; k++) {
        const m = (lo + hi) / 2;
        const mx = _o.x + _d.x * m;
        const my = _o.y + _d.y * m;
        const mz = _o.z + _d.z * m;
        if (my <= groundAt(terrain, mx, mz)) hi = m;
        else lo = m;
      }
      out.set(_o.x + _d.x * hi, 0, _o.z + _d.z * hi);
      out.y = groundAt(terrain, out.x, out.z);
      return out;
    }
    prev = s;
  }
  out.set(_o.x + _d.x * maxDist, 0, _o.z + _d.z * maxDist);
  out.y = groundAt(terrain, out.x, out.z);
  return out;
}
