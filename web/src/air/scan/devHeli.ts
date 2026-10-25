/**
 * Dev-only stand-in for the helicopter module (src/air/heli) so the scan module can be tested alone.
 * Not imported by the app; load from the console / playwright via `await import('/src/air/scan/devHeli.ts')`.
 */
import * as THREE from 'three';
import type { AppContext, HeliPose, HelicopterHandle, XZ } from '../../contracts';

const WP: XZ[] = [
  [980, -330], [400, -225], [0, -258], [-424, -262], [-790, -120], [-815, 90], [-720, 290],
  [-300, 214], [40, 140], [410, -215], [1000, -520],
];

export function createDevHeli(ctx: AppContext): HelicopterHandle {
  const curve = new THREE.CatmullRomCurve3(WP.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const len = curve.getLength();
  const speed = 39;
  const durationS = len / speed;
  const ground = (x: number, z: number) => Math.max(ctx.terrain.heightAt(x, z), 0);
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 3, 9000);
  const object = new THREE.Mesh(new THREE.BoxGeometry(12, 4, 4), new THREE.MeshBasicMaterial({ color: 0x222222 }));
  object.visible = false;
  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();

  const rayGround = (o: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 => {
    let t = 0;
    for (; t < 900; t += 6) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y <= ground(x, z)) break;
    }
    return hit.copy(o).addScaledVector(d, t);
  };

  const poseAt = (flightS: number): HeliPose => {
    const t = THREE.MathUtils.clamp(flightS, 0, durationS);
    const u = t / durationS;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, tan);
    const heading = Math.atan2(tan.x, -tan.z);
    const y = ground(p.x, p.z) + 180 + 30;
    const pos = new THREE.Vector3(p.x, y, p.z);
    // Look left of heading, 42° down.
    const yaw = heading - (28 * Math.PI) / 180;
    const dep = (42 * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(dep), -Math.sin(dep), -Math.cos(yaw) * Math.cos(dep));
    const tgt = rayGround(pos, dir).clone();
    camera.fov = 32;
    camera.aspect = 16 / 9;
    camera.position.copy(pos);
    camera.lookAt(tgt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const fp: XZ[] = [];
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(pos).normalize();
      ray.set(pos, v);
      const h = rayGround(pos, v);
      fp.push([h.x, h.z]);
    }
    return { flightS: t, position: [pos.x, pos.y, pos.z], heading, cameraTarget: [tgt.x, tgt.y, tgt.z], fovDeg: 32, footprint: fp };
  };

  let flightTime: number | null = null;
  return {
    object,
    callsign: 'AIR 1 · SFPD',
    route: WP,
    durationS,
    altitudeAGL: 180,
    poseAt,
    camera,
    setFlightTime(t) {
      flightTime = t;
      if (t !== null) poseAt(t);
    },
    get flightTime() {
      return flightTime;
    },
  };
}
