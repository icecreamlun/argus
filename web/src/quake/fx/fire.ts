/**
 * Post-earthquake fires: flames, embers, smoke emitters and a small pool of flickering point lights.
 *
 * Each burning building ignites shortly after its failure (ruptured gas services), then the fire climbs:
 * window flames on floor k light up ~12 s after floor k−1, roof flames join after ~30–70 s. Flames are
 * vertical-axis billboards shaded procedurally (scrolling fbm, teardrop mask, blackbody-ish ramp) in HDR
 * so they bloom; embers are recycled additive sparks that ride the plume. Smoke is emitted into the lit
 * particle system (dark soot, fire-lit at its base). Emission intensity and flame activation are pure
 * functions of sim time; only the high-frequency flicker uses the wall clock so paused frames still burn.
 *
 * Lighting: ≤ 6 PointLights total, created with the module (intensity 0) and reused: every frame they go to the
 * fires that matter most (intensity / distance to camera). The light count never changes → no shader recompiles
 * (measured idle cost ≈ 3 % at street level, vs a ~2 s stall if they were added when the quake starts).
 */
import * as THREE from 'three';
import type { AppContext, XZ } from '../../contracts';
import { NOISE_GLSL } from './glsl';
import { pointInRing, pointOnRing, ringBounds } from './geom2d';
import type { ParticleSpec } from './particles';
import type { CityPrep } from './prep';
import { hashStr, mulberry32, range, type Rng } from './rng';
import type { RuinShape } from './rules';
import type { GroupFail } from './spawn';
import { smoothstep } from './timeline';

export const MAX_FIRE_LIGHTS = 6;

export interface FireSite {
  g: number;
  x: number;
  y: number;
  z: number;
  tIgn: number;
  size: number;
}

const FLAME_VERT = /* glsl */ `
attribute vec4 aBase;
attribute vec4 aDim;
uniform float uTime;
uniform float uAnim;
uniform vec3 uWind;
varying vec2 vUv;
varying float vOn;
varying float vSeed;
varying float vKind;
void main() {
	float on = smoothstep( aBase.w, aBase.w + 5.0, uTime );
	float grow = on * ( 0.65 + 0.35 * smoothstep( aBase.w, aBase.w + 50.0, uTime ) );
	vec3 toCam = cameraPosition - aBase.xyz;
	vec3 fdir = normalize( vec3( toCam.x, 0.0, toCam.z ) + vec3( 1e-4, 0.0, 0.0 ) );
	vec3 right = vec3( fdir.z, 0.0, - fdir.x );
	// Readable from afar: flames grow a little with camera distance (they are only a few pixels at 600 m).
	float dCam = distance( cameraPosition, aBase.xyz );
	float fFar = 1.0 + 1.1 * smoothstep( 120.0, 900.0, dCam );
	float w = aDim.x * grow * fFar;
	float h = aDim.y * grow * fFar * ( 0.86 + 0.14 * sin( uAnim * 2.3 + aDim.z * 17.0 ) * sin( uAnim * 3.7 + aDim.z * 5.0 ) );
	vec3 p;
	if ( aDim.w > 1.5 ) {
		// Site glow: the fire-lit smoke column over a burning building (tall soft ellipse).
		vec3 camU = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
		vec3 camR = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
		p = aBase.xyz + camR * position.x * w + camU * ( position.y - 0.5 ) * h;
		p += uWind * 0.04 * h * ( position.y - 0.2 );
	} else if ( aDim.w > 0.5 ) {
		// Halo: camera-facing soft glow centred a little above the base.
		vec3 camU = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
		vec3 camR = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
		p = aBase.xyz + vec3( 0.0, h * 0.35, 0.0 ) + camR * position.x * w + camU * ( position.y - 0.5 ) * w;
	} else {
		p = aBase.xyz + right * position.x * w + vec3( 0.0, position.y * h, 0.0 ) + fdir * 0.4;
		p.xz += uWind.xz * 0.12 * position.y * position.y * h * ( 0.8 + 0.2 * sin( uAnim * 1.7 + aDim.z * 9.0 ) );
	}
	vUv = vec2( position.x + 0.5, position.y );
	vOn = on;
	vSeed = aDim.z;
	vKind = aDim.w;
	gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
	if ( on < 0.001 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
}
`;

const FLAME_FRAG = /* glsl */ `
uniform float uAnim;
uniform float uGain;
uniform float uNight;
varying vec2 vUv;
varying float vOn;
varying float vSeed;
varying float vKind;
${NOISE_GLSL}
vec3 blackbody( float t ) {
	// Deep red → orange → amber → pale yellow (saturates to orange, only the hottest core goes pale).
	vec3 c = mix( vec3( 0.45, 0.03, 0.0 ), vec3( 1.0, 0.28, 0.02 ), smoothstep( 0.0, 0.4, t ) );
	c = mix( c, vec3( 1.0, 0.55, 0.1 ), smoothstep( 0.4, 0.75, t ) );
	return mix( c, vec3( 1.0, 0.82, 0.45 ), smoothstep( 0.8, 1.0, t ) );
}
void main() {
	if ( vKind > 1.5 ) {
		vec2 q = vUv * 2.0 - 1.0;
		float g = exp( - q.x * q.x * 3.0 - q.y * q.y * 2.2 ) * smoothstep( -1.0, -0.6, q.y );
		// Billowing smoke structure in the glow (lit undersides of the plume).
		g *= 0.35 + 1.1 * fbm3( vec2( q.x * 1.8 + vSeed * 9.0, q.y * 1.4 - uAnim * 0.18 ) );
		float fl = 0.85 + 0.15 * sin( uAnim * 5.0 + vSeed * 40.0 ) * sin( uAnim * 2.3 + vSeed * 7.0 );
		gl_FragColor = vec4( vec3( 1.0, 0.36, 0.08 ) * g * 0.16 * fl * uGain * vOn * mix( 0.12, 1.0, uNight ), 1.0 );
		return;
	}
	if ( vKind > 0.5 ) {
		vec2 q = vUv * 2.0 - 1.0;
		float g = exp( - dot( q, q ) * 3.2 );
		float fl = 0.8 + 0.2 * sin( uAnim * 7.0 + vSeed * 40.0 ) * sin( uAnim * 3.1 + vSeed * 13.0 );
		gl_FragColor = vec4( vec3( 1.0, 0.32, 0.06 ) * g * 0.55 * fl * uGain * vOn * mix( 0.45, 1.0, uNight ), 1.0 );
		return;
	}
	float t = uAnim * 1.5 + vSeed * 31.0;
	vec2 q = vec2( ( vUv.x - 0.5 ) * 2.0, vUv.y );
	// Domain-warped fbm scrolling upward: several licking tongues of different heights that break off at
	// the top (a flame sheet, not a single candle teardrop).
	vec2 wq = vec2( q.x * 1.8 + vSeed * 5.0, q.y * 2.4 - t * 1.9 );
	float w1 = fbm3( wq * 0.9 );
	float n = fbm3( wq + vec2( w1 * 1.6, w1 * 0.7 ) );
	float n2 = vnoise( vec2( q.x * 6.0, q.y * 7.0 - t * 3.6 ) );
	float tongues = fbm3( vec2( q.x * 2.6 + vSeed * 7.0, t * 0.8 ) );
	float topH = 0.3 + 0.75 * tongues;
	float xo = abs( q.x + ( n - 0.5 ) * 0.7 * q.y );
	float body = 1.0 - smoothstep( 0.55 + 0.25 * n, 0.95, xo + q.y * 0.25 );
	float top = 1.0 - smoothstep( topH * ( 0.55 + 0.35 * n ), topH, q.y + ( n2 - 0.5 ) * 0.22 );
	float base = smoothstep( 0.0, 0.08, q.y );
	float heat = clamp( body * top * base * ( 0.6 + 0.6 * n2 ) * 1.25, 0.0, 1.0 );
	if ( heat < 0.03 ) discard;
	float core = smoothstep( 0.6, 1.0, heat ) * ( 1.0 - q.y * 0.8 );
	vec3 col = blackbody( heat * ( 0.72 + 0.38 * ( 1.0 - q.y ) ) );
	gl_FragColor = vec4( col * heat * uGain * vOn * ( 1.6 + 3.2 * core ), 1.0 );
}
`;

const EMBER_VERT = /* glsl */ `
attribute vec4 aE0;
attribute vec4 aE1;
uniform float uTime;
uniform vec3 uWind;
uniform float uPxWorld;
varying float vA;
varying vec2 vQ;
void main() {
	float life = aE1.y;
	float local = uTime - aE0.w;
	float age = mod( local + aE1.x * life, life );
	float on = smoothstep( 0.0, 8.0, local );
	vec3 p = aE0.xyz;
	float s = aE1.x * 37.0;
	p += vec3( sin( age * 1.3 + s ) * 1.5 * age, aE1.z * age, cos( age * 1.1 + s * 1.7 ) * 1.5 * age );
	p += uWind * age * 0.9;
	float fade = smoothstep( 0.0, 0.3, age ) * ( 1.0 - smoothstep( life * 0.5, life, age ) );
	vec4 mv = viewMatrix * vec4( p, 1.0 );
	float px = - mv.z * uPxWorld;
	float size = max( aE1.w, 2.2 * px );
	vA = fade * on * ( aE1.w / size ) * ( 0.6 + 0.4 * sin( uTime * 23.0 + s ) );
	mv.xy += position.xy * size;
	vQ = position.xy * 2.0;
	gl_Position = projectionMatrix * mv;
	if ( local < 0.0 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
}
`;

const EMBER_FRAG = /* glsl */ `
varying float vA;
varying vec2 vQ;
void main() {
	float d = dot( vQ, vQ );
	float a = exp( - d * 3.0 ) * vA;
	if ( a < 0.01 ) discard;
	gl_FragColor = vec4( vec3( 1.0, 0.5, 0.15 ) * a * 9.0, 1.0 );
}
`;

export class FireSystem {
  readonly group = new THREE.Group();
  private readonly flameMat: THREE.ShaderMaterial;
  private readonly emberMat: THREE.ShaderMaterial;
  private readonly flames: THREE.Mesh;
  private readonly embers: THREE.Mesh;
  private sites: FireSite[] = [];
  private lights: THREE.PointLight[] = [];
  private readonly scored: { i: number; s: number }[] = [];

  constructor(private readonly scene: THREE.Object3D) {
    this.group.name = 'quakeFire';
    const common = { uTime: { value: 0 }, uAnim: { value: 0 }, uWind: { value: new THREE.Vector3(3, 0, 0.8) } };
    this.flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: { ...common, uGain: { value: 1 }, uNight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.emberMat = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: { uTime: common.uTime, uWind: common.uWind, uPxWorld: { value: 0.001 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.flames = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.flameMat);
    this.embers = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.emberMat);
    for (const m of [this.flames, this.embers]) {
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 6;
    }
    this.flames.name = 'fireFlames';
    this.embers.name = 'fireEmbers';
    this.group.add(this.flames, this.embers);
    // Create the pooled lights up front (intensity 0): every scene program then compiles with them at boot,
    // so triggering a quake doesn't stall the frame while all materials recompile for a new light count.
    this.ensureLights();
  }

  get lightList(): readonly THREE.PointLight[] {
    return this.lights;
  }

  get windUniform(): THREE.Vector3 {
    return this.flameMat.uniforms.uWind.value as THREE.Vector3;
  }

  /** Build flames/embers for the burning groups; returns the smoke particles to feed the smoke system. */
  load(ctx: AppContext, prep: CityPrep, fails: GroupFail[], shapes: Map<number, RuinShape>): ParticleSpec[] {
    const B = ctx.city.buildings;
    this.sites = [];
    const fBase: number[] = [];
    const fDim: number[] = [];
    const e0: number[] = [];
    const e1: number[] = [];
    const smoke: ParticleSpec[] = [];
    for (const f of fails) {
      if (!f.fire) continue;
      const grp = prep.groups[f.g];
      const r = mulberry32(hashStr(grp.key) ^ 0xf17e);
      const rec = B[grp.rep];
      const ring = rec.footprint as XZ[];
      const H = grp.height;
      const shape = shapes.get(f.g);
      // Collapsed: the fire burns in the rubble (shell) or on the dropped block's roof.
      const top = grp.base + (shape ? (shape.shell ? shape.hin : shape.top) : H);
      const tIgn = Math.max(f.tf, f.sA + 4) + range(r, 2, 16);
      const storeys = Math.max(1, grp.storeys);
      const floorH = H / storeys;
      const per = prep.perimeter[grp.rep];
      const area = prep.area[grp.rep];
      const ground = (x: number, z: number) => (rec.overWater ? grp.base : ctx.terrain.heightAt(x, z));
      const flamePts: [number, number, number][] = [];
      const addFlame = (x: number, y: number, z: number, tOn: number, w: number, h: number) => {
        fBase.push(x, y, z, tOn);
        fDim.push(w, h, r(), 0);
        flamePts.push([x, y, z]);
        // Every third flame gets a soft halo (reads from afar, feeds the bloom).
        if (flamePts.length % 3 === 1) {
          fBase.push(x, y, z, tOn + 1);
          fDim.push(Math.max(w, h) * 2.6, h, r(), 1);
        }
      };
      if (f.collapsed) {
        const n = Math.round(Math.min(30, 8 + area / 35));
        for (let k = 0; k < n; k++) {
          const [x, z] = insideRing(ring, r);
          addFlame(x, Math.max(ground(x, z), top - range(r, 0.3, 1.2)), z, tIgn + Math.pow(r(), 1.5) * 70, range(r, 4, 6.5), range(r, 4, 7.5));
        }
      } else {
        const floors = Math.min(storeys, 9);
        const nw = Math.round(Math.min(56, Math.max(12, per / 2.6)));
        for (let k = 0; k < nw; k++) {
          const fl = Math.min(floors - 1, Math.floor(Math.pow(r(), 1.3) * floors));
          const p = pointOnRing(ring, r());
          const y = grp.base + fl * floorH + floorH * 0.25;
          addFlame(p.x + p.nx * 0.4, y, p.z + p.nz * 0.4, tIgn + fl * 10 + range(r, 0, 20), range(r, 2.8, 4.6), range(r, 3.5, 6.5));
        }
        if (storeys <= 8) {
          const nr = Math.round(Math.min(18, Math.max(4, area / 70)));
          for (let k = 0; k < nr; k++) {
            const [x, z] = insideRing(ring, r);
            addFlame(x, top - 0.3, z, tIgn + range(r, 20, 65), range(r, 4.5, 7), range(r, 5, 8.5));
          }
        }
      }
      // Light / smoke anchor: centre of the flames' area, a few metres up.
      let lx = 0;
      let ly = 0;
      let lz = 0;
      for (const p of flamePts) {
        lx += p[0];
        ly += p[1];
        lz += p[2];
      }
      const nf = Math.max(1, flamePts.length);
      this.sites.push({ g: f.g, x: lx / nf, y: ly / nf + 4, z: lz / nf, tIgn, size: Math.sqrt(area) });

      // Embers.
      const ne = 70;
      for (let k = 0; k < ne; k++) {
        const p = flamePts[Math.floor(r() * flamePts.length)] ?? [lx / nf, top, lz / nf];
        e0.push(p[0], p[1] + 2, p[2], tIgn + range(r, 0, 25));
        e1.push(r(), range(r, 3, 7), range(r, 5, 11), range(r, 0.12, 0.3));
      }

      // Smoke plume (recycled slots): a buoyant column that bends downwind and spreads with height, 250–400 m
      // tall at full strength (rise ≈ 3.5–5 m/s for ~80 s, the wind shears the top over the bay). Dense sooty
      // brown-black at the base, greying and thinning as it entrains air.
      const strength = THREE.MathUtils.clamp(Math.sqrt(area) / 22, 0.7, 1.5);
      const M = Math.round(150 + 60 * strength);
      const period = 84;
      for (let k = 0; k < M; k++) {
        const p = flamePts[Math.floor(r() * flamePts.length)] ?? [lx / nf, top, lz / nf];
        const soot = range(r, 0.022, 0.05);
        smoke.push({
          x: p[0] + range(r, -2, 2),
          y: Math.max(p[1], top) + range(r, 1, 4),
          z: p[2] + range(r, -2, 2),
          vx: range(r, -1.2, 1.2),
          vy: range(r, 9, 14),
          vz: range(r, -1.2, 1.2),
          drag: range(r, 0.07, 0.11),
          t0: tIgn + 3,
          phase: (k / M) * period,
          life: period * range(r, 0.88, 1),
          period,
          rise: range(r, 3.4, 5.0) * strength,
          // Narrow at the base, ~45 m wide 180 m up, 70–110 m at the sheared top (plume half-angle ≈ 10°).
          size0: range(r, 9, 14) * strength,
          size1: range(r, 80, 125) * strength,
          expand: range(r, 38, 52),
          rot: r(),
          spin: range(r, -0.04, 0.04),
          r: soot * 1.12,
          g: soot,
          b: soot * 0.88,
          alpha: range(r, 0.42, 0.62),
          glow: range(r, 0.8, 1.4),
          wind: range(r, 1.0, 1.3),
          turb: range(r, 6, 16),
          grow: 45,
          big: 0.75,
        });
      }
    }

    this.setFlames(fBase, fDim);
    this.setEmbers(e0, e1);
    this.ensureLights();
    return smoke;
  }

  private setFlames(base: number[], dim: number[]): void {
    this.flames.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(base), 4));
    g.setAttribute('aDim', new THREE.InstancedBufferAttribute(new Float32Array(dim), 4));
    g.instanceCount = base.length / 4;
    this.flames.geometry = g;
    this.flames.visible = g.instanceCount > 0;
  }

  private setEmbers(a: number[], b: number[]): void {
    this.embers.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aE0', new THREE.InstancedBufferAttribute(new Float32Array(a), 4));
    g.setAttribute('aE1', new THREE.InstancedBufferAttribute(new Float32Array(b), 4));
    g.instanceCount = a.length / 4;
    this.embers.geometry = g;
    this.embers.visible = g.instanceCount > 0;
  }

  /** Lights are created once and never removed: the light count never changes → no recompiles. */
  private ensureLights(): void {
    if (this.lights.length) return;
    for (let k = 0; k < MAX_FIRE_LIGHTS; k++) {
      const l = new THREE.PointLight(0xff7a30, 0, 0, 2);
      l.name = `fireLight${k}`;
      l.castShadow = false;
      this.lights.push(l);
      this.scene.add(l);
    }
  }

  /** Fire strength 0..1 of site s at time t (grows over ~60 s). */
  strength(s: FireSite, t: number): number {
    return smoothstep(s.tIgn, s.tIgn + 8, t) * (0.45 + 0.55 * smoothstep(s.tIgn, s.tIgn + 70, t));
  }

  update(t: number, anim: number, camera: THREE.PerspectiveCamera, viewportH: number, night = 0): void {
    this.flameMat.uniforms.uTime.value = t;
    this.flameMat.uniforms.uNight.value = night;
    this.flameMat.uniforms.uAnim.value = anim;
    this.emberMat.uniforms.uPxWorld.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportH);
    if (!this.lights.length) return;
    // Assign the light pool.
    const cam = camera.position;
    this.scored.length = 0;
    this.sites.forEach((s, i) => {
      const k = this.strength(s, t);
      if (k <= 0) return;
      const d2 = (s.x - cam.x) ** 2 + (s.y - cam.y) ** 2 + (s.z - cam.z) ** 2;
      this.scored.push({ i, s: (k * (1 + s.size / 30)) / (1 + d2 / (450 * 450)) });
    });
    this.scored.sort((a, b) => b.s - a.s);
    for (let k = 0; k < this.lights.length; k++) {
      const l = this.lights[k];
      const e = this.scored[k];
      if (!e) {
        l.intensity = 0;
        continue;
      }
      const s = this.sites[e.i];
      const st = this.strength(s, t);
      const fl = 0.78 + 0.14 * Math.sin(anim * 13.1 + k * 1.7) + 0.08 * Math.sin(anim * 29.3 + k * 4.1);
      l.position.set(s.x + Math.sin(anim * 3.1 + k) * 0.6, s.y + Math.sin(anim * 2.3 + k * 2) * 0.4, s.z);
      l.intensity = 900 * st * fl * (0.6 + s.size / 60);
    }
  }

  clear(): void {
    this.sites = [];
    this.setFlames([], []);
    this.setEmbers([], []);
    for (const l of this.lights) l.intensity = 0;
  }
}

function insideRing(ring: XZ[], r: Rng): XZ {
  const [x0, z0, x1, z1] = ringBounds(ring);
  for (let k = 0; k < 20; k++) {
    const x = range(r, x0, x1);
    const z = range(r, z0, z1);
    if (pointInRing(x, z, ring)) return [x, z];
  }
  return [(x0 + x1) / 2, (z0 + z1) / 2];
}
