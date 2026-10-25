/**
 * Settled dust: a pale, streaky coat on the streets and plazas around each collapse (out to ~3× its debris
 * radius, stretched downwind), fading in as the cloud settles and staying afterwards. This replaces a global
 * haze: the devastation stays local and readable from the air.
 *
 * One small terrain-following patch per site (3 m grid, lifted above curbs, polygon-offset), merged into one
 * lit, transparent draw. Coverage is computed per vertex on the CPU; the fragment shader breaks it up with
 * world-space noise (drifts, tyre-free streaks) so no patch edge or grid is ever visible.
 */
import * as THREE from 'three';
import type { Heightfield, XZ } from '../../contracts';
import { signedDistance } from './geom2d';
import { NOISE_GLSL } from './glsl';

export interface DustSite {
  x: number;
  z: number;
  /** Debris radius (m). */
  R: number;
  /** When the dust starts settling (s). */
  t0: number;
  ring: XZ[];
  col: THREE.Color;
  /** Overwater sites (piers) get no ground coat. */
  overWater?: boolean;
}

const VERT_PARS = /* glsl */ `
attribute float aCov;
attribute float aT0;
varying float vCov;
varying float vT0;
varying vec3 vDW;
`;
const VERT_BEGIN = /* glsl */ `
	vec3 transformed = position;
	vCov = aCov;
	vT0 = aT0;
	vDW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
`;
const FRAG_PARS = /* glsl */ `
uniform float uTime;
varying float vCov;
varying float vT0;
varying vec3 vDW;
${NOISE_GLSL}
`;
const FRAG_COLOR = /* glsl */ `
	float settle = smoothstep( vT0, vT0 + 35.0, uTime );
	float big = fbm3( vDW.xz * 0.06 );
	float streak = vnoise( vec2( vDW.x * 0.35 + vDW.z * 0.12, vDW.z * 0.05 ) );
	float grain = vnoise( vDW.xz * 2.3 );
	float cov = clamp( vCov * ( 0.7 + 0.8 * big ) - 0.06 + 0.14 * ( streak - 0.5 ), 0.0, 1.0 );
	float dAlpha = cov * settle * ( 0.8 + 0.2 * grain );
	diffuseColor.rgb *= vColor.rgb * ( 0.9 + 0.2 * grain );
	diffuseColor.a = min( dAlpha, 0.86 );
`;

export class DustDecals {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = { uTime: { value: 0 } };

  constructor() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    mat.name = 'quakeDustDecal';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', VERT_BEGIN);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <color_fragment>', FRAG_COLOR);
    };
    mat.customProgramCacheKey = () => 'argus-dust-decal';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.name = 'quakeDustDecals';
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  set(sites: DustSite[], terrain: Heightfield, wind: THREE.Vector3): void {
    this.mesh.geometry.dispose();
    const pos: number[] = [];
    const col: number[] = [];
    const cov: number[] = [];
    const t0s: number[] = [];
    const idx: number[] = [];
    const wl = Math.hypot(wind.x, wind.z) || 1;
    const wx = wind.x / wl;
    const wz = wind.z / wl;
    const STEP = 3;
    for (const s of sites) {
      if (s.overWater) continue;
      // Kept close to the site (≈1.6× debris radius) so the pale coat marks THIS ruin, not its neighbours' frontage.
      const Rp = THREE.MathUtils.clamp(s.R * 1.6 + 9, 16, 40);
      const n = Math.ceil((2 * Rp) / STEP) + 1;
      const base = pos.length / 3;
      const keep = new Uint8Array(n * n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const x = s.x - Rp + i * STEP;
          const z = s.z - Rp + j * STEP;
          const h = terrain.heightAt(x, z);
          const d = Math.max(0, signedDistance(x, z, s.ring));
          // Downwind side carries further.
          const ox = x - s.x;
          const oz = z - s.z;
          const ol = Math.hypot(ox, oz) || 1;
          const reach = Rp * (0.8 + 0.2 * ((ox * wx + oz * wz) / ol)) * 0.92;
          let c = 1 - THREE.MathUtils.smoothstep(d, 0, reach);
          c = Math.pow(c, 1.4);
          // Fade before the patch border no matter what.
          c *= 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(ox), Math.abs(oz)), Rp * 0.8, Rp * 0.98);
          if (h < 0.3) c = 0;
          keep[j * n + i] = c > 0.01 ? 1 : 0;
          pos.push(x, Math.max(h, 0) + 0.32, z);
          col.push(s.col.r, s.col.g, s.col.b);
          cov.push(c);
          t0s.push(s.t0);
        }
      for (let j = 0; j < n - 1; j++)
        for (let i = 0; i < n - 1; i++) {
          const a = j * n + i;
          if (!keep[a] && !keep[a + 1] && !keep[a + n] && !keep[a + n + 1]) continue;
          const A = base + a;
          idx.push(A, A + n, A + 1, A + 1, A + n, A + n + 1);
        }
    }
    const g = new THREE.BufferGeometry();
    if (idx.length) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aCov', new THREE.Float32BufferAttribute(cov, 1));
      g.setAttribute('aT0', new THREE.Float32BufferAttribute(t0s, 1));
      g.setIndex(idx);
    }
    this.mesh.geometry = g;
    this.mesh.visible = idx.length > 0;
  }

  update(t: number): void {
    this.uniforms.uTime.value = t;
  }

  clear(): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.BufferGeometry();
    this.mesh.visible = false;
  }
}
