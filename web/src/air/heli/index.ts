/**
 * AIR 1 · SFPD — police helicopter on a hard-coded recon route (see route.ts for the flight plan).
 *
 * createHelicopter(ctx) → HelicopterHandle. The integrator drives it with
 *   heli.setFlightTime(simSeconds >= AIR_LAUNCH_S ? simSeconds - AIR_LAUNCH_S : null)
 * Everything (pose, rotors, strobes, footprint) is a pure function of the flight time, so seeking works.
 * The model + overlays live on HELI_LAYER, which this module enables on the main camera (ctx.camera);
 * the gimbal `camera` keeps the default layer only, so captured frames never show the helicopter itself,
 * the route line or the footprint.
 */
import * as THREE from 'three';
import type { AppContext, HeliPose, HelicopterHandle, XZ } from '../../contracts';
import { buildHeliModel, radialTexture } from './model';
import { createOverlay } from './overlay';
import {
  ALTITUDE_AGL,
  CAM_ASPECT,
  CAM_DEPRESSION_DEG,
  CAM_FOV_DEG,
  CAM_YAW_LEFT_DEG,
  FOOTPRINT_MAX_DIST,
  ROUTE_WAYPOINTS,
  SPEED_MS,
  buildRoute,
  groundAt,
  rayGround,
  sampleRoute,
  type RawPose,
} from './route';

/** Sim second at which AIR 1 launches (flightSeconds = simSeconds - AIR_LAUNCH_S). */
export const AIR_LAUNCH_S = 50;
/** Render layer for the helicopter model and its main-view overlays (not seen by the gimbal camera). */
export const HELI_LAYER = 9;

const DEG = Math.PI / 180;
/** Footprint rays in NDC, ordered around the frame: bottom-left → bottom → bottom-right → right → top-right → top → top-left → left. */
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

export { ROUTE_WAYPOINTS, ALTITUDE_AGL, SPEED_MS };

export function createHelicopter(ctx: AppContext): HelicopterHandle {
  const route = buildRoute(ctx.terrain, ctx.city.buildings);
  const durationS = route.length / SPEED_MS;
  const routeXZ: XZ[] = [];
  for (let i = 0; i < route.n; i += 10) routeXZ.push([route.x[i], route.z[i]]);
  routeXZ.push([route.x[route.n - 1], route.z[route.n - 1]]);

  const object = new THREE.Group();
  object.name = 'air1';
  object.visible = false;

  // ── Model (pose + display scale) ──
  const model = buildHeliModel();
  const body = new THREE.Group(); // positioned + oriented in world
  body.rotation.order = 'YXZ';
  body.add(model.root);
  object.add(body);

  // ── Night searchlight (slaved to the gimbal): additive cone + ground spot. No real light (no shader recompiles). ──
  const coneTex = (() => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const g = c.getContext('2d')!;
    // alphaMap reads luminance (green): white = opaque. Canvas top → uv.y = 1 → apex (heli) end.
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.3, '#5a5a5a');
    grd.addColorStop(1, '#1a1a1a');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 128);
    const t = new THREE.CanvasTexture(c);
    return t;
  })();
  const coneGeo = new THREE.CylinderGeometry(0.25, 1, 1, 24, 1, true);
  coneGeo.translate(0, -0.5, 0); // apex (top) at origin, extends down -Y
  coneGeo.rotateX(-Math.PI / 2); // now extends along +Z (Object3D.lookAt points +Z at the target)
  const coneMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.96, 0.85),
    alphaMap: coneTex,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: false,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.frustumCulled = false;
  object.add(cone);
  const spotMat = new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, 'rgba(255,250,235,1)'],
      [0.5, 'rgba(255,245,225,0.55)'],
      [1, 'rgba(255,240,220,0)'],
    ]),
    color: new THREE.Color(1.6, 1.55, 1.4),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: false,
  });
  const spot = new THREE.Mesh(new THREE.CircleGeometry(1, 32), spotMat);
  spot.frustumCulled = false;
  object.add(spot);

  // ── Far-view marker: thin ring + "AIR 1" at constant screen size, fades in beyond ~1 km. ──
  const markerTex = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.strokeStyle = 'rgba(140,230,255,1)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(128, 104, 44, 0, Math.PI * 2);
    g.stroke();
    g.font = 'bold 40px Helvetica, Arial, sans-serif';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(160,236,255,1)';
    g.fillText('AIR 1', 128, 200);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const markerMat = new THREE.SpriteMaterial({ map: markerTex, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false });
  markerMat.color.setScalar(1.3);
  const marker = new THREE.Sprite(markerMat);
  marker.center.set(0.5, 0.6);
  marker.scale.setScalar(0.075);
  marker.renderOrder = 20;
  body.add(marker);

  // ── Overlays ──
  const overlay = createOverlay(ctx.terrain, route);
  object.add(overlay.object);

  // Everything on HELI_LAYER; the main camera sees it, the gimbal camera does not.
  object.traverse((o) => o.layers.set(HELI_LAYER));
  ctx.camera.layers.enable(HELI_LAYER);

  // ── Gimbal camera ──
  const camera = new THREE.PerspectiveCamera(CAM_FOV_DEG, CAM_ASPECT, 2, 6000);
  camera.name = 'air1-gimbal';
  camera.layers.set(0);

  // ── Pose computation ──
  const raw: RawPose = { x: 0, y: 0, z: 0, heading: 0, bank: 0, pitch: 0, idx: 0 };
  const _eye = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tgt = new THREE.Vector3();
  const _hit = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _up = new THREE.Vector3(0, 1, 0);
  const _right = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const tanV = Math.tan((CAM_FOV_DEG * DEG) / 2);
  const tanH = tanV * CAM_ASPECT;

  /** Camera eye (under the nose) for a raw pose. */
  function eyeFor(r: RawPose, out: THREE.Vector3) {
    // Nose is ~2.4 m ahead of the mast, ~0.6 m above skid level; body origin is skid level.
    return out.set(r.x + Math.sin(r.heading) * 2.4, r.y + 0.55, r.z - Math.cos(r.heading) * 2.4);
  }

  function poseFromRaw(r: RawPose, flightS: number): HeliPose {
    eyeFor(r, _eye);
    const yaw = r.heading - CAM_YAW_LEFT_DEG * DEG;
    const dep = CAM_DEPRESSION_DEG * DEG;
    _dir.set(Math.sin(yaw) * Math.cos(dep), -Math.sin(dep), -Math.cos(yaw) * Math.cos(dep));
    rayGround(ctx.terrain, _eye, _dir, FOOTPRINT_MAX_DIST, _tgt);
    // Camera basis (lookAt, world up), then the 8 frustum-edge rays.
    _m.lookAt(_eye, _tgt, _up); // columns: x = right, y = up, z = back
    _right.setFromMatrixColumn(_m, 0);
    _camUp.setFromMatrixColumn(_m, 1);
    _fwd.setFromMatrixColumn(_m, 2).negate();
    const footprint: XZ[] = [];
    for (const [sx, sy] of NDC_RING) {
      _dir.copy(_fwd).addScaledVector(_right, sx * tanH).addScaledVector(_camUp, sy * tanV);
      // Rays above the horizon (never with these angles, but be safe) are pushed slightly down.
      if (_dir.y > -0.02) _dir.y = -0.02;
      rayGround(ctx.terrain, _eye, _dir, FOOTPRINT_MAX_DIST, _hit);
      footprint.push([_hit.x, _hit.z]);
    }
    return {
      flightS,
      position: [r.x, r.y, r.z],
      heading: ((r.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
      cameraTarget: [_tgt.x, _tgt.y, _tgt.z],
      fovDeg: CAM_FOV_DEG,
      footprint,
    };
  }

  function poseAt(flightS: number): HeliPose {
    const t = THREE.MathUtils.clamp(flightS, 0, durationS);
    sampleRoute(route, t, durationS, raw);
    return poseFromRaw(raw, t);
  }

  // ── Per-frame display scale (×1 near → ×2.5 from the overview), independent of sim time. ──
  let displayScale = 1;
  const _wp = new THREE.Vector3();
  ctx.onUpdate(() => {
    if (!object.visible) return;
    body.getWorldPosition(_wp);
    const d = ctx.camera.position.distanceTo(_wp);
    const s = THREE.MathUtils.clamp((d - 500) / 900 + 1, 1, 2.5);
    markerMat.opacity = 0.9 * THREE.MathUtils.smoothstep(d, 900, 1600);
    marker.visible = markerMat.opacity > 0.01;
    if (Math.abs(s - displayScale) > 1e-3) {
      displayScale = s;
      model.root.scale.setScalar(s);
    }
  });

  let flightTime: number | null = null;

  function setFlightTime(t: number | null) {
    if (t === null || !Number.isFinite(t)) {
      flightTime = null;
      object.visible = false;
      overlay.update(0, _eye, [], false);
      return;
    }
    const ft = THREE.MathUtils.clamp(t, 0, durationS);
    flightTime = ft;
    object.visible = true;
    sampleRoute(route, ft, durationS, raw);
    const pose = poseFromRaw(raw, ft);

    // Body.
    body.position.set(raw.x, raw.y, raw.z);
    body.rotation.set(raw.pitch, -raw.heading, -raw.bank, 'YXZ');

    // Rotors (deterministic from flight time; ~6.5 rev/s main, ~35 rev/s tail).
    model.mainRotor.rotation.y = -(ft * 6.5 * Math.PI * 2) % (Math.PI * 2);
    model.tailRotor.rotation.x = (ft * 35 * Math.PI * 2) % (Math.PI * 2);

    // Lights: strobe double-flash every 1.3 s, beacon 1 Hz.
    const ph = ft % 1.3;
    const strobeOn = ph < 0.06 || (ph > 0.16 && ph < 0.22);
    for (const o of model.strobe) o.visible = strobeOn;
    for (const o of model.beacon) o.visible = ft % 1.0 < 0.5;

    // Gimbal camera.
    eyeFor(raw, _eye);
    camera.position.copy(_eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(pose.cameraTarget[0], pose.cameraTarget[1], pose.cameraTarget[2]);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // Searchlight at night, pointed at the gimbal target.
    const night = THREE.MathUtils.smoothstep(ctx.env.nightFactor, 0.25, 0.7);
    if (night > 0.01) {
      _tgt.set(pose.cameraTarget[0], pose.cameraTarget[1], pose.cameraTarget[2]);
      const L = _eye.distanceTo(_tgt);
      const r = L * Math.tan(3.2 * DEG);
      cone.position.copy(_eye);
      cone.lookAt(_tgt);
      cone.scale.set(r, r, L);
      cone.visible = true;
      coneMat.opacity = 0.045 * night;
      const n = ctx.terrain.normalAt(_tgt.x, _tgt.z, _hit);
      spot.position.set(_tgt.x, groundAt(ctx.terrain, _tgt.x, _tgt.z) + 0.6, _tgt.z);
      spot.quaternion.setFromUnitVectors(_fwd.set(0, 0, 1), n.y > 0.2 ? n : _up);
      // Ellipse stretched along the beam's ground track.
      spot.scale.setScalar(r * 1.25);
      spot.visible = true;
      spotMat.opacity = 0.9 * night;
    } else {
      cone.visible = false;
      spot.visible = false;
    }

    overlay.update(raw.idx, _eye, pose.footprint, true);
  }

  return {
    object,
    callsign: 'AIR 1 · SFPD',
    route: routeXZ,
    durationS,
    altitudeAGL: ALTITUDE_AGL,
    poseAt,
    camera,
    setFlightTime,
    get flightTime() {
      return flightTime;
    },
  };
}
