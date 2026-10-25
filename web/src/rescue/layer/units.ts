/**
 * Moving unit tokens after Dispatch: road vehicles (oriented boxes with a flashing emissive light bar),
 * helicopters (gold fuselage + spinning rotor disc) and soft ground glows / arrival beacons.
 * 4 draw calls total (vehicle bodies, heli bodies, rotor discs, glows). Tokens scale up with camera distance.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { UnitType } from '../../contracts';
import { MAX_INC, premulMaterial, type SharedUniforms } from './ribbons';
import { coreHalfAt, sampleAt, UNIT_COLOR, UNIT_SIZE, type Polyline } from './common';

export interface UnitSpec {
  group: number;
  type: UnitType;
  mode: 'road' | 'air';
  line: Polyline;
  lane: number;
  /** Seconds after dispatch before this unit starts. */
  delay: number;
  /** Seconds of real time for the trip. */
  duration: number;
  /** Distance back from the end where it parks (convoy queue). */
  parkBack: number;
  incIdx: number;
  etaMin: number;
}

export interface GroupStatus {
  group: number;
  lead: THREE.Vector3;
  remainingMin: number;
  started: boolean;
  arrived: number;
  total: number;
}

const BODY_VS = /* glsl */ `
  #define MAX_INC ${MAX_INC}
  uniform float uIncW[MAX_INC];
  attribute vec3 iColor;
  attribute vec3 iFlash; // phase, kind (0 fire/ems, 1 police, 2 heli), parked
  varying vec3 vN;
  varying vec3 vLocal;
  varying vec3 vColor;
  varying vec3 vFlash;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vN = normalize(mat3(m) * normal);
    vLocal = position;
    vColor = iColor;
    vFlash = iFlash;
    gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
  }
`;

const BODY_FS = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  uniform vec3 uSun;
  varying vec3 vN;
  varying vec3 vLocal;
  varying vec3 vColor;
  varying vec3 vFlash;
  void main() {
    vec3 n = normalize(vN);
    float sun = max(dot(n, normalize(uSun)), 0.0);
    float l = 0.5 + 0.45 * sun * (1.0 - uNight) + 0.15 * max(n.y, 0.0);
    float kind0 = vFlash.y;
    // Road vehicles: white roof (reads on top of the same-coloured ribbon), unit-coloured sides with a
    // white reflective stripe. Helicopters: solid gold.
    float roof = kind0 < 1.5 ? step(0.7, n.y) : 0.0;
    float stripe = kind0 < 1.5 ? (1.0 - roof) * step(abs(vLocal.y - 0.42), 0.06) : 0.0;
    vec3 paint = mix(vColor, vec3(0.92, 0.93, 0.9), max(roof, stripe));
    vec3 col = paint * l * mix(1.0, 0.5, uNight);
    // Self-lit so tokens read at night.
    col += paint * mix(0.12, 0.55, uNight);
    float kind = vFlash.y;
    if (kind < 1.5) {
      // Light bar across the cab roof (top face, front quarter).
      float top = step(0.7, n.y);
      float bar = top * step(abs(vLocal.z - 0.3), 0.09) * step(abs(vLocal.x), 0.42);
      float t = fract(uTime * 2.6 + vFlash.x);
      float left = step(vLocal.x, 0.0);
      float on = left > 0.5 ? step(t, 0.5) : step(0.5, t);
      vec3 cA = kind > 0.5 ? vec3(1.0, 0.08, 0.06) : vec3(1.0, 0.1, 0.05);
      vec3 cB = kind > 0.5 ? vec3(0.1, 0.3, 1.0) : vec3(1.0, 0.95, 0.9);
      vec3 barCol = mix(cB, cA, left) * on * mix(2.4, 5.0, uNight);
      col = mix(col, barCol + vec3(0.05), bar);
      // Dark windscreen band on the front face / sides near the front.
      float glass = step(0.42, vLocal.z) * step(0.55, vLocal.y) * step(vLocal.y, 0.85) * (1.0 - top);
      col = mix(col, vec3(0.02, 0.03, 0.05) + vec3(0.4, 0.45, 0.5) * uNight * 0.3, glass * 0.85);
      // Headlights at night.
      float head = step(0.495, vLocal.z) * step(vLocal.y, 0.35) * step(0.2, vLocal.y) * step(0.25, abs(vLocal.x));
      col += vec3(1.0, 0.95, 0.85) * head * (0.5 + 3.0 * uNight);
    } else {
      // Helicopter: blinking red beacon on top, white strobe at the tail.
      float bcn = step(0.85, n.y) * step(length(vLocal.xz - vec2(0.0, 0.0)), 0.6);
      float t = fract(uTime * 1.1 + vFlash.x);
      col += vec3(1.0, 0.1, 0.05) * bcn * step(t, 0.18) * 4.0;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const ROTOR_FS = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  varying vec2 vUv;
  varying float vPhase;
  void main() {
    vec2 c = vUv;
    float r = length(c);
    if (r > 1.0) discard;
    float ang = atan(c.y, c.x) - uTime * 22.0 + vPhase;
    float blades = pow(abs(cos(ang)), 40.0) * smoothstep(1.0, 0.85, r);
    float disc = 0.16 * smoothstep(1.0, 0.92, r) * smoothstep(0.08, 0.2, r);
    float rim = smoothstep(0.03, 0.0, abs(r - 0.97)) * 0.5;
    vec3 rgb = vec3(1.0, 0.92, 0.6) * (disc * 0.8 + blades * 0.8 + rim * mix(0.6, 1.6, uNight));
    gl_FragColor = vec4(rgb * 0.8, disc + blades * 0.6);
  }
`;
const ROTOR_VS = /* glsl */ `
  attribute float iPhase;
  varying vec2 vUv;
  varying float vPhase;
  void main() {
    vUv = position.xz;
    vPhase = iPhase;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const GLOW_VS = /* glsl */ `
  uniform float uPx;
  attribute vec3 aColor;
  attribute vec2 aGlow; // size (m), intensity
  varying vec3 vColor;
  varying float vI;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    gl_PointSize = clamp(aGlow.x / max(1.0, dist * uPx), 6.0, 90.0);
    vColor = aColor;
    vI = aGlow.y;
    gl_Position = projectionMatrix * mv;
  }
`;
const GLOW_FS = /* glsl */ `
  uniform float uNight;
  varying vec3 vColor;
  varying float vI;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float g = exp(-r2 * 4.0);
    float ring = smoothstep(0.08, 0.0, abs(sqrt(r2) - 0.8)) * 0.35;
    vec3 rgb = vColor * (g + ring) * vI * mix(0.45, 1.6, uNight);
    gl_FragColor = vec4(rgb, 0.0);
  }
`;

function heliGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(2.4, 2.4, 6.0).translate(0, 1.3, 1.2), // cabin
    new THREE.BoxGeometry(1.9, 1.6, 2.0).translate(0, 1.1, 4.6), // nose
    new THREE.BoxGeometry(0.5, 0.6, 6.5).translate(0, 1.9, -4.8), // tail boom
    new THREE.BoxGeometry(0.25, 2.0, 1.1).translate(0, 2.6, -7.8), // fin
    new THREE.BoxGeometry(0.3, 0.3, 4.4).translate(-1.1, 0.0, 1.0), // skids
    new THREE.BoxGeometry(0.3, 0.3, 4.4).translate(1.1, 0.0, 1.0),
    new THREE.BoxGeometry(0.5, 0.6, 0.5).translate(0, 2.8, 1.2), // mast
  ];
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  return g!;
}

export function createUnits(u: SharedUniforms) {
  const object = new THREE.Group();
  object.name = 'rescue-units';
  const uniforms = { ...u, uSun: { value: new THREE.Vector3(0.3, 0.8, 0.2) } };

  const bodyMat = new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: BODY_FS, uniforms });
  bodyMat.toneMapped = false;
  const rotorMat = premulMaterial({ vertexShader: ROTOR_VS, fragmentShader: ROTOR_FS, uniforms });
  rotorMat.polygonOffset = false;
  const glowMat = premulMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms });
  glowMat.polygonOffset = false;
  glowMat.depthTest = true;

  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const heliGeo = heliGeometry();
  const disc = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);

  let vehicles: THREE.InstancedMesh | null = null;
  let helis: THREE.InstancedMesh | null = null;
  let rotors: THREE.InstancedMesh | null = null;
  let glows: THREE.Points | null = null;
  let specs: UnitSpec[] = [];
  let roadIdx: number[] = [];
  let airIdx: number[] = [];
  let dispatchAt = -1;

  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qp = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();

  function disposeMeshes() {
    for (const o of [vehicles, helis, rotors]) {
      if (!o) continue;
      object.remove(o);
      o.geometry.dispose();
      o.dispose();
    }
    if (glows) {
      object.remove(glows);
      glows.geometry.dispose();
    }
    vehicles = helis = rotors = null;
    glows = null;
  }

  function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, extra: (g: THREE.BufferGeometry) => void) {
    const g = geo.clone();
    extra(g);
    const mesh = new THREE.InstancedMesh(g, mat, Math.max(1, n));
    mesh.count = 0;
    mesh.frustumCulled = false;
    object.add(mesh);
    return mesh;
  }

  function set(list: UnitSpec[]) {
    disposeMeshes();
    specs = list;
    dispatchAt = -1;
    roadIdx = [];
    airIdx = [];
    list.forEach((s, i) => (s.mode === 'air' ? airIdx : roadIdx).push(i));
    vehicles = instanced(box, bodyMat, roadIdx.length, (g) => {
      const c = new Float32Array(Math.max(1, roadIdx.length) * 3);
      const f = new Float32Array(Math.max(1, roadIdx.length) * 3);
      roadIdx.forEach((si, k) => {
        const s = list[si];
        const col = UNIT_COLOR[s.type];
        c.set([col.r, col.g, col.b], k * 3);
        f.set([(si * 0.37) % 1, s.type === 'police' ? 1 : 0, 0], k * 3);
      });
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(c, 3));
      g.setAttribute('iFlash', new THREE.InstancedBufferAttribute(f, 3));
    });
    vehicles.renderOrder = 4;
    helis = instanced(heliGeo, bodyMat, airIdx.length, (g) => {
      const c = new Float32Array(Math.max(1, airIdx.length) * 3);
      const f = new Float32Array(Math.max(1, airIdx.length) * 3);
      airIdx.forEach((si, k) => {
        const col = UNIT_COLOR.helicopter;
        c.set([col.r, col.g, col.b], k * 3);
        f.set([(si * 0.37) % 1, 2, 0], k * 3);
      });
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(c, 3));
      g.setAttribute('iFlash', new THREE.InstancedBufferAttribute(f, 3));
    });
    rotors = instanced(disc, rotorMat, airIdx.length, (g) => {
      const p = new Float32Array(Math.max(1, airIdx.length));
      airIdx.forEach((_, k) => (p[k] = k * 1.3));
      g.setAttribute('iPhase', new THREE.InstancedBufferAttribute(p, 1));
    });
    rotors.renderOrder = 9;
    const gp = new Float32Array(Math.max(1, list.length) * 3);
    const gc = new Float32Array(Math.max(1, list.length) * 3);
    const gg = new Float32Array(Math.max(1, list.length) * 2);
    list.forEach((s, i) => {
      const col = UNIT_COLOR[s.type];
      gc.set([col.r, col.g, col.b], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(gc, 3));
    geo.setAttribute('aGlow', new THREE.BufferAttribute(gg, 2));
    geo.setDrawRange(0, 0);
    glows = new THREE.Points(geo, glowMat);
    glows.frustumCulled = false;
    glows.renderOrder = 7;
    object.add(glows);
  }

  /** Eased trip fraction: gentle accel/decel, mostly constant speed. */
  const ease = (p: number) => {
    const s = p * p * (3 - 2 * p);
    return p * 0.45 + s * 0.55;
  };

  function update(now: number, camera: THREE.Camera, pxPerM: number, sunDir: THREE.Vector3): GroupStatus[] {
    uniforms.uSun.value.copy(sunDir);
    const status = new Map<number, GroupStatus>();
    if (!glows || !vehicles || !helis || !rotors) return [];
    const dispatched = dispatchAt >= 0;
    camera.getWorldPosition(camPos);
    const gpos = glows.geometry.getAttribute('position') as THREE.BufferAttribute;
    const gglow = glows.geometry.getAttribute('aGlow') as THREE.BufferAttribute;
    let gn = 0;
    let vn = 0;
    let hn = 0;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      let st = status.get(s.group);
      if (!st) {
        st = { group: s.group, lead: new THREE.Vector3(), remainingMin: s.etaMin, started: false, arrived: 0, total: 0 };
        status.set(s.group, st);
      }
      st.total++;
      const t = dispatched ? now - dispatchAt - s.delay : -1;
      const p = Math.min(1, Math.max(0, t / s.duration));
      const L = s.line.length;
      const endS = Math.max(L * 0.5, L - s.parkBack);
      const dS = ease(p) * endS;
      sampleAt(s.line, dS, pos, dir);
      if (st.total === 1) {
        st.lead.copy(pos);
        st.started = t >= 0;
        st.remainingMin = s.etaMin * (1 - p);
      }
      if (p >= 1) st.arrived++;
      if (!dispatched || t < 0) continue;
      const dist = camPos.distanceTo(pos);
      // ≥ ~12 px long on screen (tokens grow when the camera is far), capped.
      const scale = THREE.MathUtils.clamp((12 * dist * pxPerM) / UNIT_SIZE[s.type][0], 1, 6);
      const yaw = Math.atan2(dir.x, dir.z);
      if (s.mode === 'road') {
        const [len, wid, hei] = UNIT_SIZE[s.type];
        // Same lane offset as the ribbon shader (core half-width × 2.3 × lane), on the left-normal.
        const coreHalf = coreHalfAt(dist, pxPerM);
        const off = s.lane * coreHalf * 2.3;
        pos.x += -dir.z * off * (1 / Math.max(1e-3, Math.hypot(dir.x, dir.z)));
        pos.z += dir.x * off * (1 / Math.max(1e-3, Math.hypot(dir.x, dir.z)));
        pos.y -= 1.45; // ribbon is lifted 1.5 m
        q.setFromAxisAngle(up, yaw);
        // Pitch along the slope.
        const pitch = -Math.asin(THREE.MathUtils.clamp(dir.y, -0.4, 0.4));
        q.multiply(qp.setFromAxisAngle(tmp.set(1, 0, 0), pitch));
        m4.compose(pos, q, sc.set(wid * scale, hei * scale, len * scale));
        vehicles.setMatrixAt(vn++, m4);
        const arrived = p >= 1;
        gpos.setXYZ(gn, pos.x, pos.y + 0.6 * scale, pos.z);
        const pulse = arrived ? 0.75 + 0.35 * Math.sin(now * 3 + i) : 0.55;
        gglow.setXY(gn, (arrived ? 26 : 16) * scale, pulse);
        gn++;
      } else {
        // Helicopter: follow the arc, hover-bob on arrival, slow yaw drift.
        const arrived = p >= 1;
        if (arrived) {
          pos.y += Math.sin(now * 1.3 + i) * 1.2;
        }
        const bank = arrived ? 0 : 0.08;
        q.setFromAxisAngle(up, yaw + (arrived ? Math.sin(now * 0.3 + i) * 0.4 : 0));
        q.multiply(qp.setFromAxisAngle(tmp.set(0, 0, 1), bank));
        const hs = scale * 0.9;
        m4.compose(pos, q, sc.set(hs, hs, hs));
        helis.setMatrixAt(hn, m4);
        tmp.set(0, 3.2 * hs, 1.2 * hs).applyQuaternion(q).add(pos);
        m4.compose(tmp, q, sc.set(6.6 * hs, 1, 6.6 * hs));
        rotors.setMatrixAt(hn, m4);
        hn++;
        gpos.setXYZ(gn, pos.x, pos.y, pos.z);
        gglow.setXY(gn, 34 * hs, arrived ? 0.8 + 0.3 * Math.sin(now * 3 + i) : 0.5);
        gn++;
      }
    }
    vehicles.count = vn;
    helis.count = hn;
    rotors.count = hn;
    vehicles.instanceMatrix.needsUpdate = true;
    helis.instanceMatrix.needsUpdate = true;
    rotors.instanceMatrix.needsUpdate = true;
    glows.geometry.setDrawRange(0, gn);
    gpos.needsUpdate = true;
    gglow.needsUpdate = true;
    return [...status.values()];
  }

  return {
    object,
    set,
    dispatch(now: number) {
      dispatchAt = now;
    },
    get dispatched() {
      return dispatchAt >= 0;
    },
    /** True once every unit has arrived. */
    allArrived(now: number) {
      if (dispatchAt < 0) return false;
      return specs.every((s) => now - dispatchAt - s.delay >= s.duration);
    },
    update,
    clear() {
      disposeMeshes();
      specs = [];
      dispatchAt = -1;
    },
  };
}
