/**
 * Route ribbons (one draw call for all road routes) + air arc trails (one draw call, dotted points).
 *
 * Road ribbon: a strip along the draped centreline whose half-width is computed in the vertex shader from the
 * camera distance (≥ ~5 px core on screen, ≥ 2 m world) → readable from the overview and crisp up close.
 * Fragment profile across the strip: bright core with a hot centre line, dark casing by day / soft additive
 * halo by night, flowing chevrons (facility → incident), a draw-on reveal when the plan appears.
 * Premultiplied blending (src ONE, dst ONE_MINUS_SRC_ALPHA): alpha > 0 = normal blend, alpha 0 = additive.
 */
import * as THREE from 'three';
import type { Polyline } from './common';

export const MAX_INC = 64;

export interface RibbonInput {
  line: Polyline;
  color: THREE.Color;
  lane: number;
  incIdx: number;
  order: number;
}

export function sharedUniforms() {
  return {
    uTime: { value: 0 },
    uShowT: { value: 0 },
    uNight: { value: 0 },
    uPx: { value: 0.001 },
    uIncW: { value: new Float32Array(MAX_INC).fill(1) },
    uDispatched: { value: 0 },
  };
}
export type SharedUniforms = ReturnType<typeof sharedUniforms>;

const RIBBON_VS = /* glsl */ `
  #define MAX_INC ${MAX_INC}
  uniform float uPx;
  uniform float uIncW[MAX_INC];
  attribute vec2 aSideDir;
  attribute float aAcross;
  attribute float aDist;
  attribute vec4 aMeta; // len, lane, order, incIdx
  attribute vec3 aColor;
  varying float vAcross;
  varying float vDist;
  varying float vLen;
  varying float vOrder;
  varying float vW;
  varying float vCamDist;
  varying vec3 vColor;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float dist = distance(cameraPosition, wp.xyz);
    float coreHalf = max(1.8, dist * uPx * mix(3.0, 3.6, smoothstep(800.0, 2500.0, dist)));
    float halfW = coreHalf * 2.7;
    wp.xz += aSideDir * (aAcross * halfW + aMeta.y * coreHalf * 2.3);
    wp.y += dist * 0.0018;
    vAcross = aAcross * 2.7; // in core half-widths: |v| < 1 = core
    vDist = aDist;
    vLen = aMeta.x;
    vOrder = aMeta.z;
    vW = uIncW[int(aMeta.w + 0.5)];
    vCamDist = dist;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const RIBBON_FS = /* glsl */ `
  uniform float uTime;
  uniform float uShowT;
  uniform float uNight;
  uniform float uPx;
  uniform float uDispatched;
  varying float vAcross;
  varying float vDist;
  varying float vLen;
  varying float vOrder;
  varying float vW;
  varying float vCamDist;
  varying vec3 vColor;
  void main() {
    // Draw-on reveal from the facility end, staggered per route.
    float head = (uTime - uShowT - vOrder * 0.12) * 1100.0;
    if (vDist > head) discard;
    float headGlow = smoothstep(60.0, 0.0, head - vDist) * step(head, vLen + 60.0);

    float uc = abs(vAcross);
    float aa = max(fwidth(uc), 0.02);
    float core = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, uc);
    float casing = (1.0 - smoothstep(1.55 - aa, 1.55 + aa, uc)) * (1.0 - core);
    float halo = exp(-max(uc - 1.0, 0.0) * 1.6) * (1.0 - core);
    halo *= 1.0 - smoothstep(2.2, 2.7, uc);

    // Flowing chevrons: period grows with distance so they stay legible (and don't alias) far away.
    float P = max(26.0, vCamDist * uPx * 34.0);
    float speed = mix(0.55, 1.1, uDispatched);
    float ph = fract(vDist / P - uTime * speed + uc * 0.32);
    float chev = smoothstep(0.0, 0.07, ph) * (1.0 - smoothstep(0.16, 0.26, ph));
    // Fade dashes near both ends so starts/ends read clean.
    chev *= smoothstep(0.0, 18.0, vDist) * smoothstep(0.0, 18.0, vLen - vDist);

    float night = uNight;
    vec3 col = vColor;
    vec3 hot = mix(col, vec3(1.0), 0.55);
    float centre = 1.0 - smoothstep(0.0, 0.45, uc);

    vec3 rgb = vec3(0.0);
    float a = 0.0;
    // Core (normal blend by day, mostly additive by night so it glows over dark streets).
    float coreI = mix(1.05, 2.6, night);
    vec3 coreRgb = col * coreI * (0.82 + 0.18 * centre) + hot * chev * mix(0.9, 2.4, night) + vec3(1.0) * centre * night * 0.6;
    float coreA = mix(0.92, 0.45, night);
    rgb += coreRgb * core;
    a += coreA * core;
    // Casing: dark outline by day for contrast on light streets.
    rgb += col * 0.06 * casing * (1.0 - night);
    a += 0.55 * casing * (1.0 - night);
    // Halo: soft additive glow (strong at night, a hint by day).
    rgb += col * halo * mix(0.10, 0.75, night) * (1.0 - casing * (1.0 - night));
    // Reveal head flash.
    rgb += hot * headGlow * core * 2.0;

    float w = vW;
    #ifdef XRAY
      // See-through pass (behind towers): core only, faint, only when the camera is far.
      float xr = smoothstep(350.0, 1400.0, vCamDist);
      rgb = (coreRgb * core * 0.8 + col * halo * 0.25 * night) * xr;
      a = core * 0.5 * xr;
    #endif
    rgb *= w;
    a = min(1.0, a * min(w, 1.0));
    if (a <= 0.002 && max(rgb.r, max(rgb.g, rgb.b)) <= 0.002) discard;
    gl_FragColor = vec4(rgb, a);
  }
`;

function premulMaterial(opts: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  const m = new THREE.ShaderMaterial({
    ...opts,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
  m.toneMapped = false;
  return m;
}

export function createRibbonMaterial(u: SharedUniforms, xray = false) {
  const m = premulMaterial({ vertexShader: RIBBON_VS, fragmentShader: (xray ? '#define XRAY\n' : '') + RIBBON_FS, uniforms: u });
  if (xray) {
    m.depthTest = false;
    m.polygonOffset = false;
  }
  return m;
}

export function buildRibbonGeometry(inputs: RibbonInput[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const r of inputs) {
    nv += r.line.n * 2;
    ni += Math.max(0, r.line.n - 1) * 6;
  }
  const pos = new Float32Array(nv * 3);
  const side = new Float32Array(nv * 2);
  const across = new Float32Array(nv);
  const dist = new Float32Array(nv);
  const meta = new Float32Array(nv * 4);
  const color = new Float32Array(nv * 3);
  const index = new Uint32Array(ni);
  let v = 0;
  let ii = 0;
  for (const r of inputs) {
    const { p, d, n, length } = r.line;
    const base = v;
    for (let i = 0; i < n; i++) {
      // Miter direction (xz).
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      let ax = p[i * 3] - p[i0 * 3];
      let az = p[i * 3 + 2] - p[i0 * 3 + 2];
      let bx = p[i1 * 3] - p[i * 3];
      let bz = p[i1 * 3 + 2] - p[i * 3 + 2];
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la > 1e-4) {
        ax /= la;
        az /= la;
      }
      if (lb > 1e-4) {
        bx /= lb;
        bz /= lb;
      }
      if (la <= 1e-4) {
        ax = bx;
        az = bz;
      }
      if (lb <= 1e-4) {
        bx = ax;
        bz = az;
      }
      let tx = ax + bx;
      let tz = az + bz;
      const lt = Math.hypot(tx, tz) || 1;
      tx /= lt;
      tz /= lt;
      // Normal = tangent rotated 90° (left side), miter-scaled.
      let nx = -tz;
      let nz = tx;
      const cosHalf = Math.max(0.5, nx * -bz + nz * bx);
      nx /= cosHalf;
      nz /= cosHalf;
      for (let s = 0; s < 2; s++) {
        pos[v * 3] = p[i * 3];
        pos[v * 3 + 1] = p[i * 3 + 1];
        pos[v * 3 + 2] = p[i * 3 + 2];
        side[v * 2] = nx;
        side[v * 2 + 1] = nz;
        across[v] = s === 0 ? -1 : 1;
        dist[v] = d[i];
        meta[v * 4] = length;
        meta[v * 4 + 1] = r.lane;
        meta[v * 4 + 2] = r.order;
        meta[v * 4 + 3] = r.incIdx;
        color[v * 3] = r.color.r;
        color[v * 3 + 1] = r.color.g;
        color[v * 3 + 2] = r.color.b;
        v++;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      index[ii++] = a;
      index[ii++] = a + 1;
      index[ii++] = a + 2;
      index[ii++] = a + 1;
      index[ii++] = a + 3;
      index[ii++] = a + 2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSideDir', new THREE.BufferAttribute(side, 2));
  g.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
  g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
  g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

// ───────────────────────────── Air arcs: dotted trails ─────────────────────────────

const ARC_VS = /* glsl */ `
  #define MAX_INC ${MAX_INC}
  uniform float uPx;
  uniform float uTime;
  uniform float uIncW[MAX_INC];
  attribute float aDist;
  attribute vec4 aMeta; // len, ground(0/1), order, incIdx
  attribute vec3 aColor;
  varying float vDist;
  varying float vLen;
  varying float vOrder;
  varying float vW;
  varying float vGround;
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    vDist = aDist;
    vLen = aMeta.x;
    vGround = aMeta.y;
    vOrder = aMeta.z;
    vW = uIncW[int(aMeta.w + 0.5)];
    vColor = aColor;
    float ph = fract(aDist / 90.0 - uTime * 0.7);
    vPulse = smoothstep(0.75, 1.0, ph) + smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.12, 0.3, ph));
    float worldSize = mix(4.5, 3.0, aMeta.y);
    float px = worldSize / max(1.0, dist * uPx);
    gl_PointSize = clamp(px, mix(3.2, 2.0, aMeta.y), 14.0) * (1.0 + 0.5 * vPulse * (1.0 - aMeta.y));
    gl_Position = projectionMatrix * mv;
  }
`;

const ARC_FS = /* glsl */ `
  uniform float uTime;
  uniform float uShowT;
  uniform float uNight;
  varying float vDist;
  varying float vLen;
  varying float vOrder;
  varying float vW;
  varying float vGround;
  varying vec3 vColor;
  varying float vPulse;
  void main() {
    float head = (uTime - uShowT - vOrder * 0.12) * 1100.0;
    if (vDist > head) discard;
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float disc = 1.0 - smoothstep(0.45, 1.0, r2);
    float coreDot = 1.0 - smoothstep(0.0, 0.35, r2);
    vec3 hot = mix(vColor, vec3(1.0), 0.5);
    float I = mix(1.1, 2.4, uNight) * (0.55 + 0.9 * vPulse);
    vec3 rgb = (vColor * disc + hot * coreDot) * I;
    float a = disc * mix(0.8, 0.35, uNight);
    if (vGround > 0.5) {
      // Ground shadow of the arc: faint dark dots by day, faint glow at night.
      rgb = vColor * disc * mix(0.05, 0.5, uNight);
      a = disc * mix(0.35, 0.0, uNight);
    }
    rgb *= vW;
    a *= min(vW, 1.0);
    gl_FragColor = vec4(rgb, a);
  }
`;

export function createArcMaterial(u: SharedUniforms) {
  const m = premulMaterial({ vertexShader: ARC_VS, fragmentShader: ARC_FS, uniforms: u });
  m.polygonOffset = false;
  return m;
}

export function buildArcGeometry(inputs: { line: Polyline; ground: number[]; color: THREE.Color; incIdx: number; order: number }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const dist: number[] = [];
  const meta: number[] = [];
  const color: number[] = [];
  const SP = 11;
  const v = new THREE.Vector3();
  for (const r of inputs) {
    const L = r.line.length;
    const n = Math.max(2, Math.floor(L / SP));
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * L;
      const p = r.line.p;
      // sample (linear search is fine: built once)
      let i = 0;
      while (i < r.line.n - 2 && r.line.d[i + 1] < s) i++;
      const t = (s - r.line.d[i]) / ((r.line.d[i + 1] - r.line.d[i]) || 1);
      v.set(p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * t, p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * t, p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * t);
      pos.push(v.x, v.y, v.z);
      dist.push(s);
      meta.push(L, 0, r.order, r.incIdx);
      color.push(r.color.r, r.color.g, r.color.b);
      // Ground shadow every other dot.
      if (k % 2 === 0) {
        const gi = Math.min(r.ground.length - 1, Math.round((k / n) * (r.ground.length - 1)));
        pos.push(v.x, r.ground[gi], v.z);
        dist.push(s);
        meta.push(L, 1, r.order, r.incIdx);
        color.push(r.color.r, r.color.g, r.color.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
  g.setAttribute('aMeta', new THREE.Float32BufferAttribute(meta, 4));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(color, 3));
  return g;
}

export { premulMaterial };
