/**
 * Building / landmark / ground motion and the power grid, all as pure functions of sim time.
 *
 * Per building group (all building:part pieces of one structure move together):
 *   period     T ≈ 0.1·N s (steel slightly longer, wood ≥ 0.25 s) — towers sway slowly, low-rises jitter;
 *   roof drift  ≈ 1.4·Sd(T), Sd = min(2.5·PGA·(T/2π)², 1.6·PGV·T/2π) (acceleration- vs velocity-controlled
 *              spectrum), exaggerated ×9 (low-rise) … ×3 (towers) for legibility and capped at 3.5 % drift;
 *   envelope    from P arrival (light rattle) through S arrival (strong phase) and coda (timeline.ts);
 *   failure     at failTimeS: extensive/complete lean to leanAngle toward leanDirection; collapsed groups
 *              pancake to (1 − collapseFraction)·H with a gravity ease-in over 1.5–4 s, then (if mostly
 *              flattened) hand over to the rubble mound.
 * Parts get a displacement scaled by partHeight / groupHeight so every piece shares one cantilever profile
 * (no tearing between setback prisms); multi-part groups lean by shear instead of rigid tilt for the same reason.
 */
import * as THREE from 'three';
import type { AppContext, BuildingDynamicState, QuakeResult } from '../../contracts';
import type { QuakeFxDeps } from './index';
import type { CityPrep } from './prep';
import { hash01, hashStr } from './rng';
import { leaderOf, ruinShape, ruinSwapTime } from './rules';
import {
  G,
  TAU,
  clamp01,
  collapseDuration,
  collapseFall,
  easeOut,
  flicker,
  pPhase,
  shakeEnvelope,
  smoothstep,
  wobble,
} from './timeline';

/** Per-group motion parameters (indexed by group). */
interface GroupMotion {
  pA: Float32Array;
  sA: Float32Array;
  dur: Float32Array;
  amp: Float32Array;
  freq: Float32Array;
  ph: Float32Array;
  state: Uint8Array;
  collapsed: Uint8Array;
  cf: Float32Array;
  tf: Float32Array;
  tc: Float32Array;
  leanDir: Float32Array;
  leanAng: Float32Array;
  hideAt: Float32Array;
  pgv: Float32Array;
  multi: Uint8Array;
}

interface Sector {
  tS: number;
  out: boolean;
  tOut: number;
  seed: number;
  weight: number;
}

interface LandmarkLink {
  obj: THREE.Object3D;
  group: number;
  q0: THREE.Quaternion;
  p0: THREE.Vector3;
  s0: THREE.Vector3;
}

const SECTOR = 220;
const DEG = Math.PI / 180;

/**
 * Visible lean of a standing damaged building (rad). The model's 2–6° (extensive) / 5–12° (complete) is kept in
 * range but floored and mildly exaggerated so it reads from a helicopter 150–250 m away (a 2° lean on a 12 m
 * building moves the roof 40 cm, under two pixels): extensive 3–6°, complete 6–13°.
 */
export function standingLean(state: number, leanAngle: number): number {
  if (state === 3) return Math.min(6 * DEG, Math.max(3 * DEG, leanAngle * 1.25));
  if (state >= 4) return Math.min(13 * DEG, Math.max(6 * DEG, leanAngle * 1.3));
  return 0;
}

export class BuildingMotion {
  private gm: GroupMotion | null = null;
  private result: QuakeResult | null = null;
  private sectors: Sector[] = [];
  private sectorOf = new Int32Array(0);
  private emergency = new Float32Array(0);
  private replaced = new Set<number>();
  private landmarks: LandmarkLink[] = [];
  private readonly st: Required<BuildingDynamicState> = { shakeX: 0, shakeZ: 0, tiltX: 0, tiltZ: 0, crush: 0, damage: 0, lightsOut: 0, hidden: 0 };
  private readonly rootPos0 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpE = new THREE.Euler();
  /** Group displacement scratch (x, z at the group's roof), filled by evalGroup. */
  private gx = 0;
  private gz = 0;
  private gLean = 0;
  /** Last power-out fraction (for streets / landmarks). */
  powerOut = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: QuakeFxDeps,
    private readonly prep: CityPrep,
  ) {
    this.rootPos0.copy(ctx.cityRoot.position);
  }

  load(result: QuakeResult): void {
    this.result = result;
    const { prep } = this;
    const B = this.ctx.city.buildings;
    const ng = prep.groups.length;
    const gm: GroupMotion = {
      pA: new Float32Array(ng),
      sA: new Float32Array(ng),
      dur: new Float32Array(ng),
      amp: new Float32Array(ng),
      freq: new Float32Array(ng),
      ph: new Float32Array(ng),
      state: new Uint8Array(ng),
      collapsed: new Uint8Array(ng),
      cf: new Float32Array(ng),
      tf: new Float32Array(ng),
      tc: new Float32Array(ng),
      leanDir: new Float32Array(ng),
      leanAng: new Float32Array(ng),
      hideAt: new Float32Array(ng),
      pgv: new Float32Array(ng),
      multi: new Uint8Array(ng),
    };
    for (let g = 0; g < ng; g++) {
      const grp = prep.groups[g];
      const L = leaderOf(result, grp.members, B);
      const d = result.damage[L];
      const s = result.shaking[grp.tallest];
      const H = grp.height;
      const rec = B[grp.tallest];
      const N = grp.storeys;
      let T = 0.1 * N;
      if (rec.structure.startsWith('S')) T *= 1.15;
      else if (rec.structure.startsWith('W')) T = Math.max(0.25, T);
      else if (rec.structure.startsWith('C') || rec.structure === 'PC') T *= 0.9;
      T = THREE.MathUtils.clamp(T, 0.15, 6.5);
      const w = T / TAU;
      const sd = Math.min(2.5 * s.pgaG * G * w * w, 1.6 * (s.pgvCms / 100) * w);
      // Exaggerated for legibility (a real 0.3 % drift is invisible at city scale), most for low-rises.
      const exag = THREE.MathUtils.lerp(15, 3.5, smoothstep(10, 120, H));
      gm.amp[g] = Math.min(1.4 * sd * exag, 0.055 * H);
      gm.freq[g] = 1 / T;
      gm.ph[g] = hash01(hashStr(grp.key), 7) * TAU;
      gm.pA[g] = s.pArrivalS;
      gm.sA[g] = s.sArrivalS;
      gm.dur[g] = s.durationS;
      gm.pgv[g] = s.pgvCms;
      gm.state[g] = d.state;
      gm.collapsed[g] = d.collapsed ? 1 : 0;
      // Collapsed groups fall to their ruin's wall height (shells are capped at ~half height, rules.ts).
      gm.cf[g] = d.collapsed ? Math.max(d.collapseFraction, 1 - ruinShape(H, d.collapseFraction, d.leanAngle).hS / H) : d.collapseFraction;
      gm.tf[g] = d.failTimeS;
      gm.tc[g] = collapseDuration(H, d.collapseFraction);
      gm.leanDir[g] = d.leanDirection;
      // Collapsed buildings fall into the pose of their ruin (ruins.ts), then swap to it under the dust burst.
      gm.leanAng[g] = d.collapsed ? Math.max(d.leanAngle, ruinShape(H, d.collapseFraction, d.leanAngle).lean) : standingLean(d.state, d.leanAngle);
      gm.hideAt[g] = d.collapsed ? ruinSwapTime(d.failTimeS, gm.tc[g]) : Infinity;
      gm.multi[g] = grp.members.length > 1 ? 1 : 0;
    }
    this.gm = gm;
    this.buildPower(result);
    this.replaced = new Set(this.deps.landmarks.replacedBuildingIds.map((id) => this.deps.buildings.indexOf(id)).filter((i) => i >= 0));
    this.linkLandmarks();
  }

  /** Roof displacement + lean of group g at time t → this.gx / gz / gLean. */
  private evalGroup(g: number, t: number): number {
    const gm = this.gm!;
    const env = shakeEnvelope(t, gm.pA[g], gm.sA[g], gm.dur[g]);
    const tf = gm.tf[g];
    const st = gm.state[g];
    // Stiffness degradation after failure: longer period, larger excursions.
    const failed = st >= 3 && t > tf;
    const te = failed ? tf + (t - tf) * 0.8 : t;
    const a = gm.amp[g] * env * (failed ? 1.3 : 1);
    const ph = gm.ph[g];
    const f = gm.freq[g];
    let x = a * wobble(te, f, ph);
    let z = a * wobble(te, f * 0.91, ph + 2.1);
    // P-phase rattle: small, fast, mostly vertical-ish jitter we can only show horizontally.
    const pr = pPhase(t, gm.pA[g], gm.sA[g]);
    if (pr > 0) {
      const ra = Math.min(0.05, 0.25 * gm.amp[g] + 0.01) * pr;
      x += ra * Math.sin(TAU * 8.3 * t + ph);
      z += ra * Math.sin(TAU * 9.7 * t + ph * 1.3);
    }
    this.gx = x;
    this.gz = z;
    let lean = 0;
    if (gm.leanAng[g] > 0 && t >= tf) {
      lean = gm.leanAng[g] * (gm.collapsed[g] ? easeOut(t, tf, gm.tc[g] * 0.9) : easeOut(t, tf, 1.6));
    }
    this.gLean = lean;
    return env;
  }

  apply(t: number): void {
    const gm = this.gm;
    if (!gm || !this.result) return;
    const { prep } = this;
    const B = this.ctx.city.buildings;
    const bh = this.deps.buildings;
    const st = this.st;
    const ng = prep.groups.length;
    for (let g = 0; g < ng; g++) {
      const grp = prep.groups[g];
      this.evalGroup(g, t);
      const H = grp.height;
      const lean = this.gLean;
      const ldx = Math.cos(gm.leanDir[g]);
      const ldz = Math.sin(gm.leanDir[g]);
      const tf = gm.tf[g];
      // Collapse: current roof height of the group.
      let Ht = H;
      let crushG = 0;
      if (gm.collapsed[g]) Ht = H - H * gm.cf[g] * collapseFall(t, tf, gm.tc[g]);
      else if (gm.cf[g] > 0 && t >= tf) crushG = gm.cf[g] * easeOut(t, tf, 2.5); // liquefaction settlement
      const dmg = gm.state[g] * smoothstep(tf - 0.6, tf + 0.6, t);
      const hidden = t >= gm.hideAt[g] ? 1 : 0;
      for (const i of grp.members) {
        const Hi = Math.max(B[i].height, 0.5);
        const k = Hi / H;
        st.shakeX = this.gx * k;
        st.shakeZ = this.gz * k;
        st.tiltX = 0;
        st.tiltZ = 0;
        if (lean > 0) {
          if (gm.multi[g]) {
            // Shear lean: displacement at absolute height h is h·tan(lean) for every part.
            const d = Math.tan(lean) * Hi;
            st.shakeX += d * ldx;
            st.shakeZ += d * ldz;
          } else {
            // Rotation about X moves the roof toward +z; about Z (right-handed) moves it toward −x.
            st.tiltX = lean * ldz;
            st.tiltZ = -lean * ldx;
          }
        }
        st.crush = gm.collapsed[g] ? clamp01(1 - Math.min(Hi, Ht) / Hi) : crushG;
        st.damage = dmg;
        st.lightsOut = this.lightsOutAt(i, t);
        st.hidden = this.replaced.has(i) ? 1 : hidden;
        bh.setState(i, st);
      }
    }
    bh.commit();
    this.applyLandmarks(t);
    this.applyPower(t);
  }

  // ── Landmarks ──────────────────────────────────────────────────────────

  private linkLandmarks(): void {
    this.restoreLandmarks();
    this.landmarks = [];
    const seen = new Set<THREE.Object3D>();
    const B = this.ctx.city.buildings;
    for (let i = 0; i < B.length; i++) {
      const obj = this.deps.landmarks.objectForBuilding(B[i].id);
      if (!obj || seen.has(obj)) continue;
      seen.add(obj);
      this.landmarks.push({
        obj,
        group: this.prep.groupOf[i],
        q0: obj.quaternion.clone(),
        p0: obj.position.clone(),
        s0: obj.scale.clone(),
      });
    }
  }

  private applyLandmarks(t: number): void {
    const gm = this.gm!;
    for (const l of this.landmarks) {
      const g = l.group;
      this.evalGroup(g, t);
      const H = this.prep.groups[g].height;
      // Rigid rocking about the base pivot: roof displacement d ↔ angle d / H.
      let ax = this.gz / H;
      let az = -this.gx / H;
      if (this.gLean > 0) {
        ax += this.gLean * Math.sin(gm.leanDir[g]);
        az += -this.gLean * Math.cos(gm.leanDir[g]);
      }
      this.tmpQ.setFromEuler(this.tmpE.set(ax, 0, az, 'XZY'));
      l.obj.quaternion.copy(this.tmpQ).multiply(l.q0);
      const crush = gm.collapsed[g] ? gm.cf[g] * collapseFall(t, gm.tf[g], gm.tc[g]) : 0;
      l.obj.scale.set(l.s0.x, l.s0.y * (1 - crush), l.s0.z);
      l.obj.position.copy(l.p0);
    }
  }

  private restoreLandmarks(): void {
    for (const l of this.landmarks) {
      l.obj.quaternion.copy(l.q0);
      l.obj.position.copy(l.p0);
      l.obj.scale.copy(l.s0);
    }
  }

  // ── Power grid ─────────────────────────────────────────────────────────

  private buildPower(result: QuakeResult): void {
    const { prep } = this;
    const B = this.ctx.city.buildings;
    const n = prep.n;
    const map = new Map<number, number>();
    const acc: { tS: number; mmi: number; cnt: number; key: number }[] = [];
    this.sectorOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const key = Math.floor((prep.cx[i] + 5000) / SECTOR) * 1000 + Math.floor((prep.cz[i] + 5000) / SECTOR);
      let s = map.get(key);
      if (s === undefined) {
        s = acc.length;
        map.set(key, s);
        acc.push({ tS: Infinity, mmi: 0, cnt: 0, key });
      }
      this.sectorOf[i] = s;
      const sh = result.shaking[i];
      acc[s].tS = Math.min(acc[s].tS, sh.sArrivalS);
      acc[s].mmi += sh.mmi;
      acc[s].cnt++;
    }
    this.sectors = acc.map((a) => {
      const mmi = a.mmi / a.cnt;
      const seed = hash01(a.key, 31);
      const pOut = smoothstep(5.5, 6.9, mmi);
      return {
        tS: a.tS,
        out: hash01(a.key, 37) < pOut,
        // Sectors trip one after another as strong shaking arrives and protection cascades.
        tOut: a.tS + 0.4 + 3.6 * hash01(a.key, 41),
        seed: seed * 100,
        weight: a.cnt / n,
      };
    });
    this.emergency = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = B[i];
      const big = b.height > 40 && (b.use === 'hotel' || b.use === 'office' || b.use === 'civic');
      const h = hash01(hashStr(b.parentId ?? b.id), 53);
      // Generators: dim emergency lighting (lightsOut 0.8 ⇒ 20 % of windows stay lit).
      this.emergency[i] = big ? (h < 0.22 ? 0.9 : 1) : h < 0.025 ? 0.9 : 1;
    }
  }

  private sectorOut(s: Sector, t: number): number {
    if (!s.out) {
      // Brown-out dips while the strong shaking passes, then the lights recover.
      if (t >= s.tS && t < s.tS + 2.5) return 0.55 * flicker(t, s.seed, 9);
      return 0;
    }
    if (t < s.tOut - 1.6) return t >= s.tS - 0.2 ? 0.4 * flicker(t, s.seed, 7) : 0;
    if (t < s.tOut) return flicker(t, s.seed + 3, 14);
    return 1;
  }

  private lightsOutAt(i: number, t: number): number {
    const s = this.sectors[this.sectorOf[i]];
    const o = this.sectorOut(s, t);
    if (o < 1 || !s.out) return o;
    const em = this.emergency[i];
    if (em >= 1) return 1;
    // Generators kick in ~2 s after the outage, with a stutter.
    if (t < s.tOut + 1.8) return 1;
    if (t < s.tOut + 2.4) return flicker(t, s.seed + 9, 16) ? 1 : em;
    return em;
  }

  private applyPower(t: number): void {
    let out = 0;
    for (const s of this.sectors) out += s.weight * this.sectorOut(s, t);
    this.powerOut = clamp01(out);
    this.deps.streets.setPowerOut(this.powerOut);
    (this.deps.landmarks as { setPowerOut?: (a: number) => void }).setPowerOut?.(this.powerOut);
  }

  // ── Ground & camera ────────────────────────────────────────────────────

  /**
   * Shake the whole city root (small, decaying ground motion at the camera's focus) and the camera.
   * `focus` = world point the camera looks at; `live` = playback running (no camera shake while paused).
   */
  applyGround(t: number, focus: THREE.Vector3, camDist: number, live: boolean): void {
    const gm = this.gm;
    if (!gm) return;
    const g = this.nearestGroup(focus.x, focus.z);
    if (g < 0) return;
    const env = shakeEnvelope(t, gm.pA[g], gm.sA[g], gm.dur[g]);
    const pgv = gm.pgv[g] / 100;
    const ag = Math.min(0.45, pgv * 0.45) * env;
    const ph = 1.234;
    const root = this.ctx.cityRoot;
    root.position.set(
      this.rootPos0.x + ag * wobble(t, 1.05, ph),
      this.rootPos0.y + ag * 0.35 * wobble(t, 1.9, ph + 1.1),
      this.rootPos0.z + ag * wobble(t, 0.87, ph + 2.7),
    );
    if (live) {
      const intensity = env * Math.min(1, pgv * 1.3 + 0.08);
      this.deps.engine.setCameraShake(intensity * (0.1 + 0.0016 * camDist));
    }
  }

  private scratch: number[] = [];
  private nearestGroup(x: number, z: number): number {
    const { prep } = this;
    let r = 150;
    let list = prep.near(x, z, r, this.scratch);
    while (!list.length && r < 3000) list = prep.near(x, z, (r *= 2), this.scratch);
    if (!list.length) return -1;
    let best = list[0];
    let bd = Infinity;
    for (const i of list) {
      const d = (prep.cx[i] - x) ** 2 + (prep.cz[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return prep.groupOf[best];
  }

  /** Local shaking envelope × PGV (m/s) at a point — used by audio and dust kicks. */
  intensityAt(x: number, z: number, t: number): number {
    const gm = this.gm;
    if (!gm) return 0;
    const g = this.nearestGroup(x, z);
    if (g < 0) return 0;
    return shakeEnvelope(t, gm.pA[g], gm.sA[g], gm.dur[g]) * (gm.pgv[g] / 100);
  }

  /** P-phase rattle share (0..1) at a point — sound cue for the first jolt. */
  pPhaseAt(x: number, z: number, t: number): number {
    const gm = this.gm;
    if (!gm) return 0;
    const g = this.nearestGroup(x, z);
    return g < 0 ? 0 : pPhase(t, gm.pA[g], gm.sA[g]);
  }

  clear(): void {
    const bh = this.deps.buildings;
    bh.resetAll();
    for (const i of this.replaced) bh.setState(i, { hidden: 1 });
    bh.commit();
    this.restoreLandmarks();
    this.ctx.cityRoot.position.copy(this.rootPos0);
    this.deps.streets.setPowerOut(0);
    (this.deps.landmarks as { setPowerOut?: (a: number) => void }).setPowerOut?.(0);
    this.powerOut = 0;
    this.gm = null;
    this.result = null;
  }
}
