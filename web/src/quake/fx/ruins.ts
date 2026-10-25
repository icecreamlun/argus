/**
 * Collapsed-building ruins: the building's own extrusion is hidden at the end of its fall and replaced by a
 * purpose-built ruin mesh that reads as "this building, broken":
 *
 *   shell (most collapses): jagged wall remnants with real thickness (outer facade, inner plaster face and a
 *          raw broken top), corners surviving higher than the walls between them, notches where the facade fell
 *          away, the lean side lower. The interior is filled by the rubble mound and pancaked slabs (spawn.ts).
 *   block (partial collapse): the intact upper storeys dropped onto a crushed band and leaning.
 *
 * The outer face reuses the building's facade palette (prep.ts takes it from the buildings module's style)
 * with a procedural window grid at the building's storey height, so the remnant matches the walls seen before
 * the collapse. Broken edges get a charred / raw band, dust coats everything toward the break, fires leave soot.
 * Broken floor slabs jut out at the surviving floor lines (instanced debris slabs), with bent rebar (concrete)
 * or splintered joists (masonry / wood). Everything appears at the group's swap time (pure function of t).
 */
import * as THREE from 'three';
import type { AppContext, XZ } from '../../contracts';
import type { ChunkSpec } from './debris';
import { NOISE_GLSL } from './glsl';
import { ringArea } from './geom2d';
import { Family, type CityPrep, type GroupInfo } from './prep';
import { hashStr, mulberry32, range, type Rng } from './rng';
import { ruinShape, type RuinShape } from './rules';
import type { GroupFail } from './spawn';

export interface RuinBuild {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  fac: Float32Array;
  misc: Float32Array;
  index: Uint32Array;
  /** Jutting floor slabs (kind 1) and joists / steel (kind 2). */
  chunks: ChunkSpec[];
  /** Rebar polyline segments: x, y, z, appearT per vertex (pairs). */
  rebar: Float32Array;
  /** Per collapsed group: its final shape (shared with spawn / fire). */
  shapes: Map<number, RuinShape>;
}

const lin = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const PLASTER = lin(0xb9b0a2);
const RAW_CONCRETE = lin(0x77736c);
const RAW_BRICK = lin(0x7a3e2c);
const SLAB = lin(0x8a867f);
const JOIST = lin(0x6b4a30);
const STEEL = lin(0x3b3734);
const DUST = lin(0xa89c88);

/** Vertex stream builder (flat-shaded quads). */
class Buf {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  fac: number[] = [];
  misc: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  v(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, f: [number, number, number, number], m: [number, number, number, number]): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.fac.push(f[0], f[1], f[2], f[3]);
    this.misc.push(m[0], m[1], m[2], m[3]);
    return this.count - 1;
  }
  /** Quad a-b-c-d with the given facing; winding is fixed so the geometric normal agrees with `n`. */
  quad(a: number, b: number, c: number, d: number, n: THREE.Vector3): void {
    const P = this.pos;
    const ax = P[a * 3];
    const ay = P[a * 3 + 1];
    const az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax;
    const e1y = P[b * 3 + 1] - ay;
    const e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax;
    const e2y = P[c * 3 + 1] - ay;
    const e2z = P[c * 3 + 2] - az;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    if (gx * n.x + gy * n.y + gz * n.z >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }
}

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const vD = new THREE.Vector3();
const nT = new THREE.Vector3();

/** Cheap smooth 2D value noise (CPU). */
function vnoise(x: number, z: number): number {
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
  return (h(xi, zi) * (1 - ux) + h(xi + 1, zi) * ux) * (1 - uz) + (h(xi, zi + 1) * (1 - ux) + h(xi + 1, zi + 1) * ux) * uz;
}
const hashXZ = (x: number, z: number) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

interface RingFrame {
  ring: XZ[];
  /** Outward unit normals per edge j→i (edge index = i). */
  nx: number[];
  nz: number[];
  /** Mitred inner offset direction per vertex (scaled so the offset wall keeps its thickness). */
  mx: number[];
  mz: number[];
}

function frameOf(ring: XZ[]): RingFrame {
  const n = ring.length;
  const ccw = ringArea(ring) > 0;
  const nx: number[] = [];
  const nz: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const ex = ring[i][0] - ring[j][0];
    const ez = ring[i][1] - ring[j][1];
    const l = Math.hypot(ex, ez) || 1;
    nx[i] = (ccw ? ez : -ez) / l;
    nz[i] = (ccw ? -ex : ex) / l;
  }
  const mx: number[] = [];
  const mz: number[] = [];
  for (let v = 0; v < n; v++) {
    // Vertex v joins edge v (ending at v) and edge v+1 (starting at v).
    const a = v;
    const b = (v + 1) % n;
    let x = nx[a] + nx[b];
    let z = nz[a] + nz[b];
    const l = Math.hypot(x, z);
    if (l < 1e-4) {
      x = nx[a];
      z = nz[a];
    } else {
      x /= l;
      z /= l;
    }
    const k = Math.min(2.5, 1 / Math.max(0.4, x * nx[a] + z * nz[a]));
    mx[v] = x * k;
    mz[v] = z * k;
  }
  return { ring, nx, nz, mx, mz };
}

export function buildRuins(ctx: AppContext, prep: CityPrep, fails: GroupFail[]): RuinBuild {
  const B = ctx.city.buildings;
  const buf = new Buf();
  const chunks: ChunkSpec[] = [];
  const rebar: number[] = [];
  const shapes = new Map<number, RuinShape>();
  const qTmp = new THREE.Quaternion();
  const qDroop = new THREE.Quaternion();
  const mBasis = new THREE.Matrix4();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const cTmp = new THREE.Color();

  const pushSlab = (
    r: Rng,
    kind: 1 | 2,
    centre: [number, number, number],
    scale: [number, number, number],
    q: THREE.Quaternion,
    t0: number,
    col: THREE.Color,
  ) => {
    const w = Math.min(1, Math.max(-1, q.w));
    const angle = 2 * Math.acos(w);
    const s = Math.sqrt(1 - w * w);
    const v = 0.72 + 0.3 * r();
    const d = 0.25 + 0.3 * r();
    chunks.push({
      kind,
      x0: centre[0],
      y0: centre[1],
      z0: centre[2],
      t0,
      x1: centre[0],
      y1: centre[1],
      z1: centre[2],
      T: -1, // static: placed exactly (no growth from below)
      sx: scale[0],
      sy: scale[1],
      sz: scale[2],
      ax: s < 1e-5 ? 0 : q.x / s,
      ay: s < 1e-5 ? 1 : q.y / s,
      az: s < 1e-5 ? 0 : q.z / s,
      angle,
      spin: 0,
      r: (col.r * (1 - d) + DUST.r * d) * v,
      g: (col.g * (1 - d) + DUST.g * d) * v,
      b: (col.b * (1 - d) + DUST.b * d) * v,
    });
  };

  const bar = (x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, len: number, t0: number, r: Rng) => {
    // Two-segment bent bar.
    const k = range(r, 0.35, 0.6);
    const x1 = x0 + dx * len * k;
    const y1 = y0 + dy * len * k;
    const z1 = z0 + dz * len * k;
    const bx = dx + range(r, -0.6, 0.6);
    const by = dy - range(r, 0.2, 0.9);
    const bz = dz + range(r, -0.6, 0.6);
    const bl = Math.hypot(bx, by, bz) || 1;
    const l2 = len * (1 - k);
    rebar.push(x0, y0, z0, t0, x1, y1, z1, t0, x1, y1, z1, t0, x1 + (bx / bl) * l2, y1 + (by / bl) * l2, z1 + (bz / bl) * l2, t0);
  };

  for (const f of fails) {
    if (!f.collapsed) continue;
    const grp = prep.groups[f.g];
    const shape = ruinShape(grp.height, f.cf, f.leanAngle);
    shapes.set(f.g, shape);
    const r = mulberry32(hashStr(grp.key) ^ 0x7e1c);
    const appear = f.hideAt;
    const H = grp.height;
    const floorH = Math.max(2.6, Math.min(4.6, H / Math.max(1, grp.storeys)));
    const concrete = grp.family === Family.Concrete || grp.family === Family.Stone || grp.family === Family.Glass || grp.family === Family.Metal;
    const steel = grp.family === Family.Glass || grp.family === Family.Metal;
    const thick = grp.family === Family.Brick ? 0.5 : grp.family === Family.Wood ? 0.22 : 0.34;
    const raw = grp.family === Family.Brick ? RAW_BRICK : RAW_CONCRETE;
    const inner = cTmp.copy(PLASTER).lerp(grp.wall, 0.2).clone();
    const fireFlag = f.fire ? 2 : 0;
    const seedBase = r();
    const ldx = Math.cos(f.leanDir);
    const ldz = Math.sin(f.leanDir);
    const glassy = grp.glassy ? 1 : 0;

    for (const i of grp.members) {
      const rec = B[i];
      const ring = rec.footprint as XZ[];
      if (ring.length < 3) continue;
      const minH = rec.minHeight ?? 0;
      const base = rec.baseElevation;
      // Parts starting above the surviving height are gone.
      if (minH > shape.top - 1) continue;
      const fr = frameOf(ring);
      const cx = prep.cx[i];
      const cz = prep.cz[i];
      const Hi = Math.max(rec.height, 2);
      const vStart = buf.count;
      // Corners: some survive tall (stiffer), others are knocked down with the walls.
      const cornerH: number[] = ring.map((_, v) => {
        const a = v;
        const b = (v + 1) % ring.length;
        const turn = Math.abs(fr.nx[a] * fr.nz[b] - fr.nz[a] * fr.nx[b]);
        if (!shape.shell || turn < 0.45) return 0;
        return r() < 0.7 ? range(r, 0.4, 1) : 0;
      });
      // Wall remnants stand a little above the rubble core; corner piers much higher.
      const shellTop = Math.min(Hi, Math.max(shape.top, 1.2));
      const seed = seedBase * 97.3 + i * 0.37;

      /** Absolute wall-top height (y) at a footprint point. */
      const topAt = (x: number, z: number): number => {
        if (!shape.shell) {
          // Intact dropped block: flat roof line with a few bites out of the parapet.
          const top = Math.min(Hi, shape.top);
          const bite = vnoise(x * 0.35 + seed, z * 0.35) > 0.78 ? 0.4 + hashXZ(x, z) : 0;
          return base + top - bite * 0.5;
        }
        let h = shellTop;
        // Ragged remnant: storey-sized steps, finer teeth, a few deep notches where the facade fell away.
        h += (vnoise(x * 0.11 + seed, z * 0.11 - seed) - 0.35) * 2.0 * floorH;
        const notch = vnoise(x * 0.07 - seed, z * 0.07 + seed * 0.5);
        h *= 1 - 0.7 * THREE.MathUtils.smoothstep(notch, 0.64, 0.84);
        // The lean side came down with the upper floors.
        const ox = x - cx;
        const oz = z - cz;
        const ol = Math.hypot(ox, oz) || 1;
        h *= 1 - 0.38 * Math.max(0, (ox * ldx + oz * ldz) / ol);
        // Corner piers stand higher.
        for (let v = 0; v < ring.length; v++) {
          if (cornerH[v] <= 0) continue;
          const d = Math.hypot(x - ring[v][0], z - ring[v][1]);
          const k = 1 - THREE.MathUtils.smoothstep(d, 0.8, 2.2 + cornerH[v] * 2.2);
          if (k > 0) h = Math.max(h, (shellTop + (Hi - shellTop) * 0.72 * cornerH[v]) * k + h * (1 - k));
        }
        // Teeth.
        h += (hashXZ(x * 3.1 + seed, z * 2.7) - 0.5) * 1.1;
        return base + THREE.MathUtils.clamp(h, 0.7, Hi * 0.95);
      };

      const yBot = base - 0.6;
      const wallBottom = shape.shell ? yBot : base + shape.band;
      const vOff = shape.shell ? 0 : H - shape.top; // facade v (original storey grid) = y - base + vOff
      const colW = shape.shell ? 0.9 : 3.0;
      const n = ring.length;
      for (let e = 0; e < n; e++) {
        const j = (e + n - 1) % n;
        const a = ring[j];
        const b = ring[e];
        const ex = b[0] - a[0];
        const ez = b[1] - a[1];
        const L = Math.hypot(ex, ez);
        if (L < 0.3) continue;
        const enx = fr.nx[e];
        const enz = fr.nz[e];
        const nOut = new THREE.Vector3(enx, 0, enz);
        const nIn = new THREE.Vector3(-enx, 0, -enz);
        const nb = Math.max(1, Math.round(L / 3.4));
        const bayW = L / nb;
        // Inner (mitred) endpoints.
        const qa: XZ = [a[0] - fr.mx[j] * thick, a[1] - fr.mz[j] * thick];
        const qb: XZ = [b[0] - fr.mx[e] * thick, b[1] - fr.mz[e] * thick];
        const ncol = Math.max(1, Math.ceil(L / colW));
        let prevO: [number, number, number, number] | null = null; // outer bottom/top indices of the previous column edge
        let prevI: [number, number] | null = null;
        for (let k = 0; k <= ncol; k++) {
          const s = (L * k) / ncol;
          const u = s / L;
          const px = a[0] + ex * u;
          const pz = a[1] + ez * u;
          const ix = qa[0] + (qb[0] - qa[0]) * u;
          const iz = qa[1] + (qb[1] - qa[1]) * u;
          const top = topAt(px, pz);
          const vTop = top - base + vOff;
          const mm = (kind: number, t: number): [number, number, number, number] => [kind, t, appear, seedBase + fireFlag + glassy * 4];
          const fac = (y: number): [number, number, number, number] => [s, y - base + vOff, floorH, bayW];
          const o0 = buf.v(vA.set(px, wallBottom, pz), nOut, grp.wall, fac(wallBottom), mm(0, vTop));
          const o1 = buf.v(vA.set(px, top, pz), nOut, grp.wall, fac(top), mm(0, vTop));
          let i0 = -1;
          let i1 = -1;
          let c0 = -1;
          let c1 = -1;
          if (shape.shell) {
            const itop = top - 0.04;
            i0 = buf.v(vA.set(ix, wallBottom, iz), nIn, inner, fac(wallBottom), mm(1, vTop));
            i1 = buf.v(vA.set(ix, itop, iz), nIn, inner, fac(itop), mm(1, vTop));
            c0 = buf.v(vA.set(px, top, pz), up, raw, fac(top), mm(2, vTop));
            c1 = buf.v(vA.set(ix, itop, iz), up, raw, fac(itop), mm(2, vTop));
          }
          if (prevO) {
            buf.quad(prevO[0], o0, o1, prevO[1], nOut);
            if (shape.shell && prevI) {
              buf.quad(prevI[0], i0, i1, prevI[1], nIn);
              // Broken top: the cap's facing is "up" (winding fixed from it); flat-shaded with the real slope.
              const pc0 = prevO[2];
              const pc1 = prevO[3];
              buf.quad(pc0, c0, c1, pc1, up);
            }
          }
          prevO = [o0, o1, c0, c1];
          prevI = [i0, i1];
        }

        // ── Jutting / hanging floor slabs and their reinforcement at the broken floor lines ──
        if (shape.shell) {
          const steps = Math.max(1, Math.floor(L / 2.6));
          for (let k = 0; k < steps; k++) {
            if (r() > 0.42) continue;
            const s = ((k + 0.5) / steps) * L + range(r, -0.6, 0.6);
            const u = THREE.MathUtils.clamp(s / L, 0.05, 0.95);
            const px = a[0] + ex * u;
            const pz = a[1] + ez * u;
            const local = topAt(px, pz) - base;
            const fl = Math.floor((local - 0.25) / floorH);
            const yF = fl * floorH;
            if (fl < 1 || yF < 2.4) continue;
            const hang = r() < 0.14;
            const droop = hang ? range(r, 0.9, 1.35) : range(r, 0.04, 0.55);
            const out = hang ? range(r, 1.6, 3.6) : range(r, 0.5, 1.9);
            const w = range(r, 1.3, Math.min(3.8, L * 0.7));
            const th = concrete ? range(r, 0.22, 0.32) : range(r, 0.16, 0.24);
            // Basis: x along the wall, z outward, y = z × x (up).
            az.set(enx, 0, enz);
            ax.set(ex / L, 0, ez / L);
            ay.crossVectors(az, ax);
            if (ay.y < 0) ax.negate(), ay.negate();
            mBasis.makeBasis(ax, ay.set(0, 1, 0), az);
            // Re-orthonormalise (ax ⟂ az already; y is exactly up).
            qTmp.setFromRotationMatrix(mBasis);
            qDroop.setFromAxisAngle(vB.set(1, 0, 0), droop);
            qTmp.multiply(qDroop);
            const cxS = px + enx * ((out / 2) * Math.cos(droop) - thick * 0.5);
            const czS = pz + enz * ((out / 2) * Math.cos(droop) - thick * 0.5);
            const cyS = base + yF - (out / 2) * Math.sin(droop);
            pushSlab(r, 1, [cxS, cyS, czS], [w, th, out], qTmp, appear, SLAB);
            // Reinforcement sticking out of the slab's broken end.
            const ex2 = px + enx * (out * Math.cos(droop) - thick * 0.5);
            const ez2 = pz + enz * (out * Math.cos(droop) - thick * 0.5);
            const ey2 = base + yF - out * Math.sin(droop);
            const nbar = concrete ? 3 + Math.floor(r() * 4) : 0;
            for (let q = 0; q < nbar; q++) {
              const o = range(r, -w * 0.45, w * 0.45);
              bar(
                ex2 + (ex / L) * o,
                ey2 + range(r, -0.08, 0.08),
                ez2 + (ez / L) * o,
                enx * Math.cos(droop),
                -Math.sin(droop) + range(r, -0.2, 0.3),
                enz * Math.cos(droop),
                range(r, 0.5, 1.5),
                appear,
                r,
              );
            }
            if (!concrete && r() < 0.8) {
              // Splintered joists poking out of masonry / timber floors.
              const nj = 1 + Math.floor(r() * 3);
              for (let q = 0; q < nj; q++) {
                const len = range(r, 0.8, 2.6);
                const o = range(r, -w * 0.5, w * 0.5);
                const jd = range(r, -0.15, 0.6);
                qTmp.setFromRotationMatrix(mBasis);
                qDroop.setFromAxisAngle(vB.set(1, 0, 0), jd);
                qTmp.multiply(qDroop);
                qTmp.multiply(qDroop.setFromAxisAngle(vB.set(0, 1, 0), range(r, -0.35, 0.35)));
                pushSlab(
                  r,
                  2,
                  [px + (ex / L) * o + enx * (len / 2 - thick), base + yF - 0.12 - (len / 2) * Math.sin(jd), pz + (ez / L) * o + enz * (len / 2 - thick)],
                  [range(r, 0.07, 0.12), range(r, 0.18, 0.28), len],
                  qTmp,
                  appear,
                  steel ? STEEL : JOIST,
                );
              }
            }
          }
          // Bars standing out of the broken wall tops (reinforced concrete only).
          if (concrete) {
            const nTop = Math.floor(L / 0.9);
            for (let k = 0; k < nTop; k++) {
              if (r() > 0.45) continue;
              const u = (k + r()) / Math.max(1, nTop);
              const px = a[0] + ex * u - enx * thick * 0.5;
              const pz = a[1] + ez * u - enz * thick * 0.5;
              const y = topAt(a[0] + ex * u, a[1] + ez * u) - 0.05;
              bar(px, y, pz, range(r, -0.3, 0.3) + enx * 0.3, 1, range(r, -0.3, 0.3) + enz * 0.3, range(r, 0.3, 1.1), appear, r);
            }
          }
        }
      }

      if (!shape.shell) {
        // Roof of the dropped block, plus a crushed band under it (raw, dark: the pancaked lower storeys).
        const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        const topY = base + Math.min(Hi, shape.top);
        const roofIdx: number[] = [];
        for (const [x, z] of ring) {
          roofIdx.push(buf.v(vA.set(x, topY - 0.02, z), up, grp.roof, [0, H, floorH, 3.4], [3, H + 1, appear, seedBase + fireFlag]));
        }
        const flip = ringArea(ring) > 0;
        for (const t of tris) {
          if (flip) buf.idx.push(roofIdx[t[0]], roofIdx[t[2]], roofIdx[t[1]]);
          else buf.idx.push(roofIdx[t[0]], roofIdx[t[1]], roofIdx[t[2]]);
        }
        // Make sure the roof faces up (winding check on the first triangle).
        const t0 = buf.idx.length - tris.length * 3;
        if (tris.length) {
          const P = buf.pos;
          const ia = buf.idx[t0] * 3;
          const ib = buf.idx[t0 + 1] * 3;
          const ic = buf.idx[t0 + 2] * 3;
          vA.set(P[ia], P[ia + 1], P[ia + 2]);
          vB.set(P[ib], P[ib + 1], P[ib + 2]).sub(vA);
          vC.set(P[ic], P[ic + 1], P[ic + 2]).sub(vA);
          if (vD.crossVectors(vB, vC).y < 0) {
            for (let k = t0; k < buf.idx.length; k += 3) {
              const tmp = buf.idx[k + 1];
              buf.idx[k + 1] = buf.idx[k + 2];
              buf.idx[k + 2] = tmp;
            }
          }
        }
        // Crushed band ring (inset a little, raw material).
        for (let e = 0; e < n; e++) {
          const j = (e + n - 1) % n;
          const a = ring[j];
          const b = ring[e];
          const nOut = new THREE.Vector3(fr.nx[e], 0, fr.nz[e]);
          const ia: XZ = [a[0] - fr.mx[j] * 0.5, a[1] - fr.mz[j] * 0.5];
          const ib: XZ = [b[0] - fr.mx[e] * 0.5, b[1] - fr.mz[e] * 0.5];
          const yt = base + shape.band + 0.3;
          const mm: [number, number, number, number] = [2, yt - base + 1, appear, seedBase + fireFlag];
          const q0 = buf.v(vA.set(ia[0], yBot, ia[1]), nOut, raw, [0, 0, floorH, 3.4], mm);
          const q1 = buf.v(vA.set(ib[0], yBot, ib[1]), nOut, raw, [0, 0, floorH, 3.4], mm);
          const q2 = buf.v(vA.set(ib[0], yt, ib[1]), nOut, raw, [0, 0, floorH, 3.4], mm);
          const q3 = buf.v(vA.set(ia[0], yt, ia[1]), nOut, raw, [0, 0, floorH, 3.4], mm);
          buf.quad(q0, q1, q2, q3, nOut);
        }
        // Lean the whole dropped block (walls + roof; the band stays) about its centre at band height.
        if (shape.lean > 0) {
          const k = nT.set(ldz, 0, -ldx).normalize();
          const pivot = vD.set(cx, base + shape.band, cz);
          const q = qTmp.setFromAxisAngle(k, shape.lean);
          const P = buf.pos;
          const N = buf.nrm;
          const bandStart = buf.count - n * 4;
          for (let vi = vStart; vi < bandStart; vi++) {
            vA.set(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]).sub(pivot).applyQuaternion(q).add(pivot);
            P[vi * 3] = vA.x;
            P[vi * 3 + 1] = vA.y;
            P[vi * 3 + 2] = vA.z;
            vB.set(N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]).applyQuaternion(q);
            N[vi * 3] = vB.x;
            N[vi * 3 + 1] = vB.y;
            N[vi * 3 + 2] = vB.z;
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(buf.pos),
    normals: new Float32Array(buf.nrm),
    colors: new Float32Array(buf.col),
    fac: new Float32Array(buf.fac),
    misc: new Float32Array(buf.misc),
    index: new Uint32Array(buf.idx),
    chunks,
    rebar: new Float32Array(rebar),
    shapes,
  };
}

// ───────────────────────────── Rendering ─────────────────────────────

const RUIN_VERT_PARS = /* glsl */ `
attribute vec3 aCol;
attribute vec4 aFac;
attribute vec4 aMisc;
uniform float uTime;
varying vec3 vRCol;
varying vec4 vRFac;
varying vec4 vRMisc;
varying vec3 vRW;
varying vec3 vRN;
`;

const RUIN_BEGIN = /* glsl */ `
	vec3 transformed = position;
	if ( uTime < aMisc.z ) transformed = vec3( 0.0, -5000.0, 0.0 );
	vRCol = aCol;
	vRFac = aFac;
	vRMisc = aMisc;
	vRW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vRN = normalize( mat3( modelMatrix ) * objectNormal );
`;

const RUIN_BEGIN_DEPTH = /* glsl */ `
	vec3 transformed = position;
	if ( uTime < aMisc.z ) transformed = vec3( 0.0, -5000.0, 0.0 );
`;

const RUIN_DEPTH_PARS = /* glsl */ `
attribute vec4 aMisc;
uniform float uTime;
`;

const RUIN_FRAG_PARS = /* glsl */ `
varying vec3 vRCol;
varying vec4 vRFac;
varying vec4 vRMisc;
varying vec3 vRW;
varying vec3 vRN;
${NOISE_GLSL}
float rAa( float e, float x ) {
	float w = max( fwidth( x ) * 0.75, 1e-4 );
	return smoothstep( e - w, e + w, x );
}
`;

// Writes diffuseColor.rgb and the local roughness (rRough) used by the roughness chunk.
const RUIN_COLOR = /* glsl */ `
	float rRough = 0.92;
	{
		float kind = vRMisc.x;
		float top = vRMisc.y;
		float seed = fract( vRMisc.w );
		float burnt = mod( floor( vRMisc.w ), 4.0 ) >= 2.0 ? 1.0 : 0.0;
		float glassy = vRMisc.w >= 4.0 ? 1.0 : 0.0;
		float s = vRFac.x;
		float v = vRFac.y;
		float fh = max( vRFac.z, 2.4 );
		float bw = max( vRFac.w, 1.2 );
		vec3 dustC = vec3( 0.40, 0.37, 0.32 );
		float n1 = vnoise( vRW.xz * 0.9 + vRW.y * 0.7 + seed * 31.0 );
		float n2 = vnoise( vRW.xz * 3.3 - vRW.y * 2.1 + 7.0 );
		float n3 = vnoise( vec2( s, v ) * 0.45 + seed * 11.0 );
		float toEdge = top - v;
		vec3 alb = vRCol;
		if ( kind < 0.5 ) {
			// ── Outer facade: the building's own palette with its storey grid ──
			float fy = fract( v / fh );
			float bx = fract( s / bw );
			bool groundF = v < fh * 1.05;
			vec2 lo = groundF ? vec2( 0.1, 0.05 ) : vec2( 0.27 - 0.08 * glassy, 0.28 );
			vec2 hi = groundF ? vec2( 0.9, 0.78 ) : vec2( 0.73 + 0.08 * glassy, 0.84 );
			float win = rAa( lo.x, bx ) * ( 1.0 - rAa( hi.x, bx ) ) * rAa( lo.y, fy ) * ( 1.0 - rAa( hi.y, fy ) );
			float fr = 0.045;
			float glassA = rAa( lo.x + fr, bx ) * ( 1.0 - rAa( hi.x - fr, bx ) ) * rAa( lo.y + fr * 1.4, fy ) * ( 1.0 - rAa( hi.y - fr * 1.4, fy ) );
			float frame = win - glassA;
			alb *= 0.9 + 0.18 * n1;
			// Belt course at each floor line, slightly darker.
			alb *= 1.0 - 0.18 * ( 1.0 - rAa( 0.04, fy ) );
			vec2 cellId = vec2( floor( s / bw ), floor( v / fh ) );
			float hc = fract( sin( dot( cellId, vec2( 12.9898, 78.233 ) ) + seed * 91.0 ) * 43758.5453 );
			// Blown-out windows: dark interior; a few panes still hold (glossy, catch the sky).
			vec3 interior = vec3( 0.022, 0.02, 0.019 ) * ( 0.7 + 0.6 * n2 );
			float pane = step( 0.72, hc ) * ( 1.0 - burnt * 0.8 );
			vec3 glassC = mix( interior, vec3( 0.05, 0.06, 0.07 ), pane );
			alb = mix( alb, alb * 1.18 + 0.03, frame );
			alb = mix( alb, glassC, glassA );
			rRough = mix( rRough, mix( 0.85, 0.12, pane ), glassA );
			// Cracks through the remaining masonry.
			float ck = 1.0 - smoothstep( 0.0, 0.03, abs( vnoise( vec2( s, v ) * 0.6 + seed * 13.0 ) - 0.5 ) );
			ck *= step( 0.42, vnoise( vec2( s, v ) * 0.17 + 3.0 ) ) * ( 1.0 - glassA );
			alb *= 1.0 - 0.7 * ck;
			// Soot streaks licking up from gutted windows of burning buildings.
			float soot = burnt * smoothstep( 0.35, 0.85, vnoise( vec2( s * 0.35, v * 0.12 ) + seed * 5.0 ) ) * smoothstep( 0.0, 3.0, v );
			alb *= 1.0 - 0.85 * soot;
		} else if ( kind < 1.5 ) {
			// ── Inner face: plaster with the torn floor slabs as dark bands ──
			float fy = fract( v / fh );
			alb *= 0.62 + 0.3 * n1;
			float slabB = 1.0 - rAa( 0.11, fy );
			alb = mix( alb, vec3( 0.12, 0.115, 0.11 ), slabB );
			alb *= 0.72; // interior sits in its own shade
		} else if ( kind < 2.5 ) {
			// ── Raw broken material: brick / concrete core ──
			alb *= 0.55 + 0.6 * n2 * n1;
		} else {
			// ── Roof of a dropped block: dust-laden, with holes punched through ──
			alb *= 0.85 + 0.2 * n1;
			float hole = smoothstep( 0.74, 0.8, vnoise( vRW.xz * 0.25 + seed * 17.0 ) );
			alb = mix( alb, vec3( 0.02 ), hole );
		}
		// Charred / raw band along every broken edge.
		if ( kind < 1.5 ) {
			float band = 1.0 - smoothstep( 0.12, 0.7 + 0.9 * n2, toEdge );
			alb = mix( alb, vec3( 0.06, 0.055, 0.05 ) * ( 0.6 + 0.8 * n1 ), band * 0.85 );
		}
		// Dust: everything is coated, heavier toward the break and on up-facing surfaces.
		float up = clamp( vRN.y * 0.5 + 0.5, 0.0, 1.0 );
		float dust = clamp( 0.28 + 0.35 * n3 + 0.35 * ( 1.0 - smoothstep( 0.0, 5.0, toEdge ) ) + 0.25 * up, 0.0, 0.85 );
		alb = mix( alb, dustC * ( 0.85 + 0.3 * n2 ), dust * 0.55 );
		diffuseColor.rgb = alb;
	}
`;

const REBAR_VERT = /* glsl */ `
attribute float aT;
uniform float uTime;
#include <common>
#include <fog_pars_vertex>
void main() {
	vec4 mvPosition = viewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	// Only up close (sub-pixel lines shimmer from afar) and once the ruin exists.
	if ( uTime < aT || - mvPosition.z > 260.0 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
	#include <fog_vertex>
}
`;

const REBAR_FRAG = /* glsl */ `
uniform vec3 uCol;
#include <common>
#include <fog_pars_fragment>
void main() {
	gl_FragColor = vec4( uCol, 1.0 );
	#include <fog_fragment>
}
`;

export class RuinRenderer {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly rebar: THREE.LineSegments;
  private readonly uniforms = { uTime: { value: 0 } };
  private readonly rebarMat: THREE.ShaderMaterial;

  constructor() {
    this.group.name = 'quakeRuins';
    const u = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    mat.name = 'ruinFacade';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${RUIN_VERT_PARS}`)
        .replace('#include <begin_vertex>', RUIN_BEGIN);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${RUIN_FRAG_PARS}`)
        .replace('#include <color_fragment>', RUIN_COLOR)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rRough;');
    };
    mat.customProgramCacheKey = () => 'argus-ruin';
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${RUIN_DEPTH_PARS}`)
        .replace('#include <begin_vertex>', RUIN_BEGIN_DEPTH);
    };
    depth.customProgramCacheKey = () => 'argus-ruin-depth';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.name = 'ruinShells';
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this.rebarMat = new THREE.ShaderMaterial({
      vertexShader: REBAR_VERT,
      fragmentShader: REBAR_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uCol: { value: new THREE.Color(0.07, 0.045, 0.035) } }]),
      fog: true,
    });
    const fogU = (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).argusFog;
    if (fogU) this.rebarMat.uniforms.argusFog = fogU;
    this.rebarMat.uniforms.uTime = u.uTime;
    this.rebar = new THREE.LineSegments(new THREE.BufferGeometry(), this.rebarMat);
    this.rebar.name = 'ruinRebar';
    this.rebar.frustumCulled = false;
    this.rebar.visible = false;
    this.group.add(this.mesh, this.rebar);
  }

  set(b: RuinBuild | null): void {
    this.mesh.geometry.dispose();
    this.rebar.geometry.dispose();
    const g = new THREE.BufferGeometry();
    if (b && b.index.length) {
      g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
      g.setAttribute('aCol', new THREE.BufferAttribute(b.colors, 3));
      g.setAttribute('aFac', new THREE.BufferAttribute(b.fac, 4));
      g.setAttribute('aMisc', new THREE.BufferAttribute(b.misc, 4));
      g.setIndex(new THREE.BufferAttribute(b.index, 1));
    }
    this.mesh.geometry = g;
    this.mesh.visible = !!b && b.index.length > 0;
    const rg = new THREE.BufferGeometry();
    if (b && b.rebar.length) {
      const n = b.rebar.length / 4;
      const p = new Float32Array(n * 3);
      const t = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        p[i * 3] = b.rebar[i * 4];
        p[i * 3 + 1] = b.rebar[i * 4 + 1];
        p[i * 3 + 2] = b.rebar[i * 4 + 2];
        t[i] = b.rebar[i * 4 + 3];
      }
      rg.setAttribute('position', new THREE.BufferAttribute(p, 3));
      rg.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    }
    this.rebar.geometry = rg;
    this.rebar.visible = !!b && b.rebar.length > 0;
  }

  update(t: number): void {
    this.uniforms.uTime.value = t;
  }

  clear(): void {
    this.set(null);
  }
}

/** Group info needed by other modules to place things on top of a ruin. */
export function ruinRubbleTop(grp: GroupInfo, shape: RuinShape | undefined): number {
  if (!shape) return grp.base + grp.height;
  return grp.base + (shape.shell ? shape.hin : shape.top);
}
