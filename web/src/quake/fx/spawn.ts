/**
 * Turns a QuakeResult into debris / dust emitters (CPU, once per quake; deterministic per building).
 *
 *   collapsed groups   → rubble mound over the footprint spilling out to debrisRadius (biased toward the lean
 *                        direction), pile chunks rising with the mound, chunks thrown off the falling facades,
 *                        a ground-hugging dust surge that billows up and drifts downwind for 35–90 s.
 *   extensive/complete → facade / parapet fragments shed onto the pavement (more for masonry), dust puffs.
 *   road blockages     → an elongated pile on the carriageway exactly at RoadBlockage.at, sized by coverage,
 *                        fed by chunks flying from the cause building.
 *   damaged towers     → glass shards fluttering down and glittering on the street; storefront glass.
 *   strong shaking     → dust shaken off old roofs as the S wave passes (makes the front visible in 3D).
 */
import * as THREE from 'three';
import type { AppContext, QuakeResult, RoadRecord, XZ } from '../../contracts';
import type { ChunkSpec, MoundData, ShardSpec } from './debris';
import { closestOnRing, pointInRing, pointOnRing, ringBounds, signedDistance } from './geom2d';
import { HIDE_CF, leaderOf, ruinShape, ruinSwapTime } from './rules';
import { RoadIndex } from './roadIndex';
import { siteKm, siteTiming, sourceContext } from '../model/timing';
import { unproject } from '../../geo';
import type { ParticleSpec } from './particles';
import { Family, type CityPrep, type GroupInfo } from './prep';
import { G, collapseDuration } from './timeline';
import { hashStr, mulberry32, range, type Rng } from './rng';

export const CHUNK_CAP = 60000;
export const SHARD_CAP = 7000;
export const DUST_CAP = 30000;
export { HIDE_CF };

export interface GroupFail {
  g: number;
  leader: number;
  state: number;
  collapsed: boolean;
  cf: number;
  tf: number;
  tc: number;
  leanDir: number;
  debrisR: number;
  sA: number;
  pga: number;
  fire: boolean;
  /** Model lean angle (rad) and the time the building's extrusion is swapped for its ruin (end of the fall). */
  leanAngle: number;
  hideAt: number;
}

export interface SpawnResult {
  chunks: ChunkSpec[];
  shards: ShardSpec[];
  mound: MoundData;
  dust: ParticleSpec[];
  /** Collapse sites for haze / audio / markers: x, z, time, dust mass. */
  collapses: { x: number; z: number; t: number; mass: number; top: number; g: number; R: number }[];
  fails: GroupFail[];
}

// Linear-space reference colours.
const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const BRICK = lin(0x8e4a35);
const BRICK_DK = lin(0x5e2f22);
const MORTAR = lin(0xa39784);
const CONCRETE = lin(0x8a867e);
const DUST = lin(0xab9f8a);
const WOOD = lin(0x7a5638);
const STEEL = lin(0x3a3532);
const SLAB = lin(0x85817a);

const tmpC = new THREE.Color();

function chunkColour(g: GroupInfo, r: Rng, kind: number): [number, number, number] {
  let c: THREE.Color;
  if (kind === 1) c = tmpC.copy(g.family === Family.Wood ? WOOD : SLAB);
  else if (kind === 2) c = tmpC.copy(g.family === Family.Wood || g.family === Family.Brick ? WOOD : STEEL);
  else {
    switch (g.family) {
      case Family.Brick: {
        const u = r();
        c = tmpC.copy(u < 0.45 ? BRICK : u < 0.75 ? BRICK_DK : u < 0.88 ? MORTAR : g.wall);
        break;
      }
      case Family.Stucco:
        c = tmpC.copy(r() < 0.4 ? g.wall : r() < 0.6 ? MORTAR : r() < 0.5 ? CONCRETE : WOOD);
        break;
      case Family.Wood:
        c = tmpC.copy(r() < 0.55 ? g.wall : WOOD);
        break;
      case Family.Glass:
      case Family.Metal:
        c = tmpC.copy(r() < 0.7 ? CONCRETE : STEEL);
        break;
      default:
        c = tmpC.copy(r() < 0.45 ? g.wall : r() < 0.7 ? CONCRETE : MORTAR);
    }
  }
  const v = 0.6 + 0.32 * r();
  const d = 0.25 + 0.35 * r(); // dust coating
  return [(c.r * (1 - d) + DUST.r * d) * v, (c.g * (1 - d) + DUST.g * d) * v, (c.b * (1 - d) + DUST.b * d) * v];
}

const DUST_LIGHT = lin(0xb3a996);
function dustColour(g: GroupInfo, r: Rng): [number, number, number] {
  // Pulverised plaster, mortar and concrete: pale grey-beige, only tinted by the facade it came from.
  const base = g.family === Family.Brick ? tmpC.copy(BRICK).lerp(DUST_LIGHT, 0.8) : tmpC.copy(g.wall).lerp(DUST_LIGHT, 0.82);
  const v = 0.88 + 0.2 * r();
  return [base.r * v, base.g * v, base.b * v];
}

/** Uniform random point inside a ring (rejection sampling in the bbox). */
function pointInside(ring: XZ[], r: Rng): XZ {
  const [x0, z0, x1, z1] = ringBounds(ring);
  for (let k = 0; k < 24; k++) {
    const x = range(r, x0, x1);
    const z = range(r, z0, z1);
    if (pointInRing(x, z, ring)) return [x, z];
  }
  return [(x0 + x1) / 2, (z0 + z1) / 2];
}

const logRange = (r: Rng, a: number, b: number) => a * Math.pow(b / a, r());

function randomAxis(r: Rng): [number, number, number] {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

export function spawnAll(ctx: AppContext, prep: CityPrep, result: QuakeResult): SpawnResult {
  const B = ctx.city.buildings;
  const terrain = ctx.terrain;
  const fails: GroupFail[] = prep.groups.map((grp, g) => {
    const L = leaderOf(result, grp.members, B);
    const d = result.damage[L];
    const s = result.shaking[grp.tallest];
    return {
      g,
      leader: L,
      state: d.state,
      collapsed: d.collapsed,
      cf: d.collapseFraction,
      tf: d.failTimeS,
      tc: collapseDuration(grp.height, d.collapseFraction),
      leanDir: d.leanDirection,
      debrisR: d.debrisRadius,
      sA: s.sArrivalS,
      pga: s.pgaG,
      fire: grp.members.some((i) => result.damage[i].fire),
      leanAngle: d.leanAngle,
      hideAt: d.collapsed ? ruinSwapTime(d.failTimeS, collapseDuration(grp.height, d.collapseFraction)) : Infinity,
    };
  });
  const roadIx = new RoadIndex(ctx.city.roads);

  const groundFn = (grp: GroupInfo) => {
    const over = B[grp.rep].overWater;
    return over ? (_x: number, _z: number) => grp.base : (x: number, z: number) => terrain.heightAt(x, z);
  };

  // ── Budget: estimate desired counts first, then scale to the caps. ──
  const roadById = new Map<string, RoadRecord>();
  for (const r of ctx.city.roads) roadById.set(r.id, r);
  const idIndex = new Map<string, number>();
  B.forEach((b, i) => idIndex.set(b.id, i));

  const wantCollapse = (f: GroupFail) => {
    const grp = prep.groups[f.g];
    const R = Math.max(3, f.debrisR);
    const heapArea = prep.area[grp.rep] + prep.perimeter[grp.rep] * R * 0.55;
    return THREE.MathUtils.clamp(heapArea / 1.6, 90, 1100);
  };
  const wantFacade = (f: GroupFail) => {
    const grp = prep.groups[f.g];
    const fam = grp.family === Family.Brick ? 1.7 : grp.family === Family.Glass || grp.family === Family.Metal ? 0.5 : 1;
    // The apron mound carries the debris signal; chunks only add relief (kept low: ~2.7k standing damaged buildings).
    const k = f.state === 2 ? 0.045 : f.state === 3 ? 0.11 : 0.2;
    return THREE.MathUtils.clamp(prep.perimeter[grp.rep] * k * fam, 3, 40);
  };
  let want = 0;
  for (const f of fails) {
    if (f.collapsed) want += wantCollapse(f);
    else if (f.state >= 2) want += wantFacade(f);
  }
  for (const rb of result.roads) want += 4 + 15 * rb.coverage;
  const chunkScale = Math.min(1, CHUNK_CAP / Math.max(1, want));

  const chunks: ChunkSpec[] = [];
  const shards: ShardSpec[] = [];
  const dust: ParticleSpec[] = [];
  const mound: MoundData = { positions: [], ground: [], colors: [], grow: [], indices: [] };
  const collapses: SpawnResult['collapses'] = [];

  const pushChunk = (
    r: Rng,
    grp: GroupInfo,
    kind: 0 | 1 | 2,
    rest: [number, number, number],
    t0: number,
    launch: [number, number, number] | null,
    sizeK = 1,
    extra?: { scale: [number, number, number]; quat: THREE.Quaternion; dark?: number },
  ) => {
    let sx: number;
    let sy: number;
    let sz: number;
    if (extra) {
      [sx, sy, sz] = extra.scale;
    } else if (kind === 0) {
      const s = logRange(r, 0.16, 1.25) * sizeK;
      sx = s * range(r, 0.7, 1.3);
      sy = s * range(r, 0.5, 1.0);
      sz = s * range(r, 0.7, 1.3);
    } else if (kind === 1) {
      sx = range(r, 1.2, 3.8) * sizeK;
      sy = range(r, 0.18, 0.38);
      sz = range(r, 0.9, 2.6) * sizeK;
    } else {
      sx = range(r, 0.1, 0.22);
      sy = range(r, 0.1, 0.22);
      sz = range(r, 1.6, 5.5) * Math.min(1.3, sizeK);
    }
    const [ax, ay, az] = randomAxis(r);
    let [cr, cg, cb] = chunkColour(grp, r, kind);
    if (extra?.dark) {
      cr *= extra.dark;
      cg *= extra.dark;
      cb *= extra.dark;
    }
    let T = 0;
    let x0 = rest[0];
    let y0 = rest[1];
    let z0 = rest[2];
    if (launch) {
      [x0, y0, z0] = launch;
      const vy0 = range(r, 0, 3.5);
      const drop = Math.max(0.1, y0 - rest[1]);
      T = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * drop)) / G;
    }
    // Rest slightly embedded so nothing floats on the mound.
    const restY = extra ? rest[1] : rest[1] - (kind === 0 ? sy * 0.35 : kind === 1 ? sy * 0.2 : 0.05);
    // Slabs and sticks settle closer to flat.
    let angle = kind === 0 ? r() * Math.PI * 2 : range(r, -0.5, 0.5);
    let axis: [number, number, number] = kind === 0 ? [ax, ay, az] : [ax, ay * 0.25, az];
    if (extra) {
      const q = extra.quat;
      const w = Math.min(1, Math.max(-1, q.w));
      angle = 2 * Math.acos(w);
      const sn = Math.sqrt(1 - w * w);
      axis = sn < 1e-5 ? [0, 1, 0] : [q.x / sn, q.y / sn, q.z / sn];
    }
    chunks.push({
      kind,
      x0,
      y0,
      z0,
      t0,
      x1: rest[0],
      y1: restY,
      z1: rest[2],
      T,
      sx,
      sy,
      sz,
      ax: axis[0],
      ay: axis[1],
      az: axis[2],
      angle,
      spin: range(r, -5, 5),
      r: cr,
      g: cg,
      b: cb,
    });
  };

  const kindPick = (r: Rng, grp: GroupInfo): 0 | 1 | 2 => {
    const u = r();
    const slabP = grp.family === Family.Wood ? 0.1 : 0.16;
    const stickP = grp.family === Family.Wood || grp.family === Family.Brick ? 0.14 : 0.09;
    return u < slabP ? 1 : u < slabP + stickP ? 2 : 0;
  };

  /**
   * Pancake collapse remnant: storey layers of broken floor slabs, aligned with the footprint's main axis,
   * stacked with tilts and offsets (the iconic look of a pancaked frame), protruding from the rubble mound.
   */
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const ax3 = new THREE.Vector3();
  const pancakeStack = (
    r: Rng,
    grp: GroupInfo,
    f: GroupFail,
    ring: XZ[],
    stackH: number,
    ground: (x: number, z: number) => number,
    t0: number,
    y0 = 0,
    inset = 0.8,
  ) => {
    // Principal axis = direction of the longest edge.
    let best = 0;
    let yaw = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ex = ring[i][0] - ring[j][0];
      const ez = ring[i][1] - ring[j][1];
      const l = ex * ex + ez * ez;
      if (l > best) {
        best = l;
        yaw = Math.atan2(ez, ex);
      }
    }
    const ux = Math.cos(yaw);
    const uz = Math.sin(yaw);
    // Extent in the principal frame.
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    const cx = prep.cx[grp.rep];
    const cz = prep.cz[grp.rep];
    for (const [x, z] of ring) {
      const a = (x - cx) * ux + (z - cz) * uz;
      const b = -(x - cx) * uz + (z - cz) * ux;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      b0 = Math.min(b0, b);
      b1 = Math.max(b1, b);
    }
    const LA = a1 - a0;
    const LB = b1 - b0;
    const na = Math.max(1, Math.min(6, Math.round(LA / 9)));
    const nb = Math.max(1, Math.min(6, Math.round(LB / 9)));
    const cellA = LA / na;
    const cellB = LB / nb;
    const wood = grp.family === Family.Wood;
    const levels = Math.max(1, Math.min(12, Math.round(stackH / (wood ? 1.0 : 1.25))));
    const spacing = stackH / levels;
    const thick = wood ? 0.32 : 0.42;
    // Whole stack leans toward the failure direction.
    const lx = Math.cos(f.leanDir);
    const lz = Math.sin(f.leanDir);
    for (let L = 0; L < levels; L++) {
      const drift = (L / Math.max(1, levels - 1)) * Math.min(3, LA * 0.08);
      for (let ia = 0; ia < na; ia++)
        for (let ib = 0; ib < nb; ib++) {
          if (r() < 0.12) continue; // missing / shattered piece
          const a = a0 + (ia + 0.5) * cellA + range(r, -0.6, 0.6);
          const b = b0 + (ib + 0.5) * cellB + range(r, -0.6, 0.6);
          let x = cx + a * ux - b * uz + lx * drift;
          let z = cz + a * uz + b * ux + lz * drift;
          if (!pointInRing(x, z, ring)) {
            // Pull edge pieces back inside.
            x = cx + (x - cx) * inset;
            z = cz + (z - cz) * inset;
          }
          const y = ground(x, z) + y0 + (L + 0.6) * spacing + range(r, -0.25, 0.25);
          // Each bay's slab breaks at mid-span and sags into a shallow V: two halves tilted toward each other.
          const splitA = cellA > cellB;
          const half = (splitA ? cellA : cellB) / 2;
          const sag = range(r, 0.08, 0.32) * (L === levels - 1 ? 1.5 : 1);
          const yawJ = -yaw + range(r, -0.1, 0.1);
          for (const side of [-1, 1]) {
            if (r() < 0.08) continue;
            const off = side * half * 0.5;
            const px = x + (splitA ? ux : -uz) * off;
            const pz = z + (splitA ? uz : ux) * off;
            qa.setFromAxisAngle(ax3.set(0, 1, 0), yawJ);
            // Hinge axis: horizontal, perpendicular to the split direction (in world space).
            const hx = splitA ? -uz : ux;
            const hz = splitA ? ux : uz;
            qb.setFromAxisAngle(ax3.set(hx, 0, hz), -side * sag + range(r, -0.06, 0.06));
            qb.multiply(qa);
            const sa = splitA ? half * range(r, 0.85, 1.0) : cellA * range(r, 0.8, 1.0);
            const sb = splitA ? cellB * range(r, 0.8, 1.0) : half * range(r, 0.85, 1.0);
            pushChunk(r, grp, 1, [px, y - Math.sin(sag) * half * 0.35, pz], t0 + range(r, 0, 0.8), null, 1, {
              scale: [sa, thick * range(r, 0.8, 1.35), sb],
              quat: qb.clone(),
              dark: L < levels - 1 ? 0.55 : 0.78,
            });
          }
        }
      // Crushed storey contents between slabs.
      const nr = Math.round(na * nb * 5);
      for (let k = 0; k < nr; k++) {
        const a = range(r, a0, a1);
        const b = range(r, b0, b1);
        const x = cx + a * ux - b * uz + lx * drift;
        const z = cz + a * uz + b * ux + lz * drift;
        if (!pointInRing(x, z, ring)) continue;
        pushChunk(r, grp, r() < 0.8 ? 0 : 2, [x, ground(x, z) + y0 + L * spacing + spacing * 0.55, z], t0 + range(r, 0, 1), null, 1.2);
      }
    }
  };

  /**
   * Debris apron of a standing damaged building: a low rubble strip hugging its own footprint (built as a ring
   * strip, not a grid, so ~3k buildings stay cheap), spilling further on the lean side. Moderate: a patchy 1.5–3 m
   * skirt on the sidewalk; extensive: a continuous 3.5–6 m apron into the street; complete: 5–9 m, heavy.
   * Strips are tapered at convex corners so they never spread in front of the neighbours. Returns the width.
   */
  const buildApron = (f: GroupFail, grp: GroupInfo, ring: XZ[], ground: (x: number, z: number) => number, r: Rng): number => {
    const st = f.state;
    const wBase = st === 2 ? range(r, 1.5, 2.6) : st === 3 ? range(r, 3.5, 5.0) : range(r, 5.0, 7.5);
    const W = Math.min(st === 2 ? 3 : st === 3 ? 6.5 : 9.5, Math.max(wBase, f.debrisR * (st === 2 ? 0.5 : 0.8)));
    const hPk = st === 2 ? range(r, 0.45, 0.7) : st === 3 ? range(r, 0.8, 1.2) : range(r, 1.2, 1.9);
    const lx = Math.cos(f.leanDir);
    const lz = Math.sin(f.leanDir);
    const n = ring.length;
    if (n < 3) return W;
    // Ring orientation: outward normal of edge (a → b) is (dz, −dx) for CCW (viewed from +Y, x right, z down)…
    // decided from the signed area so either winding works.
    let area2 = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    const sgn = area2 > 0 ? 1 : -1;
    const enx: number[] = [];
    const enz: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      enx.push((sgn * dz) / l);
      enz.push((-sgn * dx) / l);
    }
    // Samples: every vertex (bisector normal, tapered) + every ~1.8 m along each edge.
    const sx: number[] = [];
    const sz: number[] = [];
    const snx: number[] = [];
    const snz: number[] = [];
    const sk: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const ip = (i + n - 1) % n;
      let bx = enx[ip] + enx[i];
      let bz = enz[ip] + enz[i];
      const bl = Math.hypot(bx, bz);
      if (bl < 1e-3) {
        bx = enx[i];
        bz = enz[i];
      } else {
        bx /= bl;
        bz /= bl;
      }
      const turn = enx[ip] * enz[i] - enz[ip] * enx[i];
      sx.push(a[0]);
      sz.push(a[1]);
      snx.push(bx);
      snz.push(bz);
      sk.push(Math.abs(turn) > 0.3 ? 0.45 : 1);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const m = Math.floor(L / 1.8);
      for (let k = 1; k < m; k++) {
        const u = k / m;
        sx.push(a[0] + (b[0] - a[0]) * u);
        sz.push(a[1] + (b[1] - a[1]) * u);
        snx.push(enx[i]);
        snz.push(enz[i]);
        // Taper the first / last metres of each edge toward the corner value.
        const dEnd = Math.min(u, 1 - u) * L;
        sk.push(0.45 + 0.55 * THREE.MathUtils.smoothstep(dEnd, 0.5, 4));
      }
    }
    const m = sx.length;
    if (m > 600) return W;
    const offs = [-0.6, 0.22, 0.55, 1.0];
    const prof = [0.85, 1.0, 0.55, 0];
    const vStart = mound.positions.length / 3;
    const hs: number[] = [];
    const nseed = (hashStr(grp.key) % 997) * 0.53;
    const t0 = f.tf + range(r, -0.5, 0.8);
    for (let k = 0; k < m; k++) {
      const nx = snx[k];
      const nz = snz[k];
      const facing = nx * lx + nz * lz;
      const lean = st >= 3 ? 1 + 0.6 * Math.max(0, facing) - 0.35 * Math.max(0, -facing) : 1;
      const ln = lumpNoise(sx[k] * 0.22 + nseed, sz[k] * 0.22 - nseed);
      // Moderate: patchy skirt (gaps between heaps); heavier states: continuous with lumpy width.
      const gate = st === 2 ? THREE.MathUtils.smoothstep(ln, 0.2, 0.4) : 1;
      const w = W * sk[k] * lean * (0.7 + 0.6 * ln);
      for (let j = 0; j < offs.length; j++) {
        const o = offs[j] < 0 ? offs[j] : offs[j] * w;
        const x = sx[k] + nx * o;
        const z = sz[k] + nz * o;
        const nz2 = lumpNoise(x * 0.9 + 17.3, z * 0.9 - 5.1);
        let h = prof[j] * hPk * gate * sk[k] * (0.7 + 0.6 * nz2) * (0.75 + 0.5 * ln);
        if (j === offs.length - 1) h = 0;
        hs.push(h);
        const gy = ground(x, z);
        mound.positions.push(x, h > 0.04 ? gy + h : gy - 0.35, z);
        mound.ground.push(gy);
        const [cr, cg, cb] = chunkColour(grp, r, 0);
        mound.colors.push(cr * 0.85, cg * 0.85, cb * 0.85);
        mound.grow.push(t0 + 0.4 * j, 2.2);
      }
    }
    const nr = offs.length;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      for (let j = 0; j < nr - 1; j++) {
        const a = k * nr + j;
        const b = k2 * nr + j;
        if (hs[a] <= 0.04 && hs[a + 1] <= 0.04 && hs[b] <= 0.04 && hs[b + 1] <= 0.04) continue;
        mound.indices.push(vStart + a, vStart + a + 1, vStart + b, vStart + b, vStart + a + 1, vStart + b + 1);
      }
    }
    return W;
  };

  // ── Collapsed groups ──
  for (const f of fails) {
    if (!f.collapsed) continue;
    const grp = prep.groups[f.g];
    const ring = B[grp.rep].footprint as XZ[];
    const r = mulberry32(hashStr(grp.key) ^ 0x51ed);
    const H = grp.height;
    const cx = prep.cx[grp.rep];
    const cz = prep.cz[grp.rep];
    const ground = groundFn(grp);
    const shape = ruinShape(H, f.cf, f.leanAngle);
    // Rubble: fills the shell's interior to `hin` / buries the crushed band of a dropped block, and spills
    // beyond the walls toward debrisRadius — mostly on the side the building fell toward.
    const hc = shape.shell ? shape.hin : shape.band + 0.6;
    const edgeH = shape.shell ? hc * 0.6 : hc;
    const R = Math.max(3, f.debrisR) * 1.3;
    const spill = (x: number, z: number) => {
      const a = Math.atan2(z - cz, x - cx);
      return R * (0.35 + 0.65 * Math.max(0, Math.cos(a - f.leanDir))) + 2.5;
    };
    const growT0 = f.tf + 0.25 * f.tc;
    const growDur = f.tc + 1.6;
    const area = prep.area[grp.rep];
    const halfW = Math.max(2, Math.sqrt(area) * 0.35);
    const hAt = (x: number, z: number, nz: number) => {
      const sd = signedDistance(x, z, ring);
      const sp = spill(x, z);
      let h: number;
      if (sd <= 0) h = shape.shell ? hc * (0.72 + 0.28 * Math.min(1, -sd / halfW)) : hc;
      else if (sd < sp) h = edgeH * Math.pow(1 - sd / sp, 1.35);
      else h = 0;
      if (h > 0) {
        h *= 0.75 + 0.5 * nz;
        // Lumps: chunks of wall and floor under the surface.
        h += (lumpNoise(x * 0.85 + 31.7, z * 0.85 - 12.1) - 0.5) * Math.min(1.2, h * 0.7) + (lumpNoise(x * 2.1, z * 2.1) - 0.5) * Math.min(0.5, h * 0.4);
        h = Math.max(h, 0.05);
      }
      return h;
    };
    // Mound grid.
    const [bx0, bz0, bx1, bz1] = ringBounds(ring);
    const pad = R + 4;
    const cell = THREE.MathUtils.clamp(Math.sqrt(area) / 14, 1.1, 2.4);
    const nx = Math.min(90, Math.ceil((bx1 - bx0 + 2 * pad) / cell) + 1);
    const nzc = Math.min(90, Math.ceil((bz1 - bz0 + 2 * pad) / cell) + 1);
    const dx = (bx1 - bx0 + 2 * pad) / (nx - 1);
    const dz = (bz1 - bz0 + 2 * pad) / (nzc - 1);
    const vStart = mound.positions.length / 3;
    const hs = new Float32Array(nx * nzc);
    const nseed = (hashStr(grp.key) % 1000) * 0.37;
    for (let j = 0; j < nzc; j++)
      for (let i = 0; i < nx; i++) {
        const x = bx0 - pad + i * dx;
        const z = bz0 - pad + j * dz;
        const nz = lumpNoise(x * 0.35 + nseed, z * 0.35 - nseed);
        const h = hAt(x, z, nz);
        hs[j * nx + i] = h;
        const gy = ground(x, z);
        mound.positions.push(x, h > 0.04 ? gy + h : gy - 0.35, z);
        mound.ground.push(gy);
        const [cr, cg, cb] = chunkColour(grp, r, 0);
        mound.colors.push(cr * 0.9, cg * 0.9, cb * 0.9);
        mound.grow.push(growT0, growDur);
      }
    for (let j = 0; j < nzc - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        if (hs[a] <= 0.04 && hs[a + 1] <= 0.04 && hs[a + nx] <= 0.04 && hs[a + nx + 1] <= 0.04) continue;
        const A = vStart + a;
        mound.indices.push(A, A + nx, A + 1, A + 1, A + nx, A + nx + 1);
      }
    const moundAt = (x: number, z: number) => {
      const i = THREE.MathUtils.clamp(Math.round((x - (bx0 - pad)) / dx), 0, nx - 1);
      const j = THREE.MathUtils.clamp(Math.round((z - (bz0 - pad)) / dz), 0, nzc - 1);
      return hs[j * nx + i];
    };

    // Pancaked slabs: on top of the shell's rubble core, or forming the crushed band under a dropped block.
    if (shape.shell) pancakeStack(r, grp, f, ring, THREE.MathUtils.clamp(shape.hS * 0.3, 1.0, 3.6), ground, growT0, hc * 0.72, 0.75);
    else pancakeStack(r, grp, f, ring, shape.band, ground, growT0, 0, 0.92);

    // Chunks.
    const N = Math.max(12, Math.round(wantCollapse(f) * chunkScale));
    for (let k = 0; k < N; k++) {
      const kind = kindPick(r, grp);
      const fly = r() < 0.32;
      let x: number;
      let z: number;
      if (r() < (shape.shell ? 0.45 : 0.15)) [x, z] = pointInside(ring, r);
      else {
        const p = pointOnRing(ring, r());
        const out = Math.pow(r(), 1.5) * spill(p.x, p.z);
        x = p.x + p.nx * out;
        z = p.z + p.nz * out;
      }
      const h = moundAt(x, z);
      const rest: [number, number, number] = [x, ground(x, z) + h * range(r, 0.75, 1.02), z];
      if (fly) {
        const u = r();
        const p = pointOnRing(ring, r());
        const top = H * (1 - f.cf * u * u);
        const y0 = grp.base + top * range(r, 0.35, 1);
        pushChunk(r, grp, kind, rest, f.tf + f.tc * u, [p.x + p.nx * 0.5, y0, p.z + p.nz * 0.5], kind === 0 ? 0.8 : 0.9);
      } else {
        pushChunk(r, grp, r() < 0.12 ? 1 : kind, rest, growT0 + growDur * range(r, 0.05, 0.75), null, r() < 0.3 ? 1.5 : 1.0);
      }
    }

    // ── Dust ──
    const mass = area * H * f.cf;
    collapses.push({ x: cx, z: cz, t: f.tf, mass, top: grp.base + Math.max(shape.top, hc), g: f.g, R: Math.max(3, f.debrisR) });
    const big = THREE.MathUtils.clamp(Math.sqrt(mass) / 70, 0.8, 1.6);
    const lx = Math.cos(f.leanDir);
    const lz = Math.sin(f.leanDir);
    const fall = (u: number) => f.tf + f.tc * (0.5 + 0.5 * u);
    const puff = (p: Partial<ParticleSpec> & Pick<ParticleSpec, 'x' | 'y' | 'z'>) => {
      const [dr, dg, db] = dustColour(grp, r);
      dust.push({
        vx: 0, vy: 0, vz: 0, drag: 0.3, t0: f.tf, life: 60, period: 0, rise: 0.4, size0: 8, size1: 30, rot: r(), spin: range(r, -0.06, 0.06),
        r: dr, g: dg, b: db, alpha: 0.5, glow: 0, wind: 0.5, turb: 4, grow: 0, big: 0.5, ...p,
      });
    };
    // (1) Surge channelled down the street canyons: the falling storeys shove a dense, ground-hugging front
    //     60–120 m along each adjacent street (v0 / k ≈ travel), which then lifts and drifts.
    const reach = Math.sqrt(area) * 0.5 + 26;
    const streets = roadIx.near(cx, cz, reach);
    const usedDir: number[] = [];
    let ns = 0;
    for (const st of streets) {
      if (ns >= 4) break;
      const ang = Math.atan2(st.seg.uz, st.seg.ux);
      if (usedDir.some((a) => Math.abs(Math.sin(a - ang)) < 0.35 && st.d > 6)) continue;
      usedDir.push(ang);
      ns++;
      const n = Math.round(THREE.MathUtils.clamp(10 + Math.sqrt(mass) * 0.14, 14, 28));
      for (let k = 0; k < n; k++) {
        const sgn = r() < 0.5 ? -1 : 1;
        const sp = range(r, 14, 30) * (0.7 + 0.3 * big);
        const gx = st.px + range(r, -4, 4);
        const gz = st.pz + range(r, -4, 4);
        puff({
          x: gx, y: ground(gx, gz) + range(r, 1.5, 4), z: gz,
          vx: st.seg.ux * sgn * sp + range(r, -2, 2), vy: range(r, 0.4, 1.8), vz: st.seg.uz * sgn * sp + range(r, -2, 2),
          drag: range(r, 0.22, 0.32), t0: fall(r()), life: range(r, 30, 46), rise: range(r, 0.15, 0.45),
          size0: range(r, 12, 18) * big, size1: range(r, 36, 62) * big, expand: range(r, 5, 10),
          alpha: range(r, 0.55, 0.75), wind: range(r, 0.25, 0.45), turb: range(r, 2, 5), big: 0.5,
        });
      }
    }
    // (2) Radial burst out of the footprint (also where no street is near), biased toward the fall.
    const nb = Math.round(THREE.MathUtils.clamp(10 + Math.sqrt(mass) * 0.1, 12, 26));
    for (let k = 0; k < nb; k++) {
      const p = pointOnRing(ring, r());
      const sp = range(r, 6, 16);
      puff({
        x: p.x + p.nx, y: ground(p.x, p.z) + range(r, 1.5, 5), z: p.z + p.nz,
        vx: p.nx * sp + lx * range(r, 0, 6), vy: range(r, 0.5, 2.5), vz: p.nz * sp + lz * range(r, 0, 6),
        drag: range(r, 0.3, 0.5), t0: fall(r()), life: range(r, 26, 42), rise: range(r, 0.25, 0.7),
        size0: range(r, 10, 16) * big, size1: range(r, 30, 52) * big, expand: range(r, 4, 8),
        alpha: range(r, 0.5, 0.68), wind: 0.5, turb: range(r, 2, 6), big: 0.55,
      });
    }
    // (3) Rising column: dust pushed up out of the pancaking storeys, 40–80 m tall, decaying over ~90 s.
    const nc = Math.round(THREE.MathUtils.clamp(12 + Math.sqrt(mass) * 0.12, 14, 32));
    for (let k = 0; k < nc; k++) {
      const [px, pz] = pointInside(ring, r);
      const u = r();
      puff({
        x: px, y: grp.base + H * (1 - f.cf * u) * range(r, 0.2, 0.8), z: pz,
        vx: range(r, -2, 2), vy: range(r, 4, 10), vz: range(r, -2, 2),
        drag: range(r, 0.1, 0.16), t0: f.tf + f.tc * (0.15 + 0.85 * u) + r() * 2, life: range(r, 36, 52), rise: range(r, 0.35, 0.8),
        size0: range(r, 14, 22) * big, size1: range(r, 60, 100) * big, expand: range(r, 10, 18),
        alpha: range(r, 0.36, 0.5), wind: range(r, 0.65, 0.9), turb: range(r, 4, 10), big: 0.9,
      });
    }
    // (4) Low settling pall over the site (lingers after the column has drifted off).
    for (let k = 0; k < 6; k++) {
      const [px, pz] = pointInside(ring, r);
      puff({
        x: px, y: ground(px, pz) + range(r, 4, 12), z: pz,
        vx: range(r, -1, 1), vy: 0.3, vz: range(r, -1, 1),
        drag: 0.5, t0: f.tf + f.tc + range(r, 3, 8), life: range(r, 36, 48), rise: range(r, 0.05, 0.2),
        size0: range(r, 14, 20) * big, size1: range(r, 30, 44) * big, expand: 14,
        alpha: range(r, 0.16, 0.24), wind: 0.15, turb: 3, big: 0.6,
      });
    }
  }

  // ── Moderate / extensive / complete but standing: a debris apron at the base + facade & parapet fragments ──
  for (const f of fails) {
    if (f.collapsed || f.state < 2) continue;
    const grp = prep.groups[f.g];
    const ring = B[grp.rep].footprint as XZ[];
    const r = mulberry32(hashStr(grp.key) ^ 0xfa5ade);
    const ground = groundFn(grp);
    const H = grp.height;
    const apronW = buildApron(f, grp, ring, ground, r);
    const N = Math.max(3, Math.round(wantFacade(f) * chunkScale));
    const R = Math.max(1.2, apronW * 0.85);
    const sizeK = f.state === 2 ? 0.75 : f.state === 3 ? 1.0 : 1.25;
    for (let k = 0; k < N; k++) {
      const p = pointOnRing(ring, r());
      // Lean side sheds more.
      const facing = p.nx * Math.cos(f.leanDir) + p.nz * Math.sin(f.leanDir);
      if (facing < -0.3 && r() < 0.6) continue;
      const out = range(r, 0.4, R * (facing > 0.3 ? 1.2 : 0.85));
      const x = p.x + p.nx * out;
      const z = p.z + p.nz * out;
      const y0 = grp.base + Math.max(1, H - range(r, 0, Math.min(6, H * 0.4)));
      const kind: 0 | 1 | 2 = r() < 0.86 ? 0 : r() < 0.6 ? 1 : 2;
      pushChunk(r, grp, kind, [x, ground(x, z) + 0.05, z], f.tf + range(r, -1.5, 2.5), [p.x + p.nx * 0.3, y0, p.z + p.nz * 0.3], sizeK);
    }
    // Spalling puffs: pale dust pouring off the damaged facade (merges into one cloud, not discrete blobs).
    const np = grp.family === Family.Brick ? 5 : 3;
    for (let k = 0; k < np; k++) {
      const p = pointOnRing(ring, r());
      const [dr, dg, db] = dustColour(grp, r);
      dust.push({
        x: p.x + p.nx,
        y: grp.base + H * range(r, 0.3, 1),
        z: p.z + p.nz,
        vx: p.nx * range(r, 1.5, 4),
        vy: range(r, -1, 1),
        vz: p.nz * range(r, 1.5, 4),
        drag: 0.5,
        t0: f.tf + range(r, -0.5, 2),
        life: range(r, 14, 34),
        period: 0,
        rise: range(r, 0.2, 0.7),
        size0: range(r, 5, 8),
        size1: range(r, 20, 32),
        expand: range(r, 3, 6),
        rot: r(),
        spin: range(r, -0.1, 0.1),
        r: dr,
        g: dg,
        b: db,
        alpha: range(r, 0.32, 0.48),
        glow: 0,
        wind: 0.6,
        turb: 2,
        grow: 0,
      });
    }
  }

  // ── Road blockages: piles on the carriageway ──
  const ridx = mulberry32(0xb10c);
  for (const rb of result.roads) {
    const road = roadById.get(rb.roadId);
    const ci = idIndex.get(rb.causeBuildingId);
    if (!road || ci === undefined) continue;
    const a = road.points[rb.segment];
    const b = road.points[Math.min(rb.segment + 1, road.points.length - 1)];
    if (!a || !b) continue;
    const g = prep.groupOf[ci];
    const grp = prep.groups[g];
    const f = fails[g];
    const r = mulberry32(hashStr(rb.roadId) ^ (rb.segment * 7919) ^ hashStr(rb.causeBuildingId));
    let ux = b[0] - a[0];
    let uz = b[1] - a[1];
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul;
    uz /= ul;
    const vx = -uz;
    const vz = ux;
    const c = rb.coverage;
    const halfL = THREE.MathUtils.clamp(2.5 + 6 * c, 2.5, 9);
    const halfW = Math.max(1.2, (road.width * c) / 2 + 0.6);
    const hb = 0.35 + 1.35 * c;
    const [px, pz] = rb.at;
    const t0 = f.collapsed ? f.tf + 0.35 * f.tc + ridx() : f.tf + range(r, 0, 2);
    const nu = 9;
    const nv = 6;
    const vStart = mound.positions.length / 3;
    const hs: number[] = [];
    const seedN = r() * 100;
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const u = ((i / (nu - 1)) * 2 - 1) * (halfL + 1.2);
        const v = ((j / (nv - 1)) * 2 - 1) * (halfW + 1.0);
        const e = 1 - (u / halfL) ** 2 - (v / halfW) ** 2;
        let h = e > 0 ? hb * Math.pow(e, 0.75) : 0;
        if (h > 0) h *= 0.7 + 0.6 * lumpNoise(u * 0.6 + seedN, v * 0.6 - seedN);
        hs.push(h);
        const x = px + ux * u + vx * v;
        const z = pz + uz * u + vz * v;
        const gy = terrain.heightAt(x, z);
        mound.positions.push(x, h > 0.04 ? gy + 0.08 + h : gy - 0.35, z);
        mound.ground.push(gy);
        const [cr, cg, cb] = chunkColour(grp, r, 0);
        mound.colors.push(cr * 0.9, cg * 0.9, cb * 0.9);
        mound.grow.push(t0, 2.4);
      }
    for (let j = 0; j < nv - 1; j++)
      for (let i = 0; i < nu - 1; i++) {
        const k = j * nu + i;
        if (hs[k] <= 0.04 && hs[k + 1] <= 0.04 && hs[k + nu] <= 0.04 && hs[k + nu + 1] <= 0.04) continue;
        const A = vStart + k;
        mound.indices.push(A, A + nu, A + 1, A + 1, A + nu, A + nu + 1);
      }
    const N = Math.max(3, Math.round((4 + 15 * c) * chunkScale));
    const ring = B[grp.rep].footprint as XZ[];
    const near = closestOnRing(px, pz, ring);
    for (let k = 0; k < N; k++) {
      const ang = r() * Math.PI * 2;
      const rr = Math.sqrt(r());
      const u = Math.cos(ang) * rr * halfL;
      const v = Math.sin(ang) * rr * halfW;
      const e = Math.max(0, 1 - (u / halfL) ** 2 - (v / halfW) ** 2);
      const x = px + ux * u + vx * v;
      const z = pz + uz * u + vz * v;
      const rest: [number, number, number] = [x, terrain.heightAt(x, z) + 0.08 + hb * Math.pow(e, 0.75) * range(r, 0.7, 1), z];
      const kind = kindPick(r, grp);
      if (r() < 0.4) {
        const y0 = grp.base + Math.min(grp.height, 25) * range(r, 0.3, 1);
        pushChunk(r, grp, kind, rest, t0 + range(r, -0.5, 1.2), [near.px - near.nx * 0.2, y0, near.pz - near.nz * 0.2], 0.75);
      } else pushChunk(r, grp, kind, rest, t0 + range(r, 0, 1.6), null, 0.8);
    }
    // A low dust puff where the pile lands.
    const [dr, dg, db] = dustColour(grp, r);
    dust.push({
      x: px,
      y: terrain.heightAt(px, pz) + 1.5,
      z: pz,
      vx: ux * range(r, -3, 3),
      vy: 0.6,
      vz: uz * range(r, -3, 3),
      drag: 0.6,
      t0: t0 + 0.3,
      life: range(r, 16, 30),
      period: 0,
      rise: 0.4,
      size0: 3,
      size1: range(r, 10, 16),
      rot: r(),
      spin: 0.05,
      r: dr,
      g: dg,
      b: db,
      alpha: 0.55,
      glow: 0,
      wind: 0.6,
      turb: 2,
      grow: 0,
    });
  }

  // ── Glass ──
  for (const f of fails) {
    const grp = prep.groups[f.g];
    if (f.state < 2) continue;
    const r = mulberry32(hashStr(grp.key) ^ 0x61a55);
    const ring = B[grp.rep].footprint as XZ[];
    const ground = groundFn(grp);
    const H = grp.height;
    let n = 0;
    let lowOnly = false;
    if (grp.glassy && H > 28) n = THREE.MathUtils.clamp(H * (f.state - 1) * 0.55, 20, 240);
    else if (B[grp.rep].use === 'retail' || B[grp.rep].use === 'mixed' || B[grp.rep].use === 'commercial') {
      n = 4 + f.state * 3;
      lowOnly = true;
    }
    for (let k = 0; k < n && shards.length < SHARD_CAP; k++) {
      const p = pointOnRing(ring, r());
      const y0 = lowOnly ? grp.base + range(r, 1.5, 4) : grp.base + H * Math.sqrt(r());
      const drop = Math.max(1, y0 - grp.base);
      const out = lowOnly ? range(r, 0.5, 4) : range(r, 2, Math.min(32, 3 + drop * 0.22));
      const x1 = p.x + p.nx * out + range(r, -2, 2);
      const z1 = p.z + p.nz * out + range(r, -2, 2);
      const y1 = ground(x1, z1) + 0.02;
      const vt = range(r, 5, 9);
      shards.push({
        x0: p.x + p.nx * 0.3,
        y0,
        z0: p.z + p.nz * 0.3,
        t0: f.sA + range(r, 0.8, Math.max(2, f.tf - f.sA + 6)),
        x1,
        y1,
        z1,
        T: Math.max(0.4, (y0 - y1) / vt),
        size: lowOnly ? range(r, 0.25, 0.55) : range(r, 0.35, 0.8),
        seed: r(),
      });
    }
  }

  // ── Shock dust: the S wave kicks up a short-lived skin of dust along every street it shakes hard ──
  {
    const src = sourceContext(result.scenario);
    const r = mulberry32(0x5d057);
    const step = 26;
    const want = roadIx.segs.reduce((a, s) => a + s.len, 0) / step;
    const keep = Math.min(1, 2600 / Math.max(1, want));
    const near: number[] = [];
    for (const sg of roadIx.segs) {
      const n = Math.max(1, Math.floor(sg.len / step));
      for (let k = 0; k < n; k++) {
        if (r() > keep) continue;
        const u = (k + r()) / n;
        const x = sg.ax + (sg.bx - sg.ax) * u + range(r, -2, 2);
        const z = sg.az + (sg.bz - sg.az) * u + range(r, -2, 2);
        prep.near(x, z, 45, near);
        let pga = 0;
        for (const i of near) pga = Math.max(pga, result.shaking[i].pgaG);
        if (pga < 0.18) continue;
        const [lat, lon] = unproject(x, z);
        const [e, nn] = siteKm(lat, lon);
        const tS = siteTiming(src, e, nn).sArrivalS;
        const k01 = THREE.MathUtils.smoothstep(pga, 0.18, 0.6);
        const v = 0.9 + 0.2 * r();
        dust.push({
          x, y: terrain.heightAt(x, z) + range(r, 1, 2.5), z,
          vx: range(r, -1.5, 1.5), vy: range(r, 2, 4), vz: range(r, -1.5, 1.5),
          drag: 0.6, t0: tS + range(r, 0.1, 1.0), life: range(r, 12, 22), period: 0, rise: range(r, 0.3, 0.7),
          size0: range(r, 8, 12), size1: range(r, 24, 38) * (0.8 + 0.4 * k01), expand: range(r, 1.5, 3),
          rot: r(), spin: range(r, -0.08, 0.08),
          r: DUST_LIGHT.r * v, g: DUST_LIGHT.g * v, b: DUST_LIGHT.b * v,
          alpha: (0.2 + 0.24 * k01) * range(r, 0.85, 1.1), glow: 0, wind: 0.4, turb: 1.5, grow: 0, big: 0.4,
        });
      }
    }
  }

  // Keep within the particle budget (dropping the least important puffs first: they were appended last).
  if (dust.length > DUST_CAP) dust.length = DUST_CAP;
  return { chunks, shards, mound, dust, collapses, fails };
}

/** Cheap deterministic 2D value noise in [0,1] (CPU side, for mound lumps). */
export function lumpNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const v = (h(xi, zi) * (1 - ux) + h(xi + 1, zi) * ux) * (1 - uz) + (h(xi, zi + 1) * (1 - ux) + h(xi + 1, zi + 1) * ux) * uz;
  return v;
}
