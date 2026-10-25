/**
 * M4 drone fleet: 3 survey quadcopters D1–D3 staged at Embarcadero Plaza, flying Argon-planned, commander-approved
 * verification missions (see flight.ts for the flight profile).
 *
 * createDroneFleet(ctx) → DroneFleetHandle. The integrator adds `object` to the scene and calls
 *   fleet.setTime(simSeconds) every tick (visuals), fleet.posesAt(simSeconds) for capture poses,
 *   fleet.assign(approvedMissions, simSeconds) on Approve, fleet.reset() on quake reset.
 * Poses / paths / markers are pure functions of simS + assignments (seek-safe). Rotor spin, marker pulse and the
 * far-view display scale use wall-clock time. Everything lives on DRONE_LAYER: the main camera sees it, capture
 * cameras (layer 0 only) do not, so drone footage never shows drones, paths or markers.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { AppContext, DroneFleetHandle, DroneId, DroneMission, DronePose, DroneScheduleEntry, XZ } from '../contracts';
import { groundAt } from '../air/heli/route';
import {
  ALTITUDE_AGL,
  BASE,
  CAM_FOV_DEG,
  Clearance,
  DRONE_IDS,
  ENDURANCE_S,
  ORBIT_S,
  PAD_OFFSET,
  SPEED_MS,
  footprintFor,
  groupBuildings,
  parkedState,
  planMission,
  samplePlan,
  type FlightPlan,
  type PlanEnv,
  type RawState,
} from './flight';
import { buildDroneModel, type DroneModel } from './model';

export { BASE, SPEED_MS, ALTITUDE_AGL, ORBIT_S, ENDURANCE_S, CAM_FOV_DEG, DRONE_IDS };

/** Render layer for drones + their overlays (main camera only). */
export const DRONE_LAYER = 10;
/** Accent colour per drone (CSS hex) — reuse in UI (feeds, plan card). */
export const DRONE_COLOURS: Record<DroneId, string> = { D1: '#2ee6ff', D2: '#ffb21e', D3: '#ff4fe8' };

const EDGE_SUB = 6;

function lineMat(color: THREE.Color, width: number, opacity: number, dashed = false, depthTest = true) {
  const m = new LineMaterial({
    color: color.getHex(),
    linewidth: width,
    transparent: true,
    opacity,
    dashed,
    dashSize: 10,
    gapSize: 8,
    depthWrite: false,
    depthTest,
  });
  m.fog = false;
  m.toneMapped = false;
  m.color.copy(color).multiplyScalar(1.2);
  return m;
}

function writeSegments(geo: LineSegmentsGeometry, pts: ArrayLike<number>, count: number) {
  const attr = geo.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
  const arr = attr.data.array as Float32Array;
  for (let i = 0; i < count * 6 && i < arr.length; i++) arr[i] = pts[i];
  attr.data.needsUpdate = true;
  geo.instanceCount = count;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(text: string, colour: string): THREE.CanvasTexture {
  return canvasTex(128, 64, (g) => {
    g.fillStyle = 'rgba(8,12,18,0.82)';
    g.strokeStyle = colour;
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(8, 8, 112, 40, 12);
    g.fill();
    g.stroke();
    // Pointer.
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(56, 50);
    g.lineTo(72, 50);
    g.lineTo(64, 62);
    g.closePath();
    g.fill();
    g.font = 'bold 30px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = colour;
    g.fillText(text, 64, 30);
  });
}

function numberTexture(n: number, colour: string): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    g.fillStyle = colour;
    g.beginPath();
    g.arc(32, 32, 26, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(8,12,18,0.9)';
    g.lineWidth = 4;
    g.stroke();
    g.font = 'bold 34px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#0a0e14';
    g.fillText(String(n), 32, 34);
  });
}

interface DroneVis {
  id: DroneId;
  colour: THREE.Color;
  body: THREE.Group;
  scaler: THREE.Group;
  model: DroneModel;
  label: THREE.Sprite;
  pad: THREE.Mesh;
  outlineGeo: LineSegmentsGeometry;
  outline: THREE.Object3D[];
  frGeo: LineSegmentsGeometry;
  frustum: LineSegments2;
  airborne: boolean;
  displayScale: number;
}

interface PlanVis {
  plan: FlightPlan;
  group: THREE.Group;
  flownGeo: LineGeometry;
  flown: Line2;
  aheadGeo: LineGeometry;
  ahead: Line2;
  markers: { ring: THREE.Mesh; num: THREE.Sprite; mat: THREE.MeshBasicMaterial; state: 'pending' | 'current' | 'done' }[];
  disposables: { dispose(): void }[];
}

export function createDroneFleet(ctx: AppContext): DroneFleetHandle {
  const object = new THREE.Group();
  object.name = 'drone-fleet';
  object.visible = false;
  const setLayer = (o: THREE.Object3D) => o.traverse((c) => c.layers.set(DRONE_LAYER));
  ctx.camera.layers.enable(DRONE_LAYER);

  const env: PlanEnv = { terrain: ctx.terrain, clearance: new Clearance(ctx.city.buildings), groups: groupBuildings(ctx.city.buildings) };

  // ── Base: helipad-style markings ──
  const baseGroup = new THREE.Group();
  object.add(baseGroup);
  const padTex = canvasTex(128, 128, (g) => {
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.stroke();
    g.font = 'bold 64px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillText('H', 64, 68);
  });
  const padGeo = new THREE.CircleGeometry(2.4, 32);
  padGeo.rotateX(-Math.PI / 2);

  // ── Drones ──
  const drones: DroneVis[] = DRONE_IDS.map((id) => {
    const colour = new THREE.Color(DRONE_COLOURS[id]);
    const body = new THREE.Group();
    body.rotation.order = 'YXZ';
    const scaler = new THREE.Group();
    const model = buildDroneModel(colour);
    scaler.add(model.root);
    body.add(scaler);
    const lmat = new THREE.SpriteMaterial({ map: labelTexture(id, DRONE_COLOURS[id]), sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false });
    lmat.toneMapped = false;
    const label = new THREE.Sprite(lmat);
    label.center.set(0.5, 0);
    label.scale.set(0.05, 0.025, 1);
    label.renderOrder = 22;
    body.add(label);
    object.add(body);

    const off = PAD_OFFSET[id];
    const px = BASE[0] + off[0];
    const pz = BASE[1] + off[1];
    const padMat = new THREE.MeshBasicMaterial({ map: padTex, color: colour.clone().multiplyScalar(1.1), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false });
    padMat.toneMapped = false;
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(px, groundAt(ctx.terrain, px, pz) + 0.08, pz);
    pad.renderOrder = 5;
    baseGroup.add(pad);

    const ringN = 8 * EDGE_SUB;
    const outlineGeo = new LineSegmentsGeometry();
    outlineGeo.setPositions(new Float32Array(ringN * 6));
    const o1 = new LineSegments2(outlineGeo, lineMat(colour, 1.8, 0.9));
    const o2 = new LineSegments2(outlineGeo, lineMat(colour, 1.0, 0.25, false, false));
    for (const o of [o1, o2]) {
      o.frustumCulled = false;
      o.renderOrder = 12;
      object.add(o);
    }
    const frGeo = new LineSegmentsGeometry();
    frGeo.setPositions(new Float32Array(4 * 6));
    const frustum = new LineSegments2(frGeo, lineMat(colour, 1.0, 0.3));
    frustum.frustumCulled = false;
    frustum.renderOrder = 11;
    object.add(frustum);
    return { id, colour, body, scaler, model, label, pad, outlineGeo, outline: [o1, o2], frGeo, frustum, airborne: false, displayScale: 1 };
  });

  const plans: FlightPlan[] = [];
  const planVis: PlanVis[] = [];
  let curSimS: number | null = null;

  // ── Planning ──
  function freeAt(id: DroneId): number {
    let t = -Infinity;
    for (const p of plans) if (p.droneId === id) t = Math.max(t, p.endS);
    return t;
  }

  function buildPlanVis(plan: FlightPlan): PlanVis {
    const colour = new THREE.Color(DRONE_COLOURS[plan.droneId]);
    const group = new THREE.Group();
    group.name = `drone-plan-${plan.missionId}`;
    const disposables: { dispose(): void }[] = [];
    const pts = plan.pathPts.length >= 6 ? plan.pathPts : [...plan.pathPts, ...plan.pathPts];
    const n = pts.length / 3;
    const rev: number[] = [];
    for (let i = n - 1; i >= 0; i--) rev.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    const flownGeo = new LineGeometry();
    flownGeo.setPositions(pts);
    const flownMat = lineMat(colour, 2.4, 0.9);
    const flown = new Line2(flownGeo, flownMat);
    flown.frustumCulled = false;
    flown.renderOrder = 10;
    const aheadGeo = new LineGeometry();
    aheadGeo.setPositions(rev);
    const aheadMat = lineMat(colour, 1.6, 0.75, true);
    const ahead = new Line2(aheadGeo, aheadMat);
    ahead.computeLineDistances();
    ahead.frustumCulled = false;
    ahead.renderOrder = 10;
    group.add(flown, ahead);
    disposables.push(flownGeo, flownMat, aheadGeo, aheadMat);

    const markers: PlanVis['markers'] = plan.targets.map((tg, k) => {
      const r = THREE.MathUtils.clamp(tg.radius + 4, 9, 45);
      const geo = new THREE.RingGeometry(r - Math.max(1.2, r * 0.1), r, 48);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: colour.clone().multiplyScalar(1.4), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, fog: false });
      mat.toneMapped = false;
      const ring = new THREE.Mesh(geo, mat);
      ring.position.set(tg.cx, tg.roofY + 1.5, tg.cz);
      ring.renderOrder = 13;
      const tex = numberTexture(k + 1, DRONE_COLOURS[plan.droneId]);
      const nmat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false });
      nmat.toneMapped = false;
      const num = new THREE.Sprite(nmat);
      num.center.set(0.5, 0);
      num.scale.set(0.024, 0.024, 1);
      num.position.set(tg.cx, tg.roofY + 4, tg.cz);
      num.renderOrder = 21;
      group.add(ring, num);
      disposables.push(geo, mat, tex, nmat);
      return { ring, num, mat, state: 'pending' as const };
    });
    setLayer(group);
    object.add(group);
    return { plan, group, flownGeo, flown, aheadGeo, ahead, markers, disposables };
  }

  function assign(missions: DroneMission[], startSimS: number) {
    for (const m of missions) {
      if (!m || !DRONE_IDS.includes(m.droneId)) continue;
      if (plans.some((p) => p.missionId === m.id)) continue; // idempotent per mission id
      const start = Math.max(startSimS, freeAt(m.droneId));
      const plan = planMission(env, m, start, startSimS, ORBIT_S);
      if (!plan) continue;
      plans.push(plan);
      planVis.push(buildPlanVis(plan));
    }
    plans.sort((a, b) => a.startS - b.startS);
    if (curSimS !== null) setTime(curSimS);
  }

  // ── Sampling ──
  function rawAt(id: DroneId, simS: number, out: RawState, withCam: boolean): RawState {
    let flown = false;
    for (const p of plans) {
      if (p.droneId !== id) continue;
      if (simS >= p.startS && simS < p.endS) return samplePlan(env, p, simS, out, withCam);
      if (simS >= p.endS) flown = true;
    }
    return parkedState(env, id, flown ? 'done' : 'idle', out);
  }

  function poseOf(id: DroneId, s: RawState): DronePose {
    return {
      flightS: s.flightS,
      position: [s.x, s.y, s.z],
      heading: s.heading,
      cameraTarget: [s.cx, s.cy, s.cz],
      fovDeg: CAM_FOV_DEG,
      footprint: footprintFor(ctx.terrain, s),
      droneId: id,
      phase: s.phase,
      missionId: s.missionId,
      targetIndex: s.targetIndex,
    };
  }

  function posesAt(simS: number): DronePose[] {
    return DRONE_IDS.map((id) => poseOf(id, rawAt(id, simS, {} as RawState, true)));
  }

  function schedule(): DroneScheduleEntry[] {
    return plans.map((p) => ({
      missionId: p.missionId,
      droneId: p.droneId,
      startS: p.startS,
      targets: p.targets.map((t) => ({ buildingId: t.buildingId, arriveS: t.arriveS, leaveS: t.leaveS })),
      endS: p.endS,
    }));
  }

  function available(simS: number): DroneId[] {
    return DRONE_IDS.filter((id) => !plans.some((p) => p.droneId === id && p.endS > simS));
  }

  // ── Visual update ──
  const st = {} as RawState;
  const stPrev = {} as RawState;
  const ring = new Float32Array(8 * EDGE_SUB * 6);
  const fr = new Float32Array(4 * 6);
  const ringXZ: number[] = [];

  function drapeOutline(d: DroneVis, fp: XZ[], s: RawState) {
    const m = fp.length;
    ringXZ.length = 0;
    for (let e = 0; e < m; e++) {
      const [ax, az] = fp[e];
      const [bx, bz] = fp[(e + 1) % m];
      for (let k = 0; k < EDGE_SUB; k++) {
        const u = k / EDGE_SUB;
        ringXZ.push(ax + (bx - ax) * u, az + (bz - az) * u);
      }
    }
    const n = ringXZ.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ringXZ[i * 2];
      const z0 = ringXZ[i * 2 + 1];
      const x1 = ringXZ[j * 2];
      const z1 = ringXZ[j * 2 + 1];
      ring.set([x0, groundAt(ctx.terrain, x0, z0) + 2, z0, x1, groundAt(ctx.terrain, x1, z1) + 2, z1], i * 6);
    }
    writeSegments(d.outlineGeo, ring, n);
    const step = Math.max(1, Math.floor(m / 4));
    for (let c = 0; c < 4; c++) {
      const [x, z] = fp[(c * step) % m];
      fr.set([s.x, s.y - 0.2, s.z, x, groundAt(ctx.terrain, x, z) + 2, z], c * 6);
    }
    writeSegments(d.frGeo, fr, 4);
  }

  function setTime(simS: number) {
    if (!Number.isFinite(simS)) {
      curSimS = null;
      object.visible = false;
      return;
    }
    curSimS = simS;
    object.visible = true;
    for (const d of drones) {
      rawAt(d.id, simS, st, true);
      rawAt(d.id, simS - 0.25, stPrev, false);
      d.airborne = st.airborne;
      d.body.position.set(st.x, st.y, st.z);
      // Attitude from velocity in the body frame (nose-down when flying forward, bank into lateral motion).
      let pitch = 0;
      let roll = 0;
      if (st.airborne && stPrev.airborne) {
        const vx = (st.x - stPrev.x) / 0.25;
        const vz = (st.z - stPrev.z) / 0.25;
        const fwd = vx * Math.sin(st.heading) - vz * Math.cos(st.heading);
        const right = vx * Math.cos(st.heading) + vz * Math.sin(st.heading);
        pitch = -THREE.MathUtils.clamp(fwd * 0.014, -0.28, 0.28);
        roll = -THREE.MathUtils.clamp(right * 0.014, -0.28, 0.28);
      }
      d.body.rotation.set(pitch, -st.heading, roll, 'YXZ');
      // Gimbal pitch toward the camera target (visual only).
      const dh = Math.hypot(st.cx - st.x, st.cz - st.z);
      d.model.gimbal.rotation.x = st.airborne ? -Math.atan2(st.y - st.cy, Math.max(1, dh)) - pitch : 0;
      const showFp = st.airborne;
      const orbiting = st.phase === 'orbit';
      for (const o of d.outline) o.visible = showFp;
      (d.outline[0] as LineSegments2).material.opacity = orbiting ? 0.95 : 0.45;
      d.frustum.visible = showFp && orbiting;
      if (showFp) drapeOutline(d, footprintFor(ctx.terrain, st), st);
    }
    for (const pv of planVis) {
      const p = pv.plan;
      const vis = simS >= p.assignedAt;
      pv.group.visible = vis;
      if (!vis) continue;
      const n = p.pathT.length;
      // Index of the last path point at or before simS.
      let lo = 0;
      let hi = n - 1;
      if (simS <= p.pathT[0]) hi = 0;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (p.pathT[mid] <= simS) lo = mid;
          else hi = mid - 1;
        }
      }
      const k = simS <= p.pathT[0] ? 0 : lo;
      pv.flownGeo.instanceCount = Math.max(0, k);
      pv.aheadGeo.instanceCount = Math.max(0, n - 1 - k);
      const done = simS >= p.endS;
      (pv.flown.material as LineMaterial).opacity = done ? 0.35 : 0.9;
      const active = simS >= p.startS && simS < p.endS;
      let curIdx = -1;
      if (active) {
        rawAt(p.droneId, simS, st, false);
        if (st.missionId === p.missionId && st.targetIndex !== undefined) curIdx = st.targetIndex;
      }
      pv.markers.forEach((mk, i) => {
        const tg = p.targets[i];
        mk.state = simS >= tg.leaveS ? 'done' : i === curIdx ? 'current' : 'pending';
        mk.mat.opacity = mk.state === 'done' ? 0.3 : mk.state === 'current' ? 0.95 : 0.6;
        (mk.num.material as THREE.SpriteMaterial).opacity = mk.state === 'done' ? 0.45 : 1;
        if (mk.state !== 'current') mk.ring.scale.setScalar(1);
      });
    }
  }

  // ── Wall-clock animation: rotors, strobes, marker pulse, far-view display scale ──
  const _wp = new THREE.Vector3();
  ctx.onUpdate((dt, elapsed) => {
    if (!object.visible) return;
    for (const d of drones) {
      d.body.getWorldPosition(_wp);
      const dist = ctx.camera.position.distanceTo(_wp);
      const s = THREE.MathUtils.clamp(1 + (dist - 60) / 90, 1, 7);
      if (Math.abs(s - d.displayScale) > 1e-3) {
        d.displayScale = s;
        d.scaler.scale.setScalar(s);
      }
      d.label.position.set(0, 0.5 * s + 0.6, 0);
      if (d.airborne) {
        d.model.rotors.forEach((r, i) => (r.rotation.y += (i === 0 || i === 3 ? 1 : -1) * dt * 90));
      }
      const ph = (elapsed + DRONE_IDS.indexOf(d.id) * 0.37) % 1.2;
      const on = ph < 0.07 || (ph > 0.18 && ph < 0.25);
      d.model.strobe[0].visible = on;
      d.model.strobe[1].visible = d.airborne ? elapsed % 1 < 0.5 : true;
    }
    const pulse = 1 + 0.14 * Math.sin(elapsed * 4.5);
    for (const pv of planVis) {
      if (!pv.group.visible) continue;
      for (const mk of pv.markers) if (mk.state === 'current') mk.ring.scale.setScalar(pulse);
    }
  });

  function reset() {
    plans.length = 0;
    for (const pv of planVis) {
      object.remove(pv.group);
      for (const d of pv.disposables) d.dispose();
    }
    planVis.length = 0;
    curSimS = null;
    object.visible = false;
  }

  setLayer(object);

  return {
    object,
    base: BASE,
    speedMs: SPEED_MS,
    altitudeAGL: ALTITUDE_AGL,
    orbitS: ORBIT_S,
    enduranceS: ENDURANCE_S,
    assign,
    posesAt,
    setTime,
    schedule,
    available,
    reset,
  };
}
