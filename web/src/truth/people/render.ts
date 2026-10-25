/**
 * Instanced low-poly humans (one draw call + one shadow pass).
 *
 * Geometry is a ~1.72 m figure (legs, torso, head, two arms) drawn at ×1.4 scale: a true-size person is 4-7 px tall
 * from a helicopter at 150-200 m, which is unreadable both for the viewer and for the reconstruction model, so the
 * figures are deliberately exaggerated for legibility from the air (the truth positions are unaffected).
 * Per-instance attributes drive everything in the vertex shader:
 *   aAnim  = (appearS, waving 0/1, phase, milling 0/1)  → pop-in at appearS, right arm waving overhead, crowd sway
 *   aShirt / aPants = clothing colours (bright, varied — readable from the air)
 * Instances are sorted by appearS so update() only has to set mesh.count; not-yet-appeared persons cost nothing.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PersonTruth } from '../../contracts';
import { hash01 } from '../../quake/fx/rng';

/** Visual exaggeration of the figures (see header). */
export const PERSON_SCALE = 1.4;

const SHIRTS = [
  0xff3b30, 0xff9500, 0xffd60a, 0x34c759, 0x00c7be, 0x0a84ff, 0x5e5ce6, 0xbf5af2, 0xff2d55, 0xffffff, 0xff6b00, 0xe6ff00,
  0x1e90ff, 0xff4fa3,
];
const PANTS = [0x1c2a4a, 0x2b2b2b, 0x4a3b2a, 0x3a4a5c, 0x6b6b6b, 0x223355, 0x8a7a5a];
/** High-visibility colours for trapped persons (dust-covered rubble is grey). */
const HIVIS = [0xff5a00, 0xffe000, 0xff2a2a, 0x39ff14, 0xff00aa];

function box(w: number, h: number, d: number, x: number, y: number, part: number, arm: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, 0);
  const n = g.attributes.position.count;
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
  g.setAttribute('aArm', new THREE.Float32BufferAttribute(new Float32Array(n).fill(arm), 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.deleteAttribute('uv');
  return g;
}

/** Feet at y = 0, facing +Z. Right arm (x > 0) pivots at the shoulder (0.26, 1.40, 0). */
function humanGeometry(): THREE.BufferGeometry {
  const parts = [
    box(0.15, 0.84, 0.18, -0.095, 0.42, 1, 0), // left leg
    box(0.15, 0.84, 0.18, 0.095, 0.42, 1, 0), // right leg
    box(0.42, 0.6, 0.25, 0, 1.13, 0, 0), // torso
    box(0.21, 0.24, 0.22, 0, 1.6, 2, 0), // head
    box(0.1, 0.6, 0.12, -0.26, 1.11, 0, 0), // left arm
    box(0.1, 0.6, 0.12, 0.26, 1.11, 0, 1), // right arm (waves)
  ];
  const g = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return g;
}

const HEADER = /* glsl */ `
attribute float aPart;
attribute float aArm;
attribute vec4 aAnim;
attribute vec3 aShirt;
attribute vec3 aPants;
uniform float uSim;
uniform float uTime;
vec3 argusPose( vec3 p, bool isNormal ) {
	if ( aArm > 0.5 && aAnim.y > 0.5 ) {
		// Raised overhead and swinging (~1.1 Hz) about the shoulder, in the figure's x-y plane.
		float th = 2.55 + 0.5 * sin( uTime * 7.0 + aAnim.z );
		vec3 pivot = vec3( 0.26, 1.40, 0.0 );
		vec3 q = isNormal ? p : p - pivot;
		float c = cos( th ), s = sin( th );
		q.xy = vec2( q.x * c - q.y * s, q.x * s + q.y * c );
		p = isNormal ? q : q + pivot;
	}
	if ( !isNormal ) {
		float age = uSim - aAnim.x;
		float pop = smoothstep( 0.0, 0.6, age );
		p *= pop * ( 1.0 + 0.25 * sin( clamp( age / 0.6, 0.0, 1.0 ) * 3.1416 ) );
		if ( aAnim.w > 0.5 ) {
			// Crowd milling: slow wander of ~±0.6 m (figure space) around the standing spot.
			p.x += 0.6 * sin( uTime * 0.35 + aAnim.z );
			p.z += 0.6 * cos( uTime * 0.27 + aAnim.z * 1.3 );
		}
	}
	return p;
}
`;

function patchVertex(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }, uniforms: Record<string, THREE.IUniform>, color: boolean) {
  Object.assign(shader.uniforms, uniforms);
  let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${HEADER}`);
  vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = argusPose( vec3( position ), false );');
  if (color) {
    vs = vs.replace(
      '#include <beginnormal_vertex>',
      'vec3 objectNormal = argusPose( vec3( normal ), true );\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif',
    );
    vs = vs.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
	vec3 skin = mix( vec3( 0.92, 0.74, 0.6 ), vec3( 0.42, 0.28, 0.18 ), fract( aAnim.z * 3.71 ) );
	vColor.rgb = aPart < 0.5 ? aShirt : ( aPart < 1.5 ? aPants : skin );`,
    );
  }
  shader.vertexShader = vs;
}

export class PeopleMesh {
  readonly object: THREE.InstancedMesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly uniforms = { uSim: { value: 0 }, uTime: { value: 0 }, uGlow: { value: 0.22 } };
  private appear = new Float64Array(0);
  private capacity: number;

  constructor(capacity = 4000) {
    this.capacity = capacity;
    const geo = humanGeometry();
    this.geometry = geo;
    const u = this.uniforms;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      patchVertex(shader, u, true);
      shader.uniforms.uGlow = u.uGlow;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', 'uniform float uGlow;\n#include <common>')
        // Slight self-illumination so bright clothing still reads in building shadows and at dusk.
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uGlow;');
    };
    mat.customProgramCacheKey = () => 'argus-people-lambert-v1';

    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (shader) => patchVertex(shader, u, false);
    depth.customProgramCacheKey = () => 'argus-people-depth-v1';

    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.name = 'truthPeople';
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.object = mesh;

    geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
    geo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute('aPants', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
  }

  /** Instantiate the visible persons (hidden/buried ones are never drawn). */
  setPersons(all: PersonTruth[]): void {
    const vis = all.filter((p) => p.visible).sort((a, b) => a.appearS - b.appearS);
    const n = Math.min(vis.length, this.capacity);
    if (vis.length > this.capacity) console.warn(`[people] ${vis.length} visible persons > capacity ${this.capacity}; truncated`);
    const anim = this.geometry.getAttribute('aAnim') as THREE.InstancedBufferAttribute;
    const shirt = this.geometry.getAttribute('aShirt') as THREE.InstancedBufferAttribute;
    const pants = this.geometry.getAttribute('aPants') as THREE.InstancedBufferAttribute;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(PERSON_SCALE, PERSON_SCALE, PERSON_SCALE);
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    this.appear = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = vis[i];
      let hs = 0;
      for (let k = 0; k < p.id.length; k++) hs = (Math.imul(hs, 31) + p.id.charCodeAt(k)) | 0;
      const r0 = hash01(hs, 1);
      const r1 = hash01(hs, 2);
      const r2 = hash01(hs, 3);
      q.setFromAxisAngle(up, r0 * Math.PI * 2);
      pos.set(p.x, p.y, p.z);
      m.compose(pos, q, scl);
      this.object.setMatrixAt(i, m);
      this.appear[i] = p.appearS;
      anim.setXYZW(i, p.appearS, p.waving ? 1 : 0, r1 * Math.PI * 2, p.kind === 'crowd' ? 1 : 0);
      const palette = p.kind === 'trapped' ? HIVIS : SHIRTS;
      col.setHex(palette[Math.floor(r2 * palette.length) % palette.length]);
      shirt.setXYZ(i, col.r, col.g, col.b);
      col.setHex(PANTS[Math.floor(hash01(hs, 4) * PANTS.length) % PANTS.length]);
      pants.setXYZ(i, col.r, col.g, col.b);
    }
    this.object.instanceMatrix.needsUpdate = true;
    anim.needsUpdate = true;
    shirt.needsUpdate = true;
    pants.needsUpdate = true;
    this.object.count = 0;
  }

  /** Show persons with appearS <= simSeconds (they pop in over 0.6 s in the shader). */
  setSimTime(t: number): void {
    this.uniforms.uSim.value = t;
    const a = this.appear;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    this.object.count = lo;
  }

  setWallTime(t: number): void {
    this.uniforms.uTime.value = t;
  }

  clear(): void {
    this.appear = new Float64Array(0);
    this.object.count = 0;
  }
}
