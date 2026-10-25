/**
 * Ground markers in ONE instanced draw call: incident priority rings (pulsing; dashed when unverified),
 * facility pads and red "blocked" X marks — plus ONE instanced draw for incident light beams.
 * Sizes have a screen-space minimum so markers stay readable from the overview.
 */
import * as THREE from 'three';
import { MAX_INC, premulMaterial, type SharedUniforms } from './ribbons';

export const STYLE_RING = 0;
export const STYLE_RING_DASHED = 1;
export const STYLE_PAD = 2;
export const STYLE_X = 3;

export interface GroundMarker {
  x: number;
  y: number;
  z: number;
  normal?: THREE.Vector3;
  yaw?: number;
  radius: number;
  minPx: number;
  style: number;
  color: THREE.Color;
  intensity: number;
  incIdx: number;
  /** Pulse speed multiplier (rings). */
  speed?: number;
}

export interface Beam {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  color: THREE.Color;
  intensity: number;
  incIdx: number;
}

const MARK_VS = /* glsl */ `
  #define MAX_INC ${MAX_INC}
  uniform float uPx;
  uniform float uIncW[MAX_INC];
  attribute vec3 iColor;
  attribute vec4 iParams; // radius, style, intensity, incIdx
  attribute vec3 iExtra;  // minPx, speed, phase
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vParams;
  varying vec3 vExtra;
  varying float vW;
  varying float vCamDist;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 c = m * vec4(0.0, 0.0, 0.0, 1.0);
    float dist = distance(cameraPosition, c.xyz);
    vCamDist = dist;
    float R = max(iParams.x, dist * uPx * iExtra.x);
    vec4 wp = m * vec4(position * R, 1.0);
    wp.y += dist * 0.0022;
    vUv = position.xz;
    vColor = iColor;
    vParams = iParams;
    vExtra = iExtra;
    vW = iParams.w < 0.0 ? 1.0 : uIncW[int(iParams.w + 0.5)];
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const MARK_FS = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  varying vec2 vUv;
  varying vec3 vColor;
  varying vec4 vParams;
  varying vec3 vExtra;
  varying float vW;
  varying float vCamDist;
  float band(float r, float c, float hw, float aa) {
    return 1.0 - smoothstep(hw - aa, hw + aa, abs(r - c));
  }
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float aa = max(fwidth(r) * 1.2, 0.004);
    float style = vParams.y;
    float I = vParams.z;
    float night = uNight;
    vec3 col = vColor;
    vec3 hot = mix(col, vec3(1.0), 0.5);
    vec3 rgb = vec3(0.0);
    float a = 0.0;
    if (style < 1.5) {
      float ang = atan(vUv.y, vUv.x);
      float dash = 1.0;
      if (style > 0.5) dash = step(0.42, fract(ang / 6.2831853 * 22.0 + uTime * 0.06));
      float ring = band(r, 0.64, 0.045, aa) * dash;
      float inner = band(r, 0.34, 0.012, aa) * 0.6;
      float fill = (1.0 - smoothstep(0.6, 0.64, r)) * 0.10;
      // Tactical ticks at the cardinal points.
      float tick = band(r, 0.84, 0.05, aa) * (1.0 - smoothstep(0.035, 0.05, abs(sin(ang * 2.0)) * 0.5));
      float pulse = 0.0;
      for (int k = 0; k < 2; k++) {
        float pr = fract(uTime * 0.42 * vExtra.y + float(k) * 0.5 + vExtra.z);
        pulse += band(r, 0.2 + pr * 0.8, 0.03 + 0.02 * pr, aa) * pow(1.0 - pr, 1.6);
      }
      float bright = ring + tick * 0.8 + inner + pulse * 0.9;
      rgb = col * (bright * mix(1.15, 2.6, night) * I + fill * mix(0.5, 1.0, night)) + hot * ring * night * 0.8 * I;
      a = (ring * 0.9 + tick * 0.7 + inner * 0.5 + pulse * 0.6) * mix(0.9, 0.35, night) + fill * mix(0.55, 0.15, night);
      // Dark under-ring by day for contrast.
      float under = band(r, 0.64, 0.085, aa) * (1.0 - ring) * (1.0 - night);
      a += under * 0.35;
    } else if (style < 2.5) {
      // Facility pad: dark disc + bright ring + faint outer ring.
      float disc = 1.0 - smoothstep(0.5 - aa, 0.5 + aa, r);
      float ring = band(r, 0.56, 0.06, aa);
      float outer = band(r, 0.92, 0.02, aa) * 0.6;
      rgb = col * (ring + outer) * mix(1.1, 2.2, night) * I + col * disc * mix(0.06, 0.25, night);
      a = (ring + outer) * mix(0.9, 0.4, night) + disc * mix(0.55, 0.2, night);
    } else {
      // Blocked X.
      vec2 u = vUv;
      float d = min(abs(u.x - u.y), abs(u.x + u.y)) * 0.7071;
      float inBox = 1.0 - smoothstep(0.62, 0.66, max(abs(u.x), abs(u.y)));
      float xm = (1.0 - smoothstep(0.11 - aa, 0.11 + aa, d)) * inBox;
      float bg = (1.0 - smoothstep(0.86, 0.9, r));
      float edge = band(r, 0.88, 0.035, aa);
      float blink = 0.8 + 0.2 * sin(uTime * 5.0 + vExtra.z * 6.0);
      rgb = col * (xm * 1.6 * blink + edge) * mix(1.0, 2.4, night) * I + col * bg * 0.04;
      a = (xm + edge) * mix(0.95, 0.45, night) + bg * mix(0.45, 0.25, night) * (1.0 - xm);
    }
    #ifdef XRAY
      float xr = smoothstep(350.0, 1400.0, vCamDist) * (style > 2.5 ? 0.0 : 0.7);
      rgb *= xr;
      a *= xr * 0.75;
    #endif
    rgb *= vW;
    a = min(1.0, a * min(vW, 1.0));
    gl_FragColor = vec4(rgb, a);
  }
`;

const BEAM_VS = /* glsl */ `
  #define MAX_INC ${MAX_INC}
  uniform float uPx;
  uniform float uIncW[MAX_INC];
  attribute vec3 iColor;
  attribute vec4 iParams; // radius, height, intensity, incIdx
  varying float vY;
  varying vec3 vColor;
  varying float vI;
  varying float vFacing;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 c = m * vec4(0.0, 0.0, 0.0, 1.0);
    float dist = distance(cameraPosition, c.xyz);
    float R = max(iParams.x, dist * uPx * 2.2);
    float H = max(iParams.y, dist * uPx * 90.0);
    vec4 wp = m * vec4(position.x * R, position.y * H, position.z * R, 1.0);
    vec3 n = normalize(vec3(position.x, 0.0, position.z));
    vec3 v = normalize(cameraPosition - wp.xyz);
    vFacing = abs(dot(n, normalize(vec3(v.x, 0.0, v.z))));
    vY = position.y;
    vColor = iColor;
    vI = iParams.z * uIncW[int(iParams.w + 0.5)];
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BEAM_FS = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  varying float vY;
  varying vec3 vColor;
  varying float vI;
  varying float vFacing;
  void main() {
    float fade = pow(1.0 - vY, 1.8);
    float sweep = smoothstep(0.08, 0.0, abs(fract(uTime * 0.35) - vY)) * 0.8;
    float core = pow(vFacing, 2.5);
    vec3 rgb = mix(vColor, vec3(1.0), 0.25 * core) * (fade * core + sweep * core * fade) * mix(0.55, 1.8, uNight) * vI;
    gl_FragColor = vec4(rgb, 0.0);
  }
`;

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number) {
  const g = geo.clone();
  g.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
  g.setAttribute('iParams', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
  g.setAttribute('iExtra', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
  const mesh = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>(g, mat, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

export function createMarkers(u: SharedUniforms) {
  const object = new THREE.Group();
  object.name = 'rescue-markers';
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const markMat = premulMaterial({ vertexShader: MARK_VS, fragmentShader: MARK_FS, uniforms: u });
  let ground = makeInstanced(quad, markMat, 16);
  ground.renderOrder = 6;
  object.add(ground);
  // See-through copy (same instance data) so rings behind towers still read from the overview.
  const xrayMat = premulMaterial({ vertexShader: MARK_VS, fragmentShader: '#define XRAY\n' + MARK_FS, uniforms: u });
  xrayMat.depthTest = false;
  xrayMat.polygonOffset = false;
  let groundX = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>(ground.geometry, xrayMat, 16);
  groundX.count = 0;
  groundX.frustumCulled = false;
  groundX.renderOrder = 3;
  object.add(groundX);

  const cyl = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true).translate(0, 0.5, 0);
  const beamMat = premulMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: u });
  beamMat.polygonOffset = false;
  let beams = makeInstanced(cyl, beamMat, 8);
  beams.renderOrder = 8;
  object.add(beams);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qy = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();

  function ensure(mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>, n: number, geo: THREE.BufferGeometry, mat: THREE.Material, order: number) {
    if (n <= mesh.instanceMatrix.count) return mesh;
    object.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
    const next = makeInstanced(geo, mat, Math.ceil(n * 1.5));
    next.renderOrder = order;
    object.add(next);
    return next;
  }

  function setGround(list: GroundMarker[]) {
    ground = ensure(ground, list.length, quad, markMat, 6);
    const col = ground.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute;
    const par = ground.geometry.getAttribute('iParams') as THREE.InstancedBufferAttribute;
    const ext = ground.geometry.getAttribute('iExtra') as THREE.InstancedBufferAttribute;
    list.forEach((mk, i) => {
      q.setFromUnitVectors(up, mk.normal ?? up);
      qy.setFromAxisAngle(up, mk.yaw ?? 0);
      q.multiply(qy);
      m4.compose(pos.set(mk.x, mk.y, mk.z), q, one);
      ground.setMatrixAt(i, m4);
      col.setXYZ(i, mk.color.r, mk.color.g, mk.color.b);
      par.setXYZW(i, mk.radius, mk.style, mk.intensity, mk.incIdx);
      ext.setXYZ(i, mk.minPx, mk.speed ?? 1, (i * 0.137) % 1);
    });
    ground.count = list.length;
    ground.instanceMatrix.needsUpdate = true;
    col.needsUpdate = par.needsUpdate = ext.needsUpdate = true;
    // X-ray twin shares geometry (instance attributes) and the instance matrix buffer.
    if (groundX.geometry !== ground.geometry) {
      object.remove(groundX);
      groundX = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>(ground.geometry, xrayMat, ground.instanceMatrix.count);
      groundX.frustumCulled = false;
      groundX.renderOrder = 3;
      groundX.layers.mask = ground.layers.mask;
      object.add(groundX);
    }
    groundX.instanceMatrix = ground.instanceMatrix;
    groundX.count = list.length;
  }

  function setBeams(list: Beam[]) {
    beams = ensure(beams, list.length, cyl, beamMat, 8);
    const col = beams.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute;
    const par = beams.geometry.getAttribute('iParams') as THREE.InstancedBufferAttribute;
    list.forEach((b, i) => {
      m4.makeTranslation(b.x, b.y, b.z);
      beams.setMatrixAt(i, m4);
      col.setXYZ(i, b.color.r, b.color.g, b.color.b);
      par.setXYZW(i, b.radius, b.height, b.intensity, b.incIdx);
    });
    beams.count = list.length;
    beams.instanceMatrix.needsUpdate = true;
    col.needsUpdate = par.needsUpdate = true;
  }

  return {
    object,
    setGround,
    setBeams,
    clear() {
      ground.count = 0;
      groundX.count = 0;
      beams.count = 0;
    },
  };
}
