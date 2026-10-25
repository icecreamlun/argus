/**
 * ShakeMap overlay: per-building tint with the official USGS ShakeMap intensity palette plus a translucent
 * MMI field draped on the ground (sampled from model.mmiAt on a 40 m grid) with smooth colour bands and thin
 * anti-aliased contour lines at every half intensity unit (whole units stronger).
 */
import * as THREE from 'three';
import type { CityData, QuakeModel, QuakeResult } from '../../contracts';
import type { Rect } from './drape';

/** USGS ShakeMap MMI colour palette (sRGB 0–255), interpolated between whole intensities. */
export const MMI_PALETTE: [number, [number, number, number]][] = [
  [1, [255, 255, 255]],
  [2, [191, 204, 255]],
  [3, [160, 230, 255]],
  [4, [128, 255, 255]],
  [5, [122, 255, 147]],
  [6, [255, 255, 0]],
  [7, [255, 200, 0]],
  [8, [255, 145, 0]],
  [9, [255, 0, 0]],
  [10, [200, 0, 0]],
  [11, [128, 0, 0]],
];

/** MMI → sRGB 0..1. */
export function mmiColorSRGB(mmi: number): [number, number, number] {
  const m = Math.max(1, Math.min(11, mmi));
  let k = 0;
  while (k < MMI_PALETTE.length - 2 && MMI_PALETTE[k + 1][0] < m) k++;
  const [m0, c0] = MMI_PALETTE[k];
  const [m1, c1] = MMI_PALETTE[k + 1];
  const t = Math.max(0, Math.min(1, (m - m0) / (m1 - m0)));
  return [0, 1, 2].map((i) => (c0[i] + (c1[i] - c0[i]) * t) / 255) as [number, number, number];
}

/** MMI → linear RGB 0..1 (three.js working space). */
export function mmiColorLinear(mmi: number): [number, number, number] {
  const c = new THREE.Color().setRGB(...mmiColorSRGB(mmi), THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

const GW = 160;
const GH = 130;

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
varying float vLand;
void main() {
	vUv = uv;
	// Drape vertices sit 0.45 m above the water, ≥ 1.3 m above land.
	vLand = step( 1.0, position.y );
	vec4 w = modelMatrix * vec4( position, 1.0 );
	vW = w.xyz;
	gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMmi;
uniform vec4 uMap;
uniform vec3 uPal[ 11 ];
uniform float uOpacity;
uniform float uFadeR;
uniform float uBright;
varying vec2 vUv;
varying vec3 vW;
varying float vLand;
vec3 palette( float m ) {
	m = clamp( m, 1.0, 11.0 ) - 1.0;
	int i = int( floor( m ) );
	float f = fract( m );
	vec3 c0 = uPal[ 0 ];
	vec3 c1 = uPal[ 1 ];
	for ( int k = 0; k < 10; k ++ ) {
		if ( k == i ) { c0 = uPal[ k ]; c1 = uPal[ k + 1 ]; }
	}
	if ( i >= 10 ) { c0 = uPal[ 10 ]; c1 = uPal[ 10 ]; }
	return mix( c0, c1, f );
}
void main() {
	float m = texture2D( uMmi, vUv * uMap.xy + uMap.zw ).r;
	vec3 col = palette( m );
	// Contours every 0.5 MMI; whole units bolder.
	float h = m * 2.0;
	float w = fwidth( h );
	float d = abs( fract( h + 0.5 ) - 0.5 );
	float line = 1.0 - smoothstep( 0.0, w * 1.3, d );
	float whole = 1.0 - step( 0.25, abs( fract( m + 0.5 ) - 0.5 ) );
	float edge = 1.0 - smoothstep( uFadeR * 0.75, uFadeR, length( vW.xz ) );
	vec3 c = mix( col * uBright, vec3( 0.05, 0.04, 0.04 ), line * ( whole > 0.5 ? 0.75 : 0.4 ) );
	// Keep the eye on the city: the field over open water is only a faint wash.
	float a = ( uOpacity + line * 0.35 ) * edge * mix( 0.22, 1.0, vLand );
	gl_FragColor = vec4( c, a );
}
`;

export class ShakeMapField {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private tex: THREE.DataTexture | null = null;

  constructor(drape: THREE.BufferGeometry, private readonly rect: Rect) {
    const pal = MMI_PALETTE.map(([m]) => new THREE.Color(...mmiColorLinear(m)));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMmi: { value: null },
        uMap: { value: new THREE.Vector4((GW - 1) / GW, (GH - 1) / GH, 0.5 / GW, 0.5 / GH) },
        uPal: { value: pal },
        uOpacity: { value: 0.42 },
        uFadeR: { value: 2900 },
        uBright: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    this.mesh = new THREE.Mesh(drape, this.mat);
    this.mesh.name = 'shakeMapField';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** Sample the model's MMI field for this result's scenario. */
  load(model: QuakeModel, city: CityData, result: QuakeResult): void {
    const { rect } = this;
    const data = new Uint16Array(GW * GH);
    const dx = (rect.maxX - rect.minX) / (GW - 1);
    const dz = (rect.maxZ - rect.minZ) / (GH - 1);
    for (let j = 0; j < GH; j++)
      for (let i = 0; i < GW; i++) {
        let m = model.mmiAt(city, result.scenario, rect.minX + i * dx, rect.minZ + j * dz);
        if (!Number.isFinite(m)) m = 1;
        data[j * GW + i] = THREE.DataUtils.toHalfFloat(m);
      }
    this.tex?.dispose();
    const tex = new THREE.DataTexture(data, GW, GH, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.tex = tex;
    this.mat.uniforms.uMmi.value = tex;
  }

  /** Overlay brightness: the field is unlit, so dim it at night to sit with the scene. */
  setBrightness(nightFactor: number): void {
    this.mat.uniforms.uBright.value = THREE.MathUtils.lerp(1.0, 0.35, nightFactor);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v && !!this.tex;
  }

  clear(): void {
    this.mesh.visible = false;
    this.tex?.dispose();
    this.tex = null;
    this.mat.uniforms.uMmi.value = null;
  }
}
