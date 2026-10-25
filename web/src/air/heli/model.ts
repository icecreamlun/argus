/**
 * Airbus H125 / AS350-like police helicopter ("AIR 1 · SFPD"), true-to-size (≈ 10.9 m fuselage, 10.7 m rotor).
 * Local frame: forward = -Z, up = +Y, right = +X; origin at skid level under the rotor mast.
 */
import * as THREE from 'three';

export interface HeliModel {
  root: THREE.Group;
  mainRotor: THREE.Group;
  tailRotor: THREE.Group;
  navRed: THREE.Object3D[];
  navGreen: THREE.Object3D[];
  strobe: THREE.Object3D[];
  beacon: THREE.Object3D[];
  /** Searchlight / gimbal turret position in local frame. */
  noseMount: THREE.Vector3;
}

function liveryTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // White top, navy belly with a gold pinstripe.
  g.fillStyle = '#eef1f4';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#13244a';
  g.fillRect(0, H * 0.53, W, H * 0.47);
  g.fillStyle = '#d4a93a';
  g.fillRect(0, H * 0.5, W, H * 0.025);
  // Canopy: one wrap-around windshield at the nose (u≈0.5) + door windows (u≈0.3 right / 0.7 left).
  g.fillStyle = '#0b1420';
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.34, W * 0.17, H * 0.19, 0, 0, Math.PI * 2);
  g.fill();
  g.fillRect(W * 0.38, H * 0.3, W * 0.24, H * 0.14);
  for (const u of [0.3, 0.7]) {
    g.beginPath();
    g.roundRect(W * (u - 0.06), H * 0.24, W * 0.12, H * 0.2, 18);
    g.fill();
  }
  // Windshield centre post + door frames.
  g.fillStyle = '#c9ced6';
  g.fillRect(W * 0.497, H * 0.16, W * 0.006, H * 0.3);
  // Glass sheen.
  g.fillStyle = 'rgba(120,160,200,0.25)';
  g.beginPath();
  g.ellipse(W * 0.47, H * 0.3, W * 0.05, H * 0.05, -0.3, 0, Math.PI * 2);
  g.fill();
  // SFPD lettering on both sides of the belly band (right side u=0.25, left side u=0.75).
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const u of [0.22, 0.78]) {
    g.fillStyle = '#ffffff';
    g.font = 'bold 64px Helvetica, Arial, sans-serif';
    g.fillText('SFPD', W * u, H * 0.66);
    g.font = 'bold 30px Helvetica, Arial, sans-serif';
    g.fillStyle = '#d4a93a';
    g.fillText('AIR 1', W * u, H * 0.78);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function textTexture(text: string, fg: string, bg: string, w = 512, h = 128, px = 84): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `bold ${px}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial alpha used by rotor discs and light glows. */
export function radialTexture(stops: [number, string][], size = 128): THREE.CanvasTexture {
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

export function buildHeliModel(): HeliModel {
  const root = new THREE.Group();
  root.name = 'heli-model';

  const navy = new THREE.MeshStandardMaterial({ color: 0x13244a, roughness: 0.45, metalness: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.4, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.6, metalness: 0.5 });
  const skidMat = new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughness: 0.35, metalness: 0.8 });
  const livery = new THREE.MeshStandardMaterial({ map: liveryTexture(), roughness: 0.35, metalness: 0.25 });

  // Cabin: ellipsoid, UV seam rotated to the tail so the lettering sits on the flanks.
  const cabinGeo = new THREE.SphereGeometry(1, 40, 24);
  cabinGeo.rotateY(Math.PI / 2);
  const cabin = new THREE.Mesh(cabinGeo, livery);
  cabin.scale.set(1.0, 1.08, 2.3);
  cabin.position.set(0, 1.45, -0.7);
  root.add(cabin);

  // Engine / transmission fairing on top.
  const fairingGeo = new THREE.CapsuleGeometry(0.45, 1.8, 6, 12);
  fairingGeo.rotateX(Math.PI / 2);
  const fairing = new THREE.Mesh(fairingGeo, white);
  fairing.scale.set(1.1, 0.75, 1);
  fairing.position.set(0, 2.45, 0.5);
  root.add(fairing);

  // Tail boom (tapered).
  const boomGeo = new THREE.CylinderGeometry(0.17, 0.42, 5.6, 14);
  boomGeo.rotateX(Math.PI / 2);
  const boom = new THREE.Mesh(boomGeo, navy);
  boom.position.set(0, 1.85, 3.7);
  root.add(boom);

  // Vertical fin (swept) + ventral fin.
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.85), navy);
  fin.position.set(0, 2.55, 6.35);
  fin.rotation.x = -0.35;
  root.add(fin);
  const vfin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.5), navy);
  vfin.position.set(0, 1.45, 6.3);
  vfin.rotation.x = 0.3;
  root.add(vfin);

  // Horizontal stabiliser with end plates.
  const stab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.07, 0.5), white);
  stab.position.set(0, 1.95, 5.3);
  root.add(stab);
  for (const sx of [-1, 1]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.42), navy);
    plate.position.set(sx * 1.05, 1.95, 5.3);
    root.add(plate);
  }

  // "POLICE" panel on the boom flanks.
  const police = new THREE.MeshBasicMaterial({ map: textTexture('POLICE', '#ffffff', '#13244a'), toneMapped: true });
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), police);
    p.position.set(sx * 0.32, 1.88, 2.6);
    p.rotation.y = sx * Math.PI / 2;
    root.add(p);
  }

  // Skids: two tubes + two cross tubes.
  const skidGeo = new THREE.CylinderGeometry(0.06, 0.06, 3.4, 8);
  skidGeo.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(skidGeo, skidMat);
    s.position.set(sx * 1.05, 0.05, -0.6);
    root.add(s);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), skidMat);
    tip.position.set(sx * 1.05, 0.15, -2.4);
    tip.rotation.x = -0.9;
    root.add(tip);
  }
  for (const z of [-1.5, 0.3]) {
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 8), skidMat);
    cross.rotation.z = Math.PI / 2;
    cross.position.set(0, 0.55, z);
    root.add(cross);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), skidMat);
      leg.position.set(sx * 1.05, 0.3, z);
      root.add(leg);
    }
  }

  // Rotor mast + hub.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.6, 10), dark);
  mast.position.set(0, 3.0, 0);
  root.add(mast);

  // Main rotor: 3 blades + motion-blur disc.
  const mainRotor = new THREE.Group();
  mainRotor.position.set(0, 3.3, 0);
  const bladeGeo = new THREE.BoxGeometry(0.32, 0.035, 5.15);
  bladeGeo.translate(0, 0, 2.7);
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.55, depthWrite: false });
  for (let k = 0; k < 3; k++) {
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.y = (k * Math.PI * 2) / 3;
    mainRotor.add(b);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.18, 12), dark);
  mainRotor.add(hub);
  root.add(mainRotor);
  const discTex = radialTexture([
    [0, 'rgba(40,44,50,0.05)'],
    [0.15, 'rgba(40,44,50,0.25)'],
    [0.9, 'rgba(40,44,50,0.32)'],
    [0.97, 'rgba(60,64,70,0.45)'],
    [1, 'rgba(40,44,50,0)'],
  ]);
  const discMat = new THREE.MeshBasicMaterial({ map: discTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.35, 48), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(0, 3.31, 0);
  root.add(disc);

  // Tail rotor (left side on the AS350), axis along X.
  const tailRotor = new THREE.Group();
  tailRotor.position.set(-0.22, 2.35, 6.45);
  const tbGeo = new THREE.BoxGeometry(0.03, 1.8, 0.14);
  for (let k = 0; k < 2; k++) {
    const b = new THREE.Mesh(tbGeo, bladeMat);
    b.rotation.x = (k * Math.PI) / 2;
    tailRotor.add(b);
  }
  root.add(tailRotor);
  const tdisc = new THREE.Mesh(new THREE.CircleGeometry(0.93, 24), discMat);
  tdisc.rotation.y = Math.PI / 2;
  tdisc.position.copy(tailRotor.position);
  root.add(tdisc);

  // Gimbal turret under the nose.
  const noseMount = new THREE.Vector3(0, 0.55, -2.4);
  const turret = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), dark);
  turret.position.copy(noseMount);
  root.add(turret);

  // Lights: emissive cores + additive glow sprites (sized for visibility at range).
  const glowTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.6)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const light = (color: number, pos: THREE.Vector3, glow: number) => {
    const g = new THREE.Group();
    g.position.copy(pos);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(4) }),
    );
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
  const navRed = [light(0xff2020, new THREE.Vector3(-1.08, 1.95, 5.3), 0.7)];
  const navGreen = [light(0x20ff50, new THREE.Vector3(1.08, 1.95, 5.3), 0.7)];
  const strobe = [light(0xffffff, new THREE.Vector3(0, 3.35, 6.6), 1.8), light(0xffffff, new THREE.Vector3(0, 0.3, -1.0), 1.4)];
  const beacon = [light(0xff3030, new THREE.Vector3(0, 2.85, 1.3), 1.0)];

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return { root, mainRotor, tailRotor, navRed, navGreen, strobe, beacon, noseMount };
}
