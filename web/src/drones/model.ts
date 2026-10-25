/**
 * Survey quadcopter (~1 m motor-to-motor diagonal): X-frame arms, 4 motors with accent-coloured bells,
 * 4 translucent rotor discs, body shell with accent stripe, 3-axis camera gimbal under the nose, landing legs,
 * red/green nav lights (front left/right), white tail lights and a top strobe.
 * Local frame: forward = -Z, up = +Y, right = +X; origin at the feet (bottom of the landing legs).
 */
import * as THREE from 'three';

export interface DroneModel {
  root: THREE.Group;
  rotors: THREE.Object3D[];
  strobe: THREE.Object3D[];
  /** Gimbal (pitch it to aim the camera). */
  gimbal: THREE.Group;
}

let glowTex: THREE.CanvasTexture | null = null;
let rotorTex: THREE.CanvasTexture | null = null;

function radial(stops: [number, string][], size = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rotorTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.translate(S / 2, S / 2);
  // Motion-blur disc.
  const grd = g.createRadialGradient(0, 0, 4, 0, 0, S / 2);
  grd.addColorStop(0, 'rgba(40,44,52,0.55)');
  grd.addColorStop(0.85, 'rgba(60,64,72,0.28)');
  grd.addColorStop(1, 'rgba(60,64,72,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, S / 2, 0, Math.PI * 2);
  g.fill();
  // Two blades (slightly smeared).
  for (let k = 0; k < 2; k++) {
    g.save();
    g.rotate(k * Math.PI);
    for (let s = 0; s < 4; s++) {
      g.rotate(0.08);
      g.fillStyle = `rgba(25,27,32,${0.55 - s * 0.12})`;
      g.beginPath();
      g.ellipse(S * 0.24, 0, S * 0.24, S * 0.035, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildDroneModel(accent: THREE.Color): DroneModel {
  glowTex ??= radial([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.6)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  rotorTex ??= rotorTexture();

  const root = new THREE.Group();
  root.name = 'drone-model';
  const shell = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.45, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.6, metalness: 0.4 });
  const light = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.4, metalness: 0.2 });
  const acc = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.2 });

  const BODY_Y = 0.24;
  // Body: flat box + rounded top shell + accent stripe.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.4), shell);
  body.position.set(0, BODY_Y, 0);
  root.add(body);
  const topGeo = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const shellAcc = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.25 });
  const top = new THREE.Mesh(topGeo, shellAcc);
  top.scale.set(0.14, 0.07, 0.22);
  top.position.set(0, BODY_Y + 0.045, -0.01);
  root.add(top);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.36), light);
  stripe.position.set(0, BODY_Y + 0.105, -0.01);
  root.add(stripe);
  // Battery pack at the rear.
  const batt = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.16), dark);
  batt.position.set(0, BODY_Y + 0.06, 0.14);
  root.add(batt);

  // X arms + motors + rotors.
  const ARM = 0.36; // motor offset on each axis (diagonal ≈ 1.02 m)
  const armLen = Math.hypot(ARM, ARM) * 2 + 0.06;
  for (const sgn of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.03, 0.045), dark);
    arm.position.set(0, BODY_Y + 0.01, 0);
    arm.rotation.y = (sgn * Math.PI) / 4;
    root.add(arm);
  }
  const rotors: THREE.Object3D[] = [];
  const motorGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.06, 14);
  const bellGeo = new THREE.CylinderGeometry(0.047, 0.047, 0.025, 14);
  const discGeo = new THREE.CircleGeometry(0.21, 32);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({ map: rotorTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const legGeo = new THREE.CylinderGeometry(0.008, 0.008, BODY_Y, 6);
  for (const [mx, mz] of [
    [ARM, -ARM],
    [-ARM, -ARM],
    [ARM, ARM],
    [-ARM, ARM],
  ]) {
    const motor = new THREE.Mesh(motorGeo, dark);
    motor.position.set(mx, BODY_Y + 0.04, mz);
    root.add(motor);
    const bell = new THREE.Mesh(bellGeo, acc);
    bell.position.set(mx, BODY_Y + 0.08, mz);
    root.add(bell);
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(mx, BODY_Y + 0.1, mz);
    disc.renderOrder = 3;
    root.add(disc);
    rotors.push(disc);
    // Landing leg under each motor.
    const leg = new THREE.Mesh(legGeo, dark);
    leg.position.set(mx * 0.92, BODY_Y / 2, mz * 0.92);
    root.add(leg);
  }

  // Camera gimbal under the nose.
  const gimbal = new THREE.Group();
  gimbal.position.set(0, BODY_Y - 0.07, -0.17);
  const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.03), dark);
  yoke.position.set(0, 0.02, 0);
  root.add(gimbal);
  gimbal.add(yoke);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), light);
  gimbal.add(cam);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0x0a1020, roughness: 0.1, metalness: 0.9 }));
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.04);
  gimbal.add(lens);

  // Lights: emissive cores + additive glow sprites.
  const lamp = (color: number, pos: THREE.Vector3, glow: number) => {
    const g = new THREE.Group();
    g.position.copy(pos);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(4) }));
    g.add(core);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: new THREE.Color(color).multiplyScalar(2.5),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      }),
    );
    spr.scale.setScalar(glow);
    g.add(spr);
    root.add(g);
    return g;
  };
  lamp(0xff2020, new THREE.Vector3(-ARM, BODY_Y + 0.0, -ARM - 0.05), 0.22);
  lamp(0x20ff50, new THREE.Vector3(ARM, BODY_Y + 0.0, -ARM - 0.05), 0.22);
  lamp(0xffffff, new THREE.Vector3(-ARM, BODY_Y + 0.0, ARM + 0.05), 0.16);
  lamp(0xffffff, new THREE.Vector3(ARM, BODY_Y + 0.0, ARM + 0.05), 0.16);
  const strobe = [lamp(0xffffff, new THREE.Vector3(0, BODY_Y + 0.13, 0.05), 0.45), lamp(accent.getHex(), new THREE.Vector3(0, BODY_Y - 0.06, 0.1), 0.35)];

  return { root, rotors, strobe, gimbal };
}
