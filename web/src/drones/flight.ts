/**
 * Drone flight planning + deterministic sampling (pure: depends only on terrain, city data and the mission).
 *
 * Mission profile (stop-and-go, like waypoint missions on real survey quadcopters):
 *   climb vertically off the pad → straight transit at cruise altitude (trapezoid speed profile, eased in/out)
 *   → partial orbit of target 1 (camera on the building's mid-height) → transit → orbit target 2 … → transit back
 *   → vertical descent onto the pad.
 * Cruise altitude = max(smoothed terrain + ALTITUDE_AGL, tallest roof within ROOF_RADIUS + ROOF_CLEAR), smoothed
 * along each leg with a running max (so clearance is never lost by the smoothing). Orbit start angle / direction
 * are chosen to keep the arc low (away from towers) and close to the approach direction.
 */
import * as THREE from 'three';
import type { BuildingRecord, DroneId, DroneMission, DronePhase, Heightfield, XZ } from '../contracts';
import { groundAt, rayGround } from '../air/heli/route';

export const DRONE_IDS: DroneId[] = ['D1', 'D2', 'D3'];
/** Staging point: Embarcadero Plaza (open plaza east of Embarcadero Center 4, ~45 m clear of the tower). */
export const BASE: XZ = [245, -213];
/** Pads a few metres apart around the base. */
export const PAD_OFFSET: Record<DroneId, XZ> = { D1: [-7, 4], D2: [0, -4], D3: [7, 4] };
export const SPEED_MS = 15;
export const ALTITUDE_AGL = 70;
export const ORBIT_S = 18;
export const ENDURANCE_S = 900;
export const ORBIT_RADIUS = 80;
export const CAM_FOV_DEG = 34;
export const CAM_ASPECT = 16 / 9;

const ACCEL = 3; // m/s² horizontal
const CLIMB_MS = 6;
const CLIMB_ACCEL = 2.5;
const ORBIT_V = 14; // peak tangential speed in orbit
const ORBIT_ACCEL = 4;
const ROOF_CLEAR = 25;
const ROOF_RADIUS = 60; // around targets (orbit)
const ROOF_RADIUS_TRANSIT = 30; // en route: horizontal separation from tower walls is enough
const SAMPLE_M = 8;
const YAW_BLEND_S = 2.5;
const CAM_DEPRESSION_DEG = 55; // en-route gimbal (forward-down)
/** Deconfliction: per-drone lateral offset on shared corridors (m, right of track) and altitude layer (m). */
const LANE: Record<DroneId, number> = { D1: -14, D2: 0, D3: 14 };
const LAYER: Record<DroneId, number> = { D1: 0, D2: 10, D3: 20 };
const AIM_FAR = 260; // start turning the camera onto the target inside this distance
const AIM_NEAR = 150;
/** Parked heading: facing west (towards the city). */
export const PARK_HEADING = 1.5 * Math.PI;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export function normAngle(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
  return a + d * t;
}
function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
/** Heading (0 = north = -Z, clockwise +) of a horizontal direction. */
function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

// ── Trapezoid velocity profile (rest → v → rest) ──
export function trapDuration(D: number, v: number, a: number): number {
  const da = (v * v) / (2 * a);
  if (D >= 2 * da) return (2 * v) / a + (D - 2 * da) / v;
  return 2 * Math.sqrt(D / a);
}
export function trapDist(t: number, D: number, v: number, a: number): number {
  if (t <= 0) return 0;
  const da = (v * v) / (2 * a);
  let ta: number;
  let T: number;
  if (D >= 2 * da) {
    ta = v / a;
    T = 2 * ta + (D - 2 * da) / v;
    if (t >= T) return D;
    if (t < ta) return 0.5 * a * t * t;
    if (t < T - ta) return da + v * (t - ta);
  } else {
    ta = Math.sqrt(D / a);
    T = 2 * ta;
    if (t >= T) return D;
    if (t < ta) return 0.5 * a * t * t;
  }
  const r = T - t;
  return D - 0.5 * a * r * r;
}

// ── Roof clearance grid (max absolute roof height per 10 m cell, rasterised by footprint bbox) ──
export class Clearance {
  readonly cell = 10;
  private x0 = 0;
  private z0 = 0;
  private nx = 1;
  private nz = 1;
  private roof: Float32Array;

  constructor(buildings: BuildingRecord[]) {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const b of buildings)
      for (const [x, z] of b.footprint) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    const c = this.cell;
    this.x0 = minX - c;
    this.z0 = minZ - c;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / c) + 3);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / c) + 3);
    this.roof = new Float32Array(this.nx * this.nz).fill(-1e4);
    for (const b of buildings) {
      const top = b.baseElevation + b.height;
      let bx0 = Infinity;
      let bz0 = Infinity;
      let bx1 = -Infinity;
      let bz1 = -Infinity;
      for (const [x, z] of b.footprint) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (z < bz0) bz0 = z;
        if (z > bz1) bz1 = z;
      }
      const i0 = Math.floor((bx0 - this.x0) / c);
      const i1 = Math.floor((bx1 - this.x0) / c);
      const j0 = Math.floor((bz0 - this.z0) / c);
      const j1 = Math.floor((bz1 - this.z0) / c);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * this.nx + i;
          if (top > this.roof[k]) this.roof[k] = top;
        }
    }
  }

  /** Tallest roof (absolute m) within r of (x, z); -1e4 if none. */
  maxRoof(x: number, z: number, r: number): number {
    const c = this.cell;
    const rr = r + c * 0.71;
    const i0 = Math.max(0, Math.floor((x - rr - this.x0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x + rr - this.x0) / c));
    const j0 = Math.max(0, Math.floor((z - rr - this.z0) / c));
    const j1 = Math.min(this.nz - 1, Math.floor((z + rr - this.z0) / c));
    let m = -1e4;
    for (let j = j0; j <= j1; j++) {
      const cz = this.z0 + (j + 0.5) * c - z;
      for (let i = i0; i <= i1; i++) {
        const cx = this.x0 + (i + 0.5) * c - x;
        if (cx * cx + cz * cz > rr * rr) continue;
        const v = this.roof[j * this.nx + i];
        if (v > m) m = v;
      }
    }
    return m;
  }
}

export interface PlanEnv {
  terrain: Heightfield;
  clearance: Clearance;
  /** Building group key (parentId ?? id) → records, plus every record by its own id. */
  groups: Map<string, BuildingRecord[]>;
  /** Cache: 20 m route cell → extra altitude forced by roofs (m above terrain + AGL). */
  excessCache?: Map<number, number>;
}

export function groupBuildings(buildings: BuildingRecord[]): Map<string, BuildingRecord[]> {
  const g = new Map<string, BuildingRecord[]>();
  for (const b of buildings) {
    const key = b.parentId ?? b.id;
    let arr = g.get(key);
    if (!arr) g.set(key, (arr = []));
    arr.push(b);
  }
  // A part's own id resolves to the whole building too.
  for (const b of buildings) if (b.parentId && !g.has(b.id)) g.set(b.id, g.get(b.parentId)!);
  return g;
}

function groundSmooth(t: Heightfield, x: number, z: number): number {
  let s = groundAt(t, x, z) * 2;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    s += groundAt(t, x + 40 * Math.cos(a), z + 40 * Math.sin(a));
  }
  return s / 10;
}

/** Minimum safe cruise altitude (absolute m) over (x, z). */
export function requiredAltitude(env: PlanEnv, x: number, z: number, r = ROOF_RADIUS_TRANSIT): number {
  return Math.max(groundSmooth(env.terrain, x, z) + ALTITUDE_AGL, env.clearance.maxRoof(x, z, r) + ROOF_CLEAR);
}

// ── Low-altitude routing: Dijkstra on a 20 m grid, edge cost = length × (1 + roof-forced extra altitude / 20 m) ──
const RC = 20;
const ROUTE_MARGIN = 260;
const EXCESS_SCALE = 20;

function excessAt(env: PlanEnv, gi: number, gj: number): number {
  const cache = (env.excessCache ??= new Map());
  const key = (gi + 4000) * 8000 + (gj + 4000);
  let v = cache.get(key);
  if (v === undefined) {
    const x = (gi + 0.5) * RC;
    const z = (gj + 0.5) * RC;
    v = Math.max(0, env.clearance.maxRoof(x, z, ROOF_RADIUS_TRANSIT) + ROOF_CLEAR - (groundSmooth(env.terrain, x, z) + ALTITUDE_AGL));
    cache.set(key, v);
  }
  return v;
}
const excessXZ = (env: PlanEnv, x: number, z: number) => excessAt(env, Math.floor(x / RC), Math.floor(z / RC));

function maxExcessLine(env: PlanEnv, ax: number, az: number, bx: number, bz: number): number {
  const L = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(L / 8));
  let m = 0;
  for (let i = 0; i <= n; i++) m = Math.max(m, excessXZ(env, ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n));
  return m;
}

/** Polyline (flat x,z pairs) from a to b that avoids flying over towers when a cheap detour exists. */
export function routePath(env: PlanEnv, x0: number, z0: number, x1: number, z1: number): number[] {
  if (maxExcessLine(env, x0, z0, x1, z1) <= 6) return [x0, z0, x1, z1];
  const gx0 = Math.floor((Math.min(x0, x1) - ROUTE_MARGIN) / RC);
  const gx1 = Math.floor((Math.max(x0, x1) + ROUTE_MARGIN) / RC);
  const gz0 = Math.floor((Math.min(z0, z1) - ROUTE_MARGIN) / RC);
  const gz1 = Math.floor((Math.max(z0, z1) + ROUTE_MARGIN) / RC);
  const W = gx1 - gx0 + 1;
  const H = gz1 - gz0 + 1;
  const N = W * H;
  const ex = new Float32Array(N);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) ex[j * W + i] = excessAt(env, gx0 + i, gz0 + j);
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const cellOf = (x: number, z: number) => (Math.floor(z / RC) - gz0) * W + (Math.floor(x / RC) - gx0);
  const s = cellOf(x0, z0);
  const e = cellOf(x1, z1);
  // Binary heap of [cost, cell].
  const hc: number[] = [];
  const hn: number[] = [];
  const push = (c: number, n: number) => {
    let i = hc.length;
    hc.push(c);
    hn.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hc[p] <= hc[i]) break;
      [hc[p], hc[i]] = [hc[i], hc[p]];
      [hn[p], hn[i]] = [hn[i], hn[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = hn[0];
    const lc = hc.pop()!;
    const ln = hn.pop()!;
    if (hc.length) {
      hc[0] = lc;
      hn[0] = ln;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < hc.length && hc[l] < hc[m]) m = l;
        if (r < hc.length && hc[r] < hc[m]) m = r;
        if (m === i) break;
        [hc[m], hc[i]] = [hc[i], hc[m]];
        [hn[m], hn[i]] = [hn[i], hn[m]];
        i = m;
      }
    }
    return top;
  };
  dist[s] = 0;
  push(0, s);
  const NB: [number, number, number][] = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  while (hc.length) {
    const c = hc[0];
    const u = pop();
    if (c > dist[u]) continue;
    if (u === e) break;
    const ui = u % W;
    const uj = (u - ui) / W;
    for (const [di, dj, len] of NB) {
      const vi = ui + di;
      const vj = uj + dj;
      if (vi < 0 || vj < 0 || vi >= W || vj >= H) continue;
      const v = vj * W + vi;
      const nd = c + RC * len * (1 + (ex[u] + ex[v]) / (2 * EXCESS_SCALE));
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        push(nd, v);
      }
    }
  }
  if (prev[e] < 0 && e !== s) return [x0, z0, x1, z1];
  const cells: number[] = [];
  for (let c = e; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  const pts: number[] = [];
  for (const c of cells) {
    const i = c % W;
    const j = (c - i) / W;
    pts.push((gx0 + i + 0.5) * RC, (gz0 + j + 0.5) * RC);
  }
  pts[0] = x0;
  pts[1] = z0;
  pts[pts.length - 2] = x1;
  pts[pts.length - 1] = z1;
  // Shortcut: jump to the farthest point whose straight line costs no more than the path it replaces.
  const m = pts.length / 2;
  const cum = cells.map((c) => dist[c]);
  const lineCost = (ax: number, az: number, bx: number, bz: number) => {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / 8));
    let c = 0;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      c += (L / n) * (1 + excessXZ(env, ax + (bx - ax) * u, az + (bz - az) * u) / EXCESS_SCALE);
    }
    return c;
  };
  const simp: number[] = [pts[0], pts[1]];
  let i = 0;
  while (i < m - 1) {
    let best = i + 1;
    for (let j = i + 2; j < m; j++) {
      if (lineCost(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]) <= cum[j] - cum[i] + RC * 0.5) best = j;
    }
    simp.push(pts[best * 2], pts[best * 2 + 1]);
    i = best;
  }
  // Chaikin corner cutting (2 passes), endpoints kept.
  let poly = simp;
  for (let pass = 0; pass < 2; pass++) {
    const k = poly.length / 2;
    if (k < 3) break;
    const nx: number[] = [poly[0], poly[1]];
    for (let q = 0; q < k - 1; q++) {
      const ax = poly[q * 2];
      const az = poly[q * 2 + 1];
      const bx = poly[q * 2 + 2];
      const bz = poly[q * 2 + 3];
      if (q > 0) nx.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25);
      if (q < k - 2) nx.push(ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
    }
    nx.push(poly[poly.length - 2], poly[poly.length - 1]);
    poly = nx;
  }
  return poly;
}

export interface TargetInfo {
  buildingId: string;
  cx: number;
  cz: number;
  roofY: number;
  midY: number;
  /** Max distance centre → footprint vertex. */
  radius: number;
}

export function targetInfo(env: PlanEnv, id: string): TargetInfo | null {
  const recs = env.groups.get(id);
  if (!recs || !recs.length) return null;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  let roof = -Infinity;
  let base = Infinity;
  for (const b of recs) {
    for (const [x, z] of b.footprint) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    roof = Math.max(roof, b.baseElevation + b.height);
    base = Math.min(base, b.baseElevation);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  let r = 0;
  for (const b of recs) for (const [x, z] of b.footprint) r = Math.max(r, Math.hypot(x - cx, z - cz));
  return { buildingId: id, cx, cz, roofY: roof, midY: base + (roof - base) * 0.5, radius: r };
}

// ── Segments ──
interface SegBase {
  phase: DronePhase;
  t0: number;
  t1: number;
  /** Heading at the end of the previous segment (yaw blend). */
  h0: number;
  targetIndex?: number;
}
interface VertSeg extends SegBase {
  kind: 'vert';
  x: number;
  z: number;
  y0: number;
  y1: number;
  h1: number;
}
interface LineSeg extends SegBase {
  kind: 'line';
  L: number;
  step: number;
  /** Uniform samples along the routed polyline (every `step` m). */
  xs: Float32Array;
  zs: Float32Array;
  ys: Float32Array;
  hs: Float32Array;
  /** Building the leg flies to (camera turns onto it when close). */
  aim?: TargetInfo;
}
interface OrbitSeg extends SegBase {
  kind: 'orbit';
  cx: number;
  cz: number;
  R: number;
  a0: number;
  dir: 1 | -1;
  arc: number;
  y: number;
  camY: number;
}
type Seg = VertSeg | LineSeg | OrbitSeg;

export interface PlannedTarget extends TargetInfo {
  arriveS: number;
  leaveS: number;
}

export interface FlightPlan {
  missionId: string;
  droneId: DroneId;
  wave: 1 | 2;
  assignedAt: number;
  startS: number;
  endS: number;
  segs: Seg[];
  targets: PlannedTarget[];
  pad: [number, number, number];
  /** Visual path polyline (x,y,z triplets) and the sim time of each point. */
  pathPts: number[];
  pathT: number[];
}

/** Raw sample of a drone at a sim time (no footprint). */
export interface RawState {
  x: number;
  y: number;
  z: number;
  heading: number;
  phase: DronePhase;
  airborne: boolean;
  missionId?: string;
  targetIndex?: number;
  flightS: number;
  /** Camera aim point. */
  cx: number;
  cy: number;
  cz: number;
}

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = new THREE.Vector3();

export function planMission(env: PlanEnv, m: DroneMission, startS: number, assignedAt: number, orbitS = ORBIT_S): FlightPlan | null {
  const targetsInfo = m.targetBuildingIds.map((id) => targetInfo(env, id)).filter((t): t is TargetInfo => !!t);
  if (!targetsInfo.length) return null;
  const off = PAD_OFFSET[m.droneId];
  const padX = BASE[0] + off[0];
  const padZ = BASE[1] + off[1];
  const padY = groundAt(env.terrain, padX, padZ);
  const lane = LANE[m.droneId];
  const layer = LAYER[m.droneId];
  const cruisePad = Math.max(requiredAltitude(env, padX, padZ), padY + 30) + layer;
  const orbitArc = ORBIT_V * (orbitS - ORBIT_V / ORBIT_ACCEL);

  const segs: Seg[] = [];
  const targets: PlannedTarget[] = [];
  let t = startS;
  let h = PARK_HEADING;
  let px = padX;
  let pz = padZ;
  let py = cruisePad;

  const pushVert = (x: number, z: number, y0: number, y1: number, h1: number, phase: DronePhase, ti?: number) => {
    const d = Math.abs(y1 - y0);
    if (d < 0.5) return;
    const dur = trapDuration(d, CLIMB_MS, CLIMB_ACCEL);
    segs.push({ kind: 'vert', phase, t0: t, t1: t + dur, h0: h, h1, x, z, y0, y1, targetIndex: ti });
    t += dur;
    h = h1;
  };

  const pushLine = (x1: number, z1: number, y1: number, phase: DronePhase, ti?: number, aim?: TargetInfo) => {
    const x0 = px;
    const z0 = pz;
    const y0 = py;
    const L0 = Math.hypot(x1 - x0, z1 - z0);
    if (L0 < 1) {
      pushVert(x0, z0, y0, y1, h, phase, ti);
      px = x1;
      pz = z1;
      py = y1;
      return;
    }
    // Low-altitude route (around towers), resampled uniformly.
    let poly = routePath(env, x0, z0, x1, z1);
    // Integration fix: a degenerate route (both ends in one grid cell → a single point) made L = 0 and the
    // samples NaN (wave-2 missions with adjacent targets froze the app). Fall back to the straight leg.
    if (poly.length < 4 || poly.some((v) => !Number.isFinite(v))) poly = [x0, z0, x1, z1];
    const cum = [0];
    for (let i = 2; i < poly.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(poly[i] - poly[i - 2], poly[i + 1] - poly[i - 1]));
    const L = cum[cum.length - 1];
    const n = Math.max(2, Math.ceil(L / SAMPLE_M));
    const step = L / n;
    const xs = new Float32Array(n + 1);
    const zs = new Float32Array(n + 1);
    let seg = 0;
    for (let i = 0; i <= n; i++) {
      const d = i * step;
      while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
      const f = Math.min(1, Math.max(0, (d - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg])));
      xs[i] = poly[seg * 2] + (poly[seg * 2 + 2] - poly[seg * 2]) * f;
      zs[i] = poly[seg * 2 + 1] + (poly[seg * 2 + 3] - poly[seg * 2 + 1]) * f;
    }
    const hs = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const a = Math.max(0, i - 1);
      const c = Math.min(n, i + 1);
      hs[i] = headingOf(xs[c] - xs[a], zs[c] - zs[a]);
    }
    // Lane offset (to the right of track), tapered to 0 at both ends so endpoints stay exact.
    if (lane !== 0) {
      for (let i = 0; i <= n; i++) {
        const d = i * step;
        const w = smooth01(Math.min(d, L - d) / 60) * lane;
        xs[i] += Math.cos(hs[i]) * w;
        zs[i] += Math.sin(hs[i]) * w;
      }
    }
    const raw = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) raw[i] = Math.max(y0 + (y1 - y0) * (i / n), requiredAltitude(env, xs[i], zs[i]) + layer);
    // Running max (±W) then box mean (±W): smooth, and never below raw (every window of the mean contains i).
    const W = 5;
    const mx = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let v = -Infinity;
      for (let j = Math.max(0, i - W); j <= Math.min(n, i + W); j++) v = Math.max(v, raw[j]);
      mx[i] = v;
    }
    const ys = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      let sum = 0;
      let c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n, i + W); j++) {
        sum += mx[j];
        c++;
      }
      ys[i] = sum / c;
    }
    // Endpoints: smoothing only raises; adjust vertically at the ends.
    pushVert(x0, z0, y0, ys[0], hs[0], phase, ti);
    if (Math.abs(ys[0] - y0) < 0.5) ys[0] = y0;
    const dur = trapDuration(L, SPEED_MS, ACCEL);
    segs.push({ kind: 'line', phase, t0: t, t1: t + dur, h0: h, L, step, xs, zs, ys, hs, targetIndex: ti, aim });
    t += dur;
    h = hs[n];
    px = x1;
    pz = z1;
    py = ys[n];
    if (Math.abs(ys[n] - y1) >= 0.5) pushVert(x1, z1, ys[n], y1, h, phase, ti);
    py = y1;
  };

  const endurance = startS + ENDURANCE_S;
  for (let k = 0; k < targetsInfo.length; k++) {
    const tg = targetsInfo[k];
    const R = Math.min(130, Math.max(ORBIT_RADIUS, tg.radius + 35));
    const arcRad = orbitArc / R;
    // Endurance check (rough) before committing to targets after the first.
    if (k > 0) {
      const dIn = Math.hypot(tg.cx - px, tg.cz - pz);
      const dBack = Math.hypot(tg.cx - padX, tg.cz - padZ);
      if (t + (dIn + dBack) / SPEED_MS * 1.25 + orbitS + 40 > endurance) break;
    }
    // Choose orbit start angle + direction: low arc, near the approach direction.
    const thetaA = Math.atan2(pz - tg.cz, px - tg.cx);
    let best: { a0: number; dir: 1 | -1; y: number; cost: number } | null = null;
    for (let kk = 0; kk < 8; kk++) {
      const off2 = (kk % 2 === 0 ? 1 : -1) * Math.ceil(kk / 2) * (Math.PI / 4);
      const a0 = thetaA + off2;
      for (const dir of [1, -1] as const) {
        let maxReq = -Infinity;
        for (let s = 0; s <= 8; s++) {
          const a = a0 + (dir * arcRad * s) / 8;
          maxReq = Math.max(maxReq, requiredAltitude(env, tg.cx + R * Math.cos(a), tg.cz + R * Math.sin(a), ROOF_RADIUS));
        }
        const ex = tg.cx + R * Math.cos(a0);
        const ez = tg.cz + R * Math.sin(a0);
        const cost = maxReq + 0.04 * Math.hypot(ex - px, ez - pz) + kk * 0.5 + (dir === 1 ? 0 : 0.1);
        if (!best || cost < best.cost) best = { a0, dir, y: maxReq, cost };
      }
    }
    const { a0, dir } = best!;
    const y = best!.y + layer;
    const ex = tg.cx + R * Math.cos(a0);
    const ez = tg.cz + R * Math.sin(a0);
    if (k === 0) {
      // Climb off the pad, yawing toward the first leg.
      pushVert(padX, padZ, padY, cruisePad, headingOf(ex - padX, ez - padZ), 'transit', 0);
    }
    pushLine(ex, ez, y, 'transit', k, tg);
    const arriveS = t;
    segs.push({ kind: 'orbit', phase: 'orbit', t0: t, t1: t + orbitS, h0: h, cx: tg.cx, cz: tg.cz, R, a0, dir, arc: orbitArc, y, camY: tg.midY, targetIndex: k });
    t += orbitS;
    const aEnd = a0 + dir * arcRad;
    px = tg.cx + R * Math.cos(aEnd);
    pz = tg.cz + R * Math.sin(aEnd);
    py = y;
    h = headingOf(tg.cx - px, tg.cz - pz);
    targets.push({ ...tg, arriveS, leaveS: t });
  }
  // Return to the pad and land.
  pushLine(padX, padZ, cruisePad, 'return');
  pushVert(padX, padZ, cruisePad, padY, PARK_HEADING, 'return');

  const plan: FlightPlan = {
    missionId: m.id,
    droneId: m.droneId,
    wave: m.wave,
    assignedAt,
    startS,
    endS: t,
    segs,
    targets,
    pad: [padX, padY, padZ],
    pathPts: [],
    pathT: [],
  };
  // Integration guard: never build a path for a broken plan (the loop below would never end).
  if (!Number.isFinite(plan.endS) || plan.endS - startS > 10 * ENDURANCE_S) {
    console.warn(`[drones] ${m.id}: invalid flight plan (endS ${plan.endS}); mission skipped`);
    return null;
  }
  // Visual path: sample every 0.5 s.
  const st = {} as RawState;
  for (let s = startS; ; s += 0.5) {
    const tt = Math.min(s, plan.endS);
    samplePlan(env, plan, tt, st, false);
    plan.pathPts.push(st.x, st.y + 0.3, st.z);
    plan.pathT.push(tt);
    if (tt >= plan.endS) break;
  }
  return plan;
}

function segAt(plan: FlightPlan, simS: number): Seg {
  const segs = plan.segs;
  for (let i = 0; i < segs.length; i++) if (simS < segs[i].t1) return segs[i];
  return segs[segs.length - 1];
}

/** Sample a plan at simS (assumed within [startS, endS]). withCam: compute the camera aim point. */
export function samplePlan(env: PlanEnv, plan: FlightPlan, simS: number, out: RawState, withCam = true): RawState {
  const seg = segAt(plan, simS);
  const lt = Math.min(Math.max(simS - seg.t0, 0), seg.t1 - seg.t0);
  out.phase = seg.phase;
  out.missionId = plan.missionId;
  out.targetIndex = seg.targetIndex;
  out.flightS = simS - plan.startS;
  out.airborne = true;
  let camMode: 'fwd' | 'target' = 'fwd';
  let aim: { x: number; y: number; z: number } | null = null;
  let aimW = 0;
  if (seg.kind === 'vert') {
    const d = trapDist(lt, Math.abs(seg.y1 - seg.y0), CLIMB_MS, CLIMB_ACCEL);
    out.x = seg.x;
    out.z = seg.z;
    out.y = seg.y0 + Math.sign(seg.y1 - seg.y0) * d;
    out.heading = lerpAngle(seg.h0, seg.h1, smooth01(lt / Math.max(0.01, seg.t1 - seg.t0)));
  } else if (seg.kind === 'line') {
    const d = trapDist(lt, seg.L, SPEED_MS, ACCEL);
    const fi = d / seg.step;
    const i = Math.min(seg.ys.length - 2, Math.floor(fi));
    const f = Math.min(1, fi - i);
    out.x = seg.xs[i] + (seg.xs[i + 1] - seg.xs[i]) * f;
    out.z = seg.zs[i] + (seg.zs[i + 1] - seg.zs[i]) * f;
    out.y = seg.ys[i] + (seg.ys[i + 1] - seg.ys[i]) * f;
    out.heading = lerpAngle(seg.h0, lerpAngle(seg.hs[i], seg.hs[i + 1], f), smooth01(lt / YAW_BLEND_S));
    if (seg.aim) {
      const dist = Math.hypot(seg.aim.cx - out.x, seg.aim.cz - out.z);
      aimW = smooth01((AIM_FAR - dist) / (AIM_FAR - AIM_NEAR));
      if (aimW > 0) aim = { x: seg.aim.cx, y: seg.aim.midY, z: seg.aim.cz };
    }
  } else {
    const arc = trapDist(lt, seg.arc, ORBIT_V, ORBIT_ACCEL);
    const a = seg.a0 + (seg.dir * arc) / seg.R;
    out.x = seg.cx + seg.R * Math.cos(a);
    out.z = seg.cz + seg.R * Math.sin(a);
    out.y = seg.y;
    out.heading = lerpAngle(seg.h0, headingOf(seg.cx - out.x, seg.cz - out.z), smooth01(lt / YAW_BLEND_S));
    camMode = 'target';
    aim = { x: seg.cx, y: seg.camY, z: seg.cz };
  }
  out.heading = normAngle(out.heading);
  if (!withCam) {
    out.cx = out.x;
    out.cy = out.y;
    out.cz = out.z;
    return out;
  }
  if (camMode === 'target' && aim) {
    out.cx = aim.x;
    out.cy = aim.y;
    out.cz = aim.z;
    return out;
  }
  // Forward-down gimbal, blended onto the approaching target.
  const dep = CAM_DEPRESSION_DEG * DEG;
  _eye.set(out.x, out.y - 0.15, out.z);
  _dir.set(Math.sin(out.heading) * Math.cos(dep), -Math.sin(dep), -Math.cos(out.heading) * Math.cos(dep));
  rayGround(env.terrain, _eye, _dir, 900, _hit);
  out.cx = _hit.x;
  out.cy = _hit.y;
  out.cz = _hit.z;
  if (aim && aimW > 0) {
    out.cx += (aim.x - out.cx) * aimW;
    out.cy += (aim.y - out.cy) * aimW;
    out.cz += (aim.z - out.cz) * aimW;
  }
  return out;
}

/** Parked state on the pad. */
export function parkedState(env: PlanEnv, id: DroneId, phase: DronePhase, out: RawState): RawState {
  const off = PAD_OFFSET[id];
  const x = BASE[0] + off[0];
  const z = BASE[1] + off[1];
  out.x = x;
  out.z = z;
  out.y = groundAt(env.terrain, x, z);
  out.heading = PARK_HEADING;
  out.phase = phase;
  out.airborne = false;
  out.missionId = undefined;
  out.targetIndex = undefined;
  out.flightS = 0;
  out.cx = x + Math.sin(PARK_HEADING) * 15;
  out.cz = z - Math.cos(PARK_HEADING) * 15;
  out.cy = groundAt(env.terrain, out.cx, out.cz);
  return out;
}

/** Footprint rays in NDC around the frame (same ordering as AIR 1). */
const NDC_RING: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _tgt = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Camera frustum ∩ terrain (8-point ring, world x/z). */
export function footprintFor(terrain: Heightfield, s: RawState): XZ[] {
  if (!s.airborne) {
    const r = 1.5;
    return NDC_RING.map(([a, b]) => [s.cx + a * r, s.cz + b * r] as XZ);
  }
  const tanV = Math.tan((CAM_FOV_DEG * DEG) / 2);
  const tanH = tanV * CAM_ASPECT;
  _eye.set(s.x, s.y - 0.15, s.z);
  _tgt.set(s.cx, s.cy, s.cz);
  _m.lookAt(_eye, _tgt, _up);
  _right.setFromMatrixColumn(_m, 0);
  _camUp.setFromMatrixColumn(_m, 1);
  _fwd.setFromMatrixColumn(_m, 2).negate();
  const out: XZ[] = [];
  for (const [sx, sy] of NDC_RING) {
    _dir.copy(_fwd).addScaledVector(_right, sx * tanH).addScaledVector(_camUp, sy * tanV);
    if (_dir.y > -0.05) _dir.y = -0.05;
    rayGround(terrain, _eye, _dir, 900, _hit);
    out.push([_hit.x, _hit.z]);
  }
  return out;
}
