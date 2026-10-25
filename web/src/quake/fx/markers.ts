/**
 * Damage-overlay markers: constant-screen-size pins above collapsed buildings (red diamond with a white rim)
 * and road-closure marks over blocked carriageways (red = impassable, amber = partially blocked). Each marker
 * pops in at the moment its cause fails, so the overlay builds up as the quake unfolds.
 */
import * as THREE from 'three';

export interface MarkerSpec {
  x: number;
  y: number;
  z: number;
  t0: number;
  /** 0 = collapse pin, 1 = impassable road, 2 = partially blocked road. */
  kind: number;
}

const VERT = /* glsl */ `
attribute vec4 aM;
attribute float aKind;
uniform float uTime;
uniform vec2 uPx;
varying vec2 vQ;
varying float vKind;
varying float vPop;
void main() {
	float age = uTime - aM.w;
	float pop = smoothstep( 0.0, 0.25, age );
	float overshoot = 1.0 + 0.35 * sin( clamp( age / 0.5, 0.0, 1.0 ) * 3.1416 );
	float px = aKind < 0.5 ? 34.0 : 15.0;
	vec4 clip = projectionMatrix * viewMatrix * vec4( aM.xyz, 1.0 );
	clip.xy += position.xy * px * pop * overshoot * uPx * clip.w;
	// Pull slightly toward the camera so pins aren't swallowed by the roof they float above.
	clip.z -= 0.002 * clip.w;
	gl_Position = clip;
	if ( age < 0.0 ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
	vQ = position.xy * 2.0;
	vKind = aKind;
	vPop = pop;
}
`;

const FRAG = /* glsl */ `
varying vec2 vQ;
varying float vKind;
varying float vPop;
void main() {
	float aa = fwidth( vQ.x ) * 1.2;
	vec3 col;
	float a;
	if ( vKind < 0.5 ) {
		// Diamond pin with a white rim and a dark centre dot.
		float d = abs( vQ.x ) + abs( vQ.y );
		float body = 1.0 - smoothstep( 0.78 - aa, 0.78 + aa, d );
		float rim = 1.0 - smoothstep( 0.98 - aa, 0.98 + aa, d );
		float cdot = 1.0 - smoothstep( 0.2 - aa, 0.2 + aa, length( vQ ) );
		col = mix( vec3( 1.0 ), vec3( 0.86, 0.04, 0.03 ), body );
		col = mix( col, vec3( 0.12, 0.0, 0.0 ), cdot );
		a = rim;
	} else {
		// Road-closed disc: coloured disc, white rim, white bar.
		float r = length( vQ );
		float disc = 1.0 - smoothstep( 0.72 - aa, 0.72 + aa, r );
		float rim = 1.0 - smoothstep( 0.95 - aa, 0.95 + aa, r );
		float bar = ( 1.0 - smoothstep( 0.16 - aa, 0.16 + aa, abs( vQ.y ) ) ) * ( 1.0 - smoothstep( 0.48 - aa, 0.48 + aa, abs( vQ.x ) ) );
		vec3 base = vKind < 1.5 ? vec3( 0.86, 0.05, 0.04 ) : vec3( 1.0, 0.55, 0.0 );
		col = mix( vec3( 1.0 ), base, disc );
		col = mix( col, vec3( 1.0 ), bar );
		a = rim;
	}
	if ( a < 0.01 ) discard;
	gl_FragColor = vec4( col * 1.6, a * vPop );
}
`;

export interface ClosureSpec {
  x: number;
  y: number;
  z: number;
  t0: number;
  /** Unit direction of the road segment (x, z). */
  dx: number;
  dz: number;
  length: number;
  width: number;
  impassable: boolean;
}

const CLOSURE_VERT = /* glsl */ `
attribute vec4 aC;
attribute vec4 aD;
attribute float aImp;
uniform float uTime;
varying vec2 vL;
varying float vImp;
varying float vA;
varying vec2 vSize;
void main() {
	vec2 dir = aD.xy;
	vec2 nrm = vec2( - dir.y, dir.x );
	vec2 off = dir * position.x * aD.z + nrm * position.y * aD.w;
	vec3 p = vec3( aC.x + off.x, aC.y, aC.z + off.y );
	vL = vec2( position.x * aD.z, position.y * aD.w );
	vSize = aD.zw;
	vImp = aImp;
	vA = smoothstep( aC.w, aC.w + 0.6, uTime );
	gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
	if ( uTime < aC.w ) gl_Position = vec4( 0.0, 0.0, -2.0, 1.0 );
}
`;

const CLOSURE_FRAG = /* glsl */ `
varying vec2 vL;
varying float vImp;
varying float vA;
varying vec2 vSize;
void main() {
	// Diagonal hazard hatch with a solid border.
	float stripe = step( 0.5, fract( ( vL.x + vL.y ) / 1.6 ) );
	vec3 a = vImp > 0.5 ? vec3( 0.9, 0.05, 0.03 ) : vec3( 1.0, 0.55, 0.0 );
	vec3 b = vImp > 0.5 ? vec3( 1.0 ) : vec3( 0.08 );
	vec2 e = vSize * 0.5 - abs( vL );
	float border = 1.0 - step( 0.35, min( e.x, e.y ) );
	vec3 col = mix( mix( a, b, stripe * 0.85 ), a, border );
	gl_FragColor = vec4( col * 1.3, 0.9 * vA );
}
`;

/** Road closures drawn flat on the carriageway (hazard-hatched strips along the blocked segment). */
export class RoadClosures {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: CLOSURE_VERT,
      fragmentShader: CLOSURE_FRAG,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.mat);
    this.mesh.name = 'roadClosures';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
    this.mesh.visible = false;
  }
  set(list: ClosureSpec[]): void {
    this.mesh.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const c = new Float32Array(list.length * 4);
    const d = new Float32Array(list.length * 4);
    const k = new Float32Array(list.length);
    list.forEach((s, i) => {
      c.set([s.x, s.y, s.z, s.t0], i * 4);
      d.set([s.dx, s.dz, s.length, s.width], i * 4);
      k[i] = s.impassable ? 1 : 0;
    });
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(c, 4));
    g.setAttribute('aD', new THREE.InstancedBufferAttribute(d, 4));
    g.setAttribute('aImp', new THREE.InstancedBufferAttribute(k, 1));
    g.instanceCount = list.length;
    this.mesh.geometry = g;
  }
  update(t: number): void {
    this.mat.uniforms.uTime.value = t;
  }
  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }
}

export class DamageMarkers {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uPx: { value: new THREE.Vector2(1 / 800, 1 / 450) } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.mat);
    this.mesh.name = 'damageMarkers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  set(list: MarkerSpec[]): void {
    this.mesh.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new Float32Array(list.length * 4);
    const k = new Float32Array(list.length);
    list.forEach((s, i) => {
      m.set([s.x, s.y, s.z, s.t0], i * 4);
      k[i] = s.kind;
    });
    g.setAttribute('aM', new THREE.InstancedBufferAttribute(m, 4));
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(k, 1));
    g.instanceCount = list.length;
    this.mesh.geometry = g;
  }

  update(t: number, viewportW: number, viewportH: number): void {
    this.mat.uniforms.uTime.value = t;
    (this.mat.uniforms.uPx.value as THREE.Vector2).set(2 / Math.max(1, viewportW), 2 / Math.max(1, viewportH));
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }
}
