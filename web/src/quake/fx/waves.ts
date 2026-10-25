/**
 * Seismic wave fronts draped on the terrain.
 *
 * The arrival-time field t_P(x,z), t_S(x,z) is evaluated with the quake model's own timing functions
 * (finite-fault rupture front + P/S travel, src/quake/model/timing.ts) on a coarse grid and stored in a
 * half-float texture together with |∇t| (slowness, s/km). The fragment shader converts "seconds since
 * arrival" to "metres behind the front" with that slowness, so the band widths are metric while the
 * fronts sweep across the city at the true apparent velocity (≈ 3.5–8 km/s → the S front crosses
 * downtown in well under a second at 1× speed). Fronts are iso-lines of the real field, so they are
 * gently curved arcs centred on the hypocentre / nearest point of the rupture.
 *
 *   P: a crisp cold white-blue line with a faint shimmer behind it.
 *   S: a hot orange-red band with trailing ground-roll rings, fading over the following seconds.
 */
import * as THREE from 'three';
import type { QuakeResult } from '../../contracts';
import { unproject } from '../../geo';
import { sourceContext, siteTiming, siteKm } from '../model/timing';
import type { Heightfield } from '../../contracts';
import type { Rect } from './drape';
import { FrontCurtain } from './frontCurtain';
import { NOISE_GLSL } from './glsl';

const GW = 128;
const GH = 104;

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
varying float vLand;
void main() {
	vUv = uv;
	vLand = step( 1.0, position.y );
	vec4 w = modelMatrix * vec4( position, 1.0 );
	vW = w.xyz;
	gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform sampler2D uArr;
uniform vec2 uT0;
uniform float uGain;
uniform vec3 uPCol;
uniform vec3 uSCol;
uniform float uFadeR;
uniform vec4 uArrMap;
uniform float uStrength;
varying vec2 vUv;
varying vec3 vW;
varying float vLand;
${NOISE_GLSL}
void main() {
	// Texel-centre remap: grid sample i sits at uv = i / (N - 1).
	vec4 a = texture2D( uArr, vUv * uArrMap.xy + uArrMap.zw );
	float tP = a.r + uT0.x;
	float tS = a.g + uT0.y;
	// slowness in s/m (texture stores s/km)
	float gP = max( a.b, 0.05 ) * 1e-3;
	float gS = max( a.a, 0.05 ) * 1e-3;
	float sinceP = uTime - tP;
	float sinceS = uTime - tS;
	float mP = sinceP / gP;            // metres behind the P front (< 0: not reached yet)
	float mS = sinceS / gS;
	float n = vnoise( vW.xz * 0.02 + vec2( uTime * 0.5, 0.0 ) );
	float n2 = vnoise( vW.xz * 0.11 - vec2( 0.0, uTime * 1.7 ) );
	float grain = 0.75 + 0.35 * n + 0.2 * n2;

	// ── P wave: a crisp blue-white ring (~20 m) with a faint afterglow ──
	float p = exp( - pow( ( mP - 5.0 ) / 9.0, 2.0 ) ) * 1.6;
	p += mP < 0.0 ? exp( mP / 6.0 ) * 0.35 : exp( - mP / 140.0 ) * 0.12;
	p *= exp( - max( sinceP, 0.0 ) / 3.0 );

	// ── S wave: a hot leading edge (~30 m) and thin ground-roll rings behind it — no broad tint ──
	float s = exp( - pow( ( mS - 8.0 ) / 13.0, 2.0 ) ) * 1.8;
	s += mS < 0.0 ? exp( mS / 8.0 ) * 0.45 : exp( - mS / 160.0 ) * 0.1;
	if ( mS > 0.0 ) {
		float ph = ( mS + ( n - 0.5 ) * 40.0 ) / 110.0;
		s += pow( 0.5 + 0.5 * cos( ph * 6.2832 ), 12.0 ) * exp( - mS / 380.0 ) * 0.5 * mix( 0.5, 1.0, vLand );
	}
	s *= exp( - max( sinceS, 0.0 ) / 5.0 );

	float r = length( vW.xz );
	float edge = ( 1.0 - smoothstep( uFadeR * 0.6, uFadeR, r ) ) * mix( 0.5, 1.0, vLand );
	vec3 col = ( uPCol * p * mix( 0.8, 1.0, uStrength ) + uSCol * s * uStrength ) * grain * edge * uGain;
	if ( max( col.r, max( col.g, col.b ) ) < 1e-4 ) discard;
	gl_FragColor = vec4( col, 1.0 );
}
`;

export class WaveFronts {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture | null = null;
  private window: [number, number] = [0, 0];
  private tp: Float32Array | null = null;
  private ts: Float32Array | null = null;
  private rangeP: [number, number] = [0, 0];
  private rangeS: [number, number] = [0, 0];
  private readonly curtainP: FrontCurtain;
  private readonly curtainS: FrontCurtain;

  constructor(drape: THREE.BufferGeometry, private readonly rect: Rect, terrain: Heightfield) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: -1 },
        uArr: { value: null },
        uT0: { value: new THREE.Vector2() },
        uGain: { value: 1 },
        uPCol: { value: new THREE.Color(0.55, 0.78, 1.0).multiplyScalar(2.4) },
        uSCol: { value: new THREE.Color(1.0, 0.46, 0.12).multiplyScalar(2.8) },
        uFadeR: { value: 2500 },
        uArrMap: { value: new THREE.Vector4((GW - 1) / GW, (GH - 1) / GH, 0.5 / GW, 0.5 / GH) },
        uStrength: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(drape, this.mat);
    this.mesh.name = 'quakeWaveFronts';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.curtainP = new FrontCurtain(new THREE.Color(0.5, 0.75, 1.0).multiplyScalar(0.62), 70, terrain);
    this.curtainS = new FrontCurtain(new THREE.Color(1.0, 0.34, 0.07).multiplyScalar(1.1), 120, terrain);
    this.curtainP.setFade(2200);
    this.curtainS.setFade(2200);
    this.curtainP.mesh.name = 'pWaveCurtain';
    this.curtainS.mesh.name = 'sWaveCurtain';
    this.group.name = 'quakeWaves';
    this.group.add(this.mesh, this.curtainP.mesh, this.curtainS.mesh);
  }

  load(result: QuakeResult): void {
    const src = sourceContext(result.scenario);
    const { rect } = this;
    const tp = new Float32Array(GW * GH);
    const ts = new Float32Array(GW * GH);
    const dx = (rect.maxX - rect.minX) / (GW - 1);
    const dz = (rect.maxZ - rect.minZ) / (GH - 1);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const [lat, lon] = unproject(rect.minX + i * dx, rect.minZ + j * dz);
        const [e, n] = siteKm(lat, lon);
        const st = siteTiming(src, e, n);
        tp[j * GW + i] = st.pArrivalS;
        ts[j * GW + i] = st.sArrivalS;
      }
    let p0 = Infinity;
    let s0 = Infinity;
    let p1 = -Infinity;
    let s1 = -Infinity;
    for (let k = 0; k < tp.length; k++) {
      p0 = Math.min(p0, tp[k]);
      s0 = Math.min(s0, ts[k]);
      p1 = Math.max(p1, tp[k]);
      s1 = Math.max(s1, ts[k]);
    }
    const data = new Uint16Array(GW * GH * 4);
    const half = THREE.DataUtils.toHalfFloat;
    const grad = (f: Float32Array, i: number, j: number) => {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(GW - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(GH - 1, j + 1);
      const gx = (f[j * GW + i1] - f[j * GW + i0]) / ((i1 - i0) * dx);
      const gz = (f[j1 * GW + i] - f[j0 * GW + i]) / ((j1 - j0) * dz);
      return Math.hypot(gx, gz) * 1000; // s/km
    };
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        const k = j * GW + i;
        data[k * 4] = half(tp[k] - p0);
        data[k * 4 + 1] = half(ts[k] - s0);
        data[k * 4 + 2] = half(grad(tp, i, j));
        data[k * 4 + 3] = half(grad(ts, i, j));
      }
    this.tex?.dispose();
    const tex = new THREE.DataTexture(data, GW, GH, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.tex = tex;
    const u = this.mat.uniforms;
    u.uArr.value = tex;
    // Band brightness follows how hard the city shakes (median MMI 6 → dim, 8.5+ → full).
    const mm = result.shaking.map((s) => s.mmi).sort((a, b) => a - b)[Math.floor(result.shaking.length / 2)] ?? 7;
    const k = THREE.MathUtils.smoothstep(mm, 5.5, 8.5);
    u.uStrength.value = 0.45 + 0.55 * k;
    this.curtainS.setGain(0.5 + 0.5 * k);
    (u.uT0.value as THREE.Vector2).set(p0, s0);
    // Visible from the first P arrival in the drape until the S glow has faded everywhere.
    this.window = [p0 - 0.5, s1 + 30];
    this.tp = tp;
    this.ts = ts;
    this.rangeP = [p0, p1];
    this.rangeS = [s0, s1];
  }

  update(t: number): void {
    const vis = !!this.tex && t >= this.window[0] && t <= this.window[1];
    this.mesh.visible = vis;
    this.mat.uniforms.uTime.value = t;
    if (!this.tp || !this.ts) return;
    const inP = t > this.rangeP[0] && t < this.rangeP[1];
    const inS = t > this.rangeS[0] && t < this.rangeS[1];
    if (inP) this.curtainP.update(this.tp, GW, GH, this.rect, t, 1);
    else this.curtainP.hide();
    if (inS) this.curtainS.update(this.ts, GW, GH, this.rect, t, 1);
    else this.curtainS.hide();
  }

  clear(): void {
    this.mesh.visible = false;
    this.curtainP.hide();
    this.curtainS.hide();
    this.tp = this.ts = null;
    this.tex?.dispose();
    this.tex = null;
    this.mat.uniforms.uArr.value = null;
  }
}
