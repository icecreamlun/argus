/**
 * Lit billboard particles (dust clouds, smoke plumes) evaluated entirely on the GPU as a pure function of
 * sim time: every particle stores its emission state; the vertex shader integrates
 *     v(a) = v∞ + (v0 − v∞)·e^(−k·a),  v∞ = wind·w + rise·ŷ      (drag relaxation toward the ambient flow)
 *     x(a) = x0 + v∞·a + (v0 − v∞)(1 − e^(−k·a))/k + turbulence(a)
 * with size growing as the puff entrains air. Recycled emitters (smoke) use age = (t − t0) mod period.
 * Dust and smoke share ONE instanced draw.
 *
 * Look:
 *   • a procedural 4×4 flipbook atlas (4 puff shapes × 4 billowing frames, baked once): density + a relief
 *     normal, cross-faded by age, so clouds churn instead of being static stamps;
 *   • per particle (vertex): key light × one shadow-map tap, sky ambient from the engine's aerial-perspective
 *     table, warm light from the pooled fire lights, ember glow at the base of smoke plumes;
 *   • per pixel: wrap lighting on the relief normal with density self-shadowing, forward scattering toward the
 *     sun, fire light on the UNDERSIDES only (lit plume bellies, not orange balls), soft contact with the
 *     terrain (height texture) and with buildings (city distance field — no depth texture in this renderer).
 * Readability & cost: plume sprites grow with camera distance (aBig) so they still read from the overview;
 * sprites that would cover a large part of the screen fade out (overdraw cap), as do sprites at the camera.
 */
import * as THREE from 'three';
import { FOG_SLOTS } from '../../engine/fog';
import { CITY_FIELD_GLSL } from './cityField';
import { HEIGHT_GLSL, type HeightTexture } from './drape';
import { mulberry32 } from './rng';

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Drag rate k (1/s). */
  drag: number;
  /** Emission time (s) and lifetime (s). */
  t0: number;
  life: number;
  /** Recycle period (s); 0 = one-shot. */
  period: number;
  /** Terminal rise speed (m/s). */
  rise: number;
  size0: number;
  size1: number;
  rot: number;
  spin: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  /** Fire glow (emissive) at birth, fading with age. */
  glow: number;
  /** Fraction of the wind the particle follows. */
  wind: number;
  /** Turbulent wander amplitude (m). */
  turb: number;
  /** Emitter growth time (s): alpha scales with smoothstep(t0, t0 + grow, emission time). 0 = off. */
  grow: number;
  /** Size expansion time constant (s); default 22 % of the lifetime. */
  expand?: number;
  /** Recycled emitters: this slot's first emission is at t0 + phase (growth is measured from t0). */
  phase?: number;
  /** 0..1: how much the sprite grows with camera distance to stay readable from afar (plumes 1, street dust ~0.3). */
  big?: number;
}

export const MAX_FIRE_LIGHTS_GLSL = 6;

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aP0;
attribute vec4 aV0;
attribute vec4 aT;
attribute vec4 aS;
attribute vec4 aC;
attribute vec4 aX;
attribute vec2 aE;
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform vec4 uFireP[ ${MAX_FIRE_LIGHTS_GLSL} ];
uniform float uNight;
uniform float uPxScale;
uniform float uMaxPx;
uniform vec4 argusFog[ ${FOG_SLOTS} ];
uniform vec3 fogColor;
${HEIGHT_GLSL}
varying vec2 vQuv;
varying float vAlpha;
varying vec3 vCol;
varying vec3 vKey;
varying vec3 vAmb;
varying vec3 vEmit;
varying vec3 vFire;
varying vec3 vPW;
varying vec3 vKeyView;
varying float vSize;
varying float vRot;
varying vec3 vFlip; // atlas sequence (x), frame (y), cross-fade (z)
void main() {
	float pAge = uTime - aT.x - aE.x;
	float pAlive = pAge >= 0.0 ? 1.0 : 0.0;
	if ( aT.z > 0.0 && pAge > 0.0 ) pAge = mod( pAge, aT.z );
	float pLife = aT.y;
	pAlive *= pAge < pLife ? 1.0 : 0.0;
	float k = max( aV0.w, 1e-3 );
	vec3 vInf = uWind * aX.y + vec3( 0.0, aT.w, 0.0 );
	float ek = exp( - k * pAge );
	vec3 pC = aP0.xyz + vInf * pAge + ( aV0.xyz - vInf ) * ( 1.0 - ek ) / k;
	float seed = aS.z;
	float tw = aX.z * min( pAge / 6.0, 1.0 );
	pC += tw * vec3( sin( pAge * 0.31 + seed * 7.0 ) + 0.5 * sin( pAge * 0.73 + seed * 3.1 ), 0.4 * sin( pAge * 0.43 + seed * 5.0 ), cos( pAge * 0.27 + seed * 9.0 ) + 0.5 * sin( pAge * 0.61 + seed ) );
	float grow01 = 1.0 - exp( - pAge / max( aP0.w, 0.3 ) );
	float pSize = mix( aS.x, aS.y, grow01 );
	float fadeIn = smoothstep( 0.0, min( 1.2, pLife * 0.08 ), pAge );
	float fadeOut = 1.0 - smoothstep( pLife * 0.45, pLife, pAge );
	// Dilution: the puff thins as it entrains air.
	float pA = aC.a * fadeIn * fadeOut * pAlive * mix( 1.0, 0.6, grow01 );
	if ( aX.w > 0.0 ) pA *= smoothstep( aT.x, aT.x + aX.w, uTime - pAge );

	// Readability from afar (plumes grow with distance) and overdraw control up close.
	float camD = distance( pC, cameraPosition );
	pSize *= 1.0 + aE.y * 0.95 * smoothstep( 450.0, 1500.0, camD );
	float rPx = 0.5 * pSize * uPxScale / max( camD, 1.0 );
	pA *= 1.0 - smoothstep( uMaxPx * 0.55, uMaxPx, rPx );
	pA *= smoothstep( pSize * 0.3, pSize * 0.85, camD );

	vAlpha = pA;
	// Fire smoke (glow > 0) greys as it dilutes; dust keeps its colour.
	vCol = aX.x > 0.0 ? mix( aC.rgb, vec3( 0.13, 0.12, 0.11 ), grow01 * 0.6 ) : aC.rgb;
	vSize = pSize;
	vRot = aS.z * 6.2832 + aS.w * pAge;
	float fr = clamp( pAge / max( pLife, 1.0 ), 0.0, 1.0 ) * 2.999;
	vFlip = vec3( floor( fract( seed * 13.17 ) * 4.0 ), floor( fr ), fract( fr ) );

	// ── Lighting per particle ──
	float sh = 1.0;
	if ( uShadowOn > 0.5 ) {
		vec4 sc = uShadowMatrix * vec4( pC + uKeyDir * pSize * 0.25, 1.0 );
		vec3 c = sc.xyz / sc.w;
		if ( c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0 && c.z < 1.0 ) sh = textureLod( uShadowMap, vec3( c.xy, c.z - 0.0015 ), 0.0 );
	}
	// Dust is translucent: shadowed puffs still pass some light.
	vKey = uKeyCol * mix( 0.25, 1.0, sh );
	vec3 hz = vec3( 0.0 );
	for ( int i = 4; i < 20; i ++ ) hz += argusFog[ i ].rgb;
	hz /= 16.0;
	vec3 sky = argusFog[ 0 ].w > 0.5 ? mix( hz, argusFog[ 20 ].rgb, 0.45 ) : fogColor * 0.5;
	vec3 bounce = uKeyCol * max( uKeyDir.y, 0.0 ) * 0.06;
	// Low dust sits in the shade of the cloud above it and of the street canyon.
	float hag = pC.y - groundAt( pC.xz );
	float low = smoothstep( 0.0, 55.0, hag );
	vAmb = ( sky + bounce ) * mix( 0.55, 1.0, low );
	vKey *= mix( 0.65, 1.0, low );
	vec3 fl = vec3( 0.0 );
	for ( int i = 0; i < ${MAX_FIRE_LIGHTS_GLSL}; i ++ ) {
		vec3 d = uFireP[ i ].xyz - pC;
		// Fire light reaches the lower plume; the falloff is softened by the puff's own size.
		// (Softened falloff: a burning block lights its own column well above the flames.)
		fl += uFireP[ i ].w / ( dot( d, d ) * 0.3 + pSize * pSize * 0.3 + 600.0 ) * vec3( 1.0, 0.42, 0.13 );
	}
	vFire = fl * 0.3;
	// Incandescent base of a smoke plume: a faint ember tint in the first seconds only (the flames themselves
	// and the fire-lit undersides carry the glow; strong per-puff emission reads as orange balls).
	vEmit = vec3( 1.0, 0.3, 0.06 ) * aX.x * 0.12 * exp( - pAge / 1.2 ) * mix( 0.03, 1.0, uNight * uNight );

	vec3 camR = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
	vec3 camU = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
	vQuv = position.xy * 2.0;
	vec3 transformed = pC + ( camR * position.x + camU * position.y ) * pSize;
	vec4 wp = modelMatrix * vec4( transformed, 1.0 );
	vPW = wp.xyz;
	vec4 mvPosition = viewMatrix * wp;
	gl_Position = projectionMatrix * mvPosition;
	vKeyView = normalize( ( viewMatrix * vec4( uKeyDir, 0.0 ) ).xyz );
	#include <fog_vertex>
	if ( vAlpha < 0.003 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uAtlas;
varying vec2 vQuv;
varying float vAlpha;
varying vec3 vCol;
varying vec3 vKey;
varying vec3 vAmb;
varying vec3 vEmit;
varying vec3 vFire;
varying vec3 vPW;
varying vec3 vKeyView;
varying float vSize;
varying float vRot;
varying vec3 vFlip;
${HEIGHT_GLSL}
${CITY_FIELD_GLSL}
vec2 cellUv( vec2 q, float seq, float frame ) {
	return ( clamp( q * 0.5 + 0.5, 0.0, 1.0 ) * 0.97 + 0.015 + vec2( frame, seq ) ) * 0.25;
}
void main() {
	float c = cos( vRot );
	float s = sin( vRot );
	vec2 q = mat2( c, -s, s, c ) * vQuv;
	vec4 t0 = texture2D( uAtlas, cellUv( q, vFlip.x, vFlip.y ) );
	vec4 t1 = texture2D( uAtlas, cellUv( q, vFlip.x, min( vFlip.y + 1.0, 3.0 ) ) );
	vec4 tx = mix( t0, t1, vFlip.z );
	float dens = tx.r;
	float a = dens * vAlpha;
	// Soft contact with the ground and with buildings.
	float gh = vPW.y - groundAt( vPW.xz );
	a *= smoothstep( 0.0, max( vSize * 0.28, 0.6 ), gh );
	a *= smoothstep( 0.0, clamp( vSize * 0.18, 1.0, 7.0 ), cityClearance( vPW ) );
	if ( a < 0.004 ) discard;
	// Relief normal (view space): rotated back into the sprite frame, on a pseudo-sphere.
	vec2 rel = ( tx.gb * 2.0 - 1.0 );
	rel = mat2( c, s, -s, c ) * rel;
	float r2 = dot( vQuv, vQuv );
	vec3 n = normalize( vec3( vQuv * 0.7 + rel * 1.1, sqrt( max( 1.0 - min( r2, 1.0 ) * 0.6, 0.05 ) ) ) );
	float ndl = dot( n, vKeyView );
	float wrap = pow( clamp( ndl * 0.5 + 0.5, 0.0, 1.0 ), 1.4 );
	// Self-shadowing: thick parts facing away from the light go darker.
	float selfSh = mix( 1.0, 0.45 + 0.55 * wrap, smoothstep( 0.2, 0.9, dens ) );
	// Forward scattering: thin edges glow when looking toward the light.
	float fwd = pow( clamp( - vKeyView.z, 0.0, 1.0 ), 6.0 ) * ( 1.15 - dens );
	vec3 nW = transpose( mat3( viewMatrix ) ) * n;
	float under = clamp( - nW.y * 0.8 + 0.3, 0.0, 1.0 );
	vec3 col = vCol * ( vKey * ( wrap * selfSh + fwd * 0.8 ) * RECIPROCAL_PI + vAmb * ( 0.72 + 0.28 * nW.y ) )
		+ vFire * under * ( 0.2 + 0.8 * dens )
		+ vEmit * dens * dens * dens;
	gl_FragColor = vec4( col, a );
	#include <fog_fragment>
}
`;

/** A cleared 1×1 comparison depth texture (depth = 1 → fully lit) for when the key light has no shadow map. */
let fallbackShadow: THREE.DepthTexture | null = null;
function getFallbackShadow(renderer: THREE.WebGLRenderer): THREE.DepthTexture {
  if (fallbackShadow) return fallbackShadow;
  const dt = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  dt.format = THREE.DepthFormat;
  dt.compareFunction = THREE.LessEqualCompare;
  dt.minFilter = dt.magFilter = THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthTexture: dt, depthBuffer: true });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, false);
  renderer.setRenderTarget(prev);
  fallbackShadow = dt;
  return dt;
}

export interface FieldTextures {
  height: HeightTexture;
  city: { tex: THREE.Texture; rect: THREE.Vector4 };
}

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.InstancedBufferGeometry;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(name: string, atlas: THREE.Texture, fields: FieldTextures) {
    const fires: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_FIRE_LIGHTS_GLSL; i++) fires.push(new THREE.Vector4(0, -1e5, 0, 0));
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(this.uniforms, {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3(3, 0, 0.8) },
      uAtlas: { value: atlas },
      uHeightTex: { value: fields.height.tex },
      uHeightRect: { value: fields.height.rect },
      uCityTex: { value: fields.city.tex },
      uCityRect: { value: fields.city.rect },
      uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyCol: { value: new THREE.Color(1, 1, 1) },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowOn: { value: 0 },
      uFireP: { value: fires },
      uNight: { value: 0 },
      uPxScale: { value: 900 },
      uMaxPx: { value: 400 },
    });
    // UniformsUtils.merge clones; keep the shared live fog array (engine updates it in place).
    const fogU = (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).argusFog;
    this.uniforms.argusFog = fogU ?? { value: new Float32Array(FOG_SLOTS * 4) };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.name = 'quakeParticles';
    this.geometry = new THREE.InstancedBufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  setParticles(list: ParticleSpec[]): void {
    this.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    g.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const n = list.length;
    const P0 = new Float32Array(n * 4);
    const V0 = new Float32Array(n * 4);
    const T = new Float32Array(n * 4);
    const S = new Float32Array(n * 4);
    const C = new Float32Array(n * 4);
    const X = new Float32Array(n * 4);
    const E = new Float32Array(n * 2);
    list.forEach((p, i) => {
      E[i * 2] = p.phase ?? 0;
      E[i * 2 + 1] = p.big ?? 0.5;
      P0.set([p.x, p.y, p.z, p.expand ?? p.life * 0.22], i * 4);
      V0.set([p.vx, p.vy, p.vz, p.drag], i * 4);
      T.set([p.t0, p.life, p.period, p.rise], i * 4);
      S.set([p.size0, p.size1, p.rot, p.spin], i * 4);
      C.set([p.r, p.g, p.b, p.alpha], i * 4);
      X.set([p.glow, p.wind, p.turb, p.grow], i * 4);
    });
    g.setAttribute('aP0', new THREE.InstancedBufferAttribute(P0, 4));
    g.setAttribute('aV0', new THREE.InstancedBufferAttribute(V0, 4));
    g.setAttribute('aT', new THREE.InstancedBufferAttribute(T, 4));
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(S, 4));
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(C, 4));
    g.setAttribute('aX', new THREE.InstancedBufferAttribute(X, 4));
    g.setAttribute('aE', new THREE.InstancedBufferAttribute(E, 2));
    g.instanceCount = n;
    this.geometry = g;
    this.mesh.geometry = g;
    this.mesh.visible = n > 0;
  }

  /** Per-frame: time, key light (sun or moon) incl. its shadow map, the fire light pool and the viewport scale. */
  update(
    t: number,
    key: THREE.DirectionalLight,
    fireLights: readonly THREE.PointLight[],
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    viewportH: number,
    night = 0,
  ): void {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uNight.value = night;
    u.uPxScale.value = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uMaxPx.value = viewportH * 0.42;
    const dir = u.uKeyDir.value as THREE.Vector3;
    dir.copy(key.position).sub(key.target.position).normalize();
    (u.uKeyCol.value as THREE.Color).copy(key.color).multiplyScalar(key.intensity);
    const sm = key.castShadow ? (key.shadow.map?.depthTexture ?? null) : null;
    const usable = !!sm && (sm as THREE.DepthTexture).compareFunction != null;
    u.uShadowMap.value = usable ? sm : getFallbackShadow(renderer);
    u.uShadowOn.value = usable ? 1 : 0;
    if (usable) (u.uShadowMatrix.value as THREE.Matrix4).copy(key.shadow.matrix);
    const fp = u.uFireP.value as THREE.Vector4[];
    for (let i = 0; i < fp.length; i++) {
      const l = fireLights[i];
      if (l && l.intensity > 0) fp[i].set(l.position.x, l.position.y, l.position.z, l.intensity);
      else fp[i].set(0, -1e5, 0, 0);
    }
  }

  clear(): void {
    this.setParticles([]);
    this.mesh.visible = false;
  }
}

// ───────────────────────────── Flipbook atlas ─────────────────────────────

/**
 * 4×4 atlas: row = puff shape (4 variants), column = frame (billowing evolution).
 * R = density, G/B = relief normal (x, y) of the smoothed density, 0.5-centred.
 */
export function makePuffAtlas(cell = 160): THREE.Texture {
  const N = cell * 4;
  const data = new Uint8Array(N * N * 4);
  const rnd = mulberry32(1906);
  const L = 64;
  const lat = new Float32Array(L * L);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const at = (a: number, b: number) => lat[(((b % L) + L) % L) * L + (((a % L) + L) % L)];
    return (at(xi, yi) * (1 - ux) + at(xi + 1, yi) * ux) * (1 - uy) + (at(xi, yi + 1) * (1 - ux) + at(xi + 1, yi + 1) * ux) * uy;
  };
  const dens = new Float32Array(cell * cell);
  const soft = new Float32Array(cell * cell);
  for (let seq = 0; seq < 4; seq++) {
    // Blobs: a main body plus 4–6 lobes (cauliflower outline), fixed per shape.
    const blobs: [number, number, number][] = [[0, 0.02, 0.3]];
    const nb = 4 + Math.floor(rnd() * 3);
    for (let b = 0; b < nb; b++) {
      const a = (b / nb) * Math.PI * 2 + rnd() * 0.8;
      const d = 0.12 + rnd() * 0.12;
      blobs.push([Math.cos(a) * d, Math.sin(a) * d * 0.9 - 0.02, 0.13 + rnd() * 0.09]);
    }
    for (let fr = 0; fr < 4; fr++) {
      const ev = fr / 3; // 0..1 evolution: lobes swell and drift outward, the noise churns
      const off = seq * 23.7 + fr * 0.55;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell - 0.5;
          const w = (y + 0.5) / cell - 0.5;
          let f = 0;
          for (const [bx, by, br] of blobs) {
            const sx = bx * (1 + 0.25 * ev);
            const sy = by * (1 + 0.25 * ev) + 0.03 * ev;
            const rr = br * (1 + 0.12 * ev);
            const d2 = ((u - sx) ** 2 + (w - sy) ** 2) / (rr * rr);
            f += Math.exp(-d2 * 1.6);
          }
          // Billow detail: ridged fbm (cauliflower) + a smooth base.
          let n = 0;
          let a = 0.5;
          let fq = 4.0;
          for (let o = 0; o < 5; o++) {
            n += a * (1 - Math.abs(vn(u * fq + off, w * fq - off * 0.7) * 2 - 1));
            fq *= 2.07;
            a *= 0.5;
          }
          n /= 0.97;
          const lowN = vn(u * 3 + off * 1.3, w * 3 - off);
          const r = Math.sqrt(u * u + w * w) * 2;
          const edge = 1 - smooth(0.78, 0.98, r);
          let dd = (Math.min(f, 1.6) * (0.4 + 0.85 * n) - 0.32 - 0.1 * ev) * 1.5;
          dd = Math.max(0, Math.min(1, dd)) * edge;
          dens[y * cell + x] = dd;
          soft[y * cell + x] = (Math.min(f, 1.5) * 0.6 + lowN * 0.25 + n * 0.25) * edge;
        }
      // Relief normals from the smoothed field.
      const ox = fr * cell;
      const oy = seq * cell;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const at = (i: number, j: number) => soft[Math.min(cell - 1, Math.max(0, j)) * cell + Math.min(cell - 1, Math.max(0, i))];
          const gx = (at(x + 2, y) - at(x - 2, y)) * (cell / 4) * 0.08;
          const gy = (at(x, y + 2) - at(x, y - 2)) * (cell / 4) * 0.08;
          const l = Math.hypot(gx, gy, 1);
          const k = ((oy + y) * N + ox + x) * 4;
          data[k] = Math.round(Math.pow(dens[y * cell + x], 1.1) * 255);
          // Rows run bottom-up in UV space, i.e. +y in the sprite: n = (−∂h/∂x, −∂h/∂y, 1).
          data[k + 1] = Math.round((0.5 - (0.5 * gx) / l) * 255);
          data[k + 2] = Math.round((0.5 - (0.5 * gy) / l) * 255);
          data[k + 3] = 255;
        }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
