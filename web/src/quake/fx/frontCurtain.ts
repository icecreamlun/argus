/**
 * Vertical "light curtain" standing on the live wave front, so the sweep reads in 3D from the air
 * (a ground band alone is mostly hidden by buildings). Each frame the iso-line arrival(x,z) = t is
 * extracted from the coarse arrival grid with marching squares and extruded into a ribbon that rises
 * from the ground and fades upward with a shimmering, streaky profile. Only rebuilt while a front is
 * inside the grid (≈ 1–2 s per wave), so the CPU cost is negligible.
 */
import * as THREE from 'three';
import type { Heightfield } from '../../contracts';
import type { Rect } from './drape';
import { NOISE_GLSL } from './glsl';

const MAX_SEG = 6000;

const VERT = /* glsl */ `
attribute float aH;
attribute float aS;
varying float vH;
varying float vS;
varying vec3 vW;
void main() {
	vH = aH;
	vS = aS;
	vec4 w = modelMatrix * vec4( position, 1.0 );
	vW = w.xyz;
	gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uGain;
uniform float uTime;
uniform float uFadeR;
varying float vH;
varying float vS;
varying vec3 vW;
${NOISE_GLSL}
void main() {
	float streak = 0.55 + 0.45 * vnoise( vec2( vS * 0.05, uTime * 2.0 ) ) + 0.25 * vnoise( vec2( vS * 0.31, vH * 3.0 - uTime * 6.0 ) );
	float prof = pow( 1.0 - vH, 2.2 ) * smoothstep( 0.0, 0.04, vH );
	float edge = 1.0 - smoothstep( uFadeR * 0.55, uFadeR, length( vW.xz ) );
	vec3 c = uCol * prof * streak * edge * uGain;
	if ( c.r + c.g + c.b < 1e-4 ) discard;
	gl_FragColor = vec4( c, 1.0 );
}
`;

export class FrontCurtain {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos = new Float32Array(MAX_SEG * 4 * 3);
  private readonly h = new Float32Array(MAX_SEG * 4);
  private readonly s = new Float32Array(MAX_SEG * 4);
  private readonly geo = new THREE.BufferGeometry();

  constructor(
    color: THREE.Color,
    private readonly height: number,
    private readonly terrain: Heightfield,
  ) {
    const idx = new Uint32Array(MAX_SEG * 6);
    for (let i = 0; i < MAX_SEG; i++) {
      const a = i * 4;
      idx.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6);
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aH', new THREE.BufferAttribute(this.h, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aS', new THREE.BufferAttribute(this.s, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uCol: { value: color }, uGain: { value: 1 }, uTime: { value: 0 }, uFadeR: { value: 3000 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  /**
   * Rebuild the ribbon along field(x,z) = t. `field` is a GW×GH grid over `rect` (row-major, rows = z).
   * `gain` fades the curtain in/out over the wave's passage.
   */
  update(field: Float32Array, gw: number, gh: number, rect: Rect, t: number, gain: number): void {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uGain.value = gain * this.strength;
    if (gain <= 0.001) {
      this.mesh.visible = false;
      return;
    }
    const dx = (rect.maxX - rect.minX) / (gw - 1);
    const dz = (rect.maxZ - rect.minZ) / (gh - 1);
    let n = 0;
    const P = this.pos;
    const H = this.h;
    const S = this.s;
    const ground = (x: number, z: number) => Math.max(this.terrain.heightAt(x, z), 0) - 2;
    const emit = (x0: number, z0: number, x1: number, z1: number) => {
      if (n >= MAX_SEG) return;
      const g0 = ground(x0, z0);
      const g1 = ground(x1, z1);
      const o = n * 12;
      P[o] = x0;
      P[o + 1] = g0;
      P[o + 2] = z0;
      P[o + 3] = x0;
      P[o + 4] = g0 + this.height;
      P[o + 5] = z0;
      P[o + 6] = x1;
      P[o + 7] = g1;
      P[o + 8] = z1;
      P[o + 9] = x1;
      P[o + 10] = g1 + this.height;
      P[o + 11] = z1;
      const k = n * 4;
      H[k] = 0;
      H[k + 1] = 1;
      H[k + 2] = 0;
      H[k + 3] = 1;
      // Arc-length-ish coordinate for streaks: use world position (stable while the front moves).
      const s0 = x0 * 0.7 + z0 * 0.7;
      const s1 = x1 * 0.7 + z1 * 0.7;
      S[k] = s0;
      S[k + 1] = s0;
      S[k + 2] = s1;
      S[k + 3] = s1;
      n++;
    };
    // Marching squares (one line per cell is enough for a smooth monotone field; saddles are rare).
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < gw - 1; i++) {
        const a = field[j * gw + i] - t;
        const b = field[j * gw + i + 1] - t;
        const c = field[(j + 1) * gw + i + 1] - t;
        const d = field[(j + 1) * gw + i] - t;
        const pts: number[] = [];
        const x = rect.minX + i * dx;
        const z = rect.minZ + j * dz;
        if (a < 0 !== b < 0) pts.push(x + (a / (a - b)) * dx, z);
        if (b < 0 !== c < 0) pts.push(x + dx, z + (b / (b - c)) * dz);
        if (c < 0 !== d < 0) pts.push(x + (d / (d - c)) * dx, z + dz);
        if (d < 0 !== a < 0) pts.push(x, z + (a / (a - d)) * dz);
        if (pts.length >= 4) emit(pts[0], pts[1], pts[2], pts[3]);
        if (pts.length >= 8) emit(pts[4], pts[5], pts[6], pts[7]);
      }
    }
    this.geo.setDrawRange(0, n * 6);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aH as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aS as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  private strength = 1;
  setGain(k: number): void {
    this.strength = k;
  }

  setFade(r: number): void {
    this.mat.uniforms.uFadeR.value = r;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
