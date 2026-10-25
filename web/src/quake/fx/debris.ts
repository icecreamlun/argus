/**
 * Debris rendering: instanced rubble chunks (rocks, slabs, beams/rebar), rubble mounds and falling glass.
 * All motion is evaluated in the vertex shader from per-instance launch/rest states (pure function of sim
 * time):
 *   flight (0 ≤ age < T): x,z linear from launch to rest; y ballistic y0 + v_y·a − ½ g a² with v_y chosen so
 *                         the chunk lands exactly at its rest point at a = T; tumbling about a random axis.
 *   rest  (age ≥ T):      at the rest point / orientation. Chunks with T = 0 are "pile" chunks that rise out
 *                         of the growing mound instead of flying.
 * Glass shards flutter down at terminal velocity with a spiralling drift, then lie glinting on the street.
 * Materials are patched MeshStandardMaterials → correct sun, IBL, shadows and fog.
 */
import * as THREE from 'three';
import { NOISE_GLSL, ROTATE_GLSL } from './glsl';
import { mulberry32 } from './rng';

export interface ChunkSpec {
  kind: 0 | 1 | 2; // rock, slab, stick
  x0: number;
  y0: number;
  z0: number;
  t0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Flight time (s); 0 = grows in place with the mound. */
  T: number;
  sx: number;
  sy: number;
  sz: number;
  ax: number;
  ay: number;
  az: number;
  angle: number;
  spin: number;
  r: number;
  g: number;
  b: number;
}

export interface ShardSpec {
  x0: number;
  y0: number;
  z0: number;
  t0: number;
  x1: number;
  y1: number;
  z1: number;
  T: number;
  size: number;
  seed: number;
}

export interface MoundData {
  positions: number[];
  ground: number[];
  colors: number[];
  grow: number[]; // t0, dur per vertex
  indices: number[];
}

const CHUNK_VERT_PARS = /* glsl */ `
attribute vec4 aStart;
attribute vec4 aRest;
attribute vec3 aScale;
attribute vec4 aRot;
attribute vec4 aCol;
uniform float uTime;
varying vec3 vChunkCol;
${ROTATE_GLSL}
`;

const CHUNK_STATE = /* glsl */ `
	float cAge = uTime - aStart.w;
	float cT = aRest.w;
	vec3 cPos = aRest.xyz;
	float cAng = aRot.w;
	float cVis = 1.0;
	if ( cAge < 0.0 ) {
		cVis = 0.0;
	} else if ( cT > 0.0 && cAge < cT ) {
		float u = cAge / cT;
		float vy = ( aRest.y - aStart.y + 4.905 * cT * cT ) / cT;
		cPos = vec3( mix( aStart.x, aRest.x, u ), aStart.y + vy * cAge - 4.905 * cAge * cAge, mix( aStart.z, aRest.z, u ) );
		cAng = aRot.w - aCol.w * ( cT - cAge );
	} else if ( cT > -0.5 && cT <= 0.0 ) {
		// Pile chunk: rises out of the growing mound.
		float gr = smoothstep( 0.0, 1.4, cAge );
		cPos.y -= ( 1.0 - gr ) * ( aScale.y * 1.6 + 0.6 );
	}
	// (cT < 0: static ruin piece, placed exactly.)
	vec3 cAxis = normalize( aRot.xyz );
	vChunkCol = aCol.rgb;
	vec3 objectNormal = rotAxis( normalize( normal / aScale ), cAxis, cAng );
`;

const CHUNK_BEGIN = /* glsl */ `
	vec3 transformed = cPos + rotAxis( position * aScale, cAxis, cAng ) * cVis;
`;

/** Colour pass: small pieces drop out beyond ~600 m (sub-pixel there; saves vertex work and shimmer). */
const CHUNK_LOD = /* glsl */ `
	{
		float cSz = max( aScale.x, max( aScale.y, aScale.z ) );
		vec3 cW = ( modelMatrix * vec4( cPos, 1.0 ) ).xyz;
		if ( cSz < 1.1 && distance( cW, cameraPosition ) > 420.0 + 260.0 * cSz ) transformed = vec3( 0.0, -5000.0, 0.0 );
	}
`;

const CHUNK_DEPTH_STATE = CHUNK_STATE.replace('vec3 objectNormal = rotAxis( normalize( normal / aScale ), cAxis, cAng );', '');

/** Jittered octahedron: an irregular, flat-shaded rubble chunk of radius ~1 (24 vertices — there are tens of thousands). */
function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(1, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const rnd = mulberry32(77);
  const map = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let s = map.get(key);
    if (s === undefined) map.set(key, (s = 0.72 + rnd() * 0.5));
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.8, pos.getZ(i) * s);
  }
  const ni = g.index ? g.toNonIndexed() : g;
  ni.computeVertexNormals();
  return ni;
}

function patchChunk(mat: THREE.Material, uniforms: Record<string, THREE.IUniform>, depth: boolean): void {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${CHUNK_VERT_PARS}`);
    if (depth) {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `${CHUNK_DEPTH_STATE}\n${CHUNK_BEGIN}`);
    } else {
      sh.vertexShader = sh.vertexShader
        .replace('#include <beginnormal_vertex>', CHUNK_STATE)
        .replace('#include <begin_vertex>', `${CHUNK_BEGIN}\n${CHUNK_LOD}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vChunkCol;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= vChunkCol;');
    }
  };
  mat.customProgramCacheKey = () => (depth ? 'argus-chunk-depth' : 'argus-chunk');
}

class ChunkMesh {
  readonly mesh: THREE.Mesh;
  private geom: THREE.InstancedBufferGeometry;
  constructor(
    private readonly base: THREE.BufferGeometry,
    mat: THREE.Material,
    depthMat: THREE.Material,
    castShadow: boolean,
  ) {
    this.geom = new THREE.InstancedBufferGeometry();
    this.mesh = new THREE.Mesh(this.geom, mat);
    this.mesh.customDepthMaterial = depthMat;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  set(list: ChunkSpec[]): void {
    this.geom.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.base.index;
    for (const [k, a] of Object.entries(this.base.attributes)) g.setAttribute(k, a);
    const n = list.length;
    const S = new Float32Array(n * 4);
    const R = new Float32Array(n * 4);
    const Sc = new Float32Array(n * 3);
    const Ro = new Float32Array(n * 4);
    const C = new Float32Array(n * 4);
    list.forEach((c, i) => {
      S.set([c.x0, c.y0, c.z0, c.t0], i * 4);
      R.set([c.x1, c.y1, c.z1, c.T], i * 4);
      Sc.set([c.sx, c.sy, c.sz], i * 3);
      Ro.set([c.ax, c.ay, c.az, c.angle], i * 4);
      C.set([c.r, c.g, c.b, c.spin], i * 4);
    });
    g.setAttribute('aStart', new THREE.InstancedBufferAttribute(S, 4));
    g.setAttribute('aRest', new THREE.InstancedBufferAttribute(R, 4));
    g.setAttribute('aScale', new THREE.InstancedBufferAttribute(Sc, 3));
    g.setAttribute('aRot', new THREE.InstancedBufferAttribute(Ro, 4));
    g.setAttribute('aCol', new THREE.InstancedBufferAttribute(C, 4));
    g.instanceCount = n;
    this.geom = g;
    this.mesh.geometry = g;
    this.mesh.visible = n > 0;
  }
}

// ── Glass shards ──────────────────────────────────────────────────────────

const SHARD_PARS = /* glsl */ `
attribute vec4 aStart;
attribute vec4 aRest;
attribute vec2 aShard;
uniform float uTime;
varying float vGlint;
${ROTATE_GLSL}
`;

const SHARD_STATE = /* glsl */ `
	float sAge = uTime - aStart.w;
	float sT = aRest.w;
	float seed = aShard.y;
	vec3 sPos = aRest.xyz;
	float sVis = sAge >= 0.0 ? 1.0 : 0.0;
	vec3 axis = normalize( vec3( sin( seed * 11.0 ), 0.6 + 0.4 * cos( seed * 7.0 ), cos( seed * 5.0 ) ) );
	float ang;
	if ( sAge < sT ) {
		float u = clamp( sAge / sT, 0.0, 1.0 );
		sPos = mix( aStart.xyz, aRest.xyz, u );
		float sp = ( 1.0 - u ) * 1.6;
		sPos.xz += sp * vec2( sin( sAge * 5.0 + seed * 9.0 ), cos( sAge * 4.3 + seed * 3.0 ) );
		ang = sAge * ( 6.0 + 5.0 * fract( seed * 3.7 ) );
	} else {
		// Lying on the street, nearly flat.
		axis = normalize( vec3( 1.0, 0.0, fract( seed * 5.3 ) - 0.5 ) );
		ang = 1.5708 + ( fract( seed * 9.1 ) - 0.5 ) * 0.5;
		sPos.y += 0.03;
	}
	vec3 objectNormal = rotAxis( normal, axis, ang );
	vGlint = fract( seed * 17.0 );
`;

const SHARD_BEGIN = /* glsl */ `
	vec3 transformed = sPos + rotAxis( position * aShard.x, axis, ang ) * sVis;
`;

// ── Mound ─────────────────────────────────────────────────────────────────

const MOUND_VERT_PARS = /* glsl */ `
attribute float aGround;
attribute vec2 aGrow;
uniform float uTime;
varying vec3 vMW;
`;

const MOUND_BEGIN = /* glsl */ `
	float mg = smoothstep( aGrow.x, aGrow.x + aGrow.y, uTime );
	vec3 transformed = position;
	transformed.y = aGround - 0.35 + ( position.y - aGround + 0.35 ) * mg;
	vMW = transformed;
`;

const MOUND_FRAG_PARS = /* glsl */ `
varying vec3 vMW;
${NOISE_GLSL}
`;

const MOUND_COLOR = /* glsl */ `
	diffuseColor.rgb *= vColor.rgb * 0.8;
	// Granular rubble: fine grit + small dark voids, gentle large-scale variation (no camouflage blotches).
	float mn = vnoise( vMW.xz * 0.6 );
	float g1 = vnoise( vMW.xz * 7.0 + vMW.y * 3.0 );
	float g2 = vnoise( vMW.xz * 17.0 - vMW.y * 5.0 );
	float voids = smoothstep( 0.18, 0.45, g1 * 0.6 + g2 * 0.4 );
	// Crevices between broken slabs: large dark gaps that give the heap depth from the air.
	float crev = 1.0 - smoothstep( 0.0, 0.06, abs( vnoise( vMW.xz * 0.45 + vMW.y * 0.3 ) - 0.5 ) );
	diffuseColor.rgb *= ( 0.8 + 0.32 * mn ) * mix( 0.3, 1.05, voids ) * ( 0.85 + 0.3 * g2 ) * ( 1.0 - 0.7 * crev );
`;

const MOUND_NORMAL = /* glsl */ `
	{
		// Lumpy rubble relief from world-space noise derivatives.
		float h0 = 0.6 * vnoise( vMW.xz * 2.2 ) + 0.35 * vnoise( vMW.xz * 7.0 + vMW.y * 3.0 ) + 0.15 * vnoise( vMW.xz * 17.0 - vMW.y * 5.0 );
		vec3 dpx = dFdx( - vViewPosition );
		vec3 dpy = dFdy( - vViewPosition );
		float dhx = dFdx( h0 );
		float dhy = dFdy( h0 );
		vec3 r1 = cross( dpy, normal );
		vec3 r2 = cross( normal, dpx );
		float det = dot( dpx, r1 );
		vec3 grad = sign( det ) * ( dhx * r1 + dhy * r2 );
		normal = normalize( abs( det ) * normal - grad * 1.1 );
	}
`;

export class DebrisRenderer {
  readonly group = new THREE.Group();
  private readonly uniforms = { uTime: { value: 0 } };
  private readonly rocks: ChunkMesh;
  private readonly slabs: ChunkMesh;
  private readonly sticks: ChunkMesh;
  private readonly shardMesh: THREE.Mesh;
  private shardGeom = new THREE.InstancedBufferGeometry();
  private readonly mound: THREE.Mesh;

  constructor() {
    this.group.name = 'quakeDebris';
    const u = this.uniforms;
    const mk = (rough: number) => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: rough, metalness: 0 });
      patchChunk(m, u, false);
      const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      patchChunk(d, u, true);
      return [m, d] as const;
    };
    const [mRock, dRock] = mk(0.95);
    const [mSlab, dSlab] = mk(0.9);
    const [mStick, dStick] = mk(0.75);
    // Only the big pieces cast shadows; small rocks get contact darkening from AO and receive shadows.
    this.rocks = new ChunkMesh(rockGeometry(), mRock, dRock, false);
    this.slabs = new ChunkMesh(new THREE.BoxGeometry(1, 1, 1), mSlab, dSlab, true);
    this.sticks = new ChunkMesh(new THREE.BoxGeometry(1, 1, 1), mStick, dStick, false);
    this.rocks.mesh.name = 'debrisRocks';
    this.slabs.mesh.name = 'debrisSlabs';
    this.sticks.mesh.name = 'debrisSticks';

    const shardMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.62, 0.7, 0.74),
      roughness: 0.06,
      metalness: 0.85,
      side: THREE.DoubleSide,
      envMapIntensity: 1.6,
    });
    shardMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${SHARD_PARS}`)
        .replace('#include <beginnormal_vertex>', SHARD_STATE)
        .replace('#include <begin_vertex>', SHARD_BEGIN);
    };
    shardMat.customProgramCacheKey = () => 'argus-shard';
    this.shardMesh = new THREE.Mesh(this.shardGeom, shardMat);
    this.shardMesh.name = 'debrisGlass';
    this.shardMesh.frustumCulled = false;
    this.shardMesh.visible = false;

    const moundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0, vertexColors: true });
    moundMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${MOUND_VERT_PARS}`)
        .replace('#include <begin_vertex>', MOUND_BEGIN);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${MOUND_FRAG_PARS}`)
        .replace('#include <color_fragment>', MOUND_COLOR)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${MOUND_NORMAL}`);
    };
    moundMat.customProgramCacheKey = () => 'argus-mound';
    const moundDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    moundDepth.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${MOUND_VERT_PARS}`)
        .replace('#include <begin_vertex>', MOUND_BEGIN);
    };
    moundDepth.customProgramCacheKey = () => 'argus-mound-depth';
    this.mound = new THREE.Mesh(new THREE.BufferGeometry(), moundMat);
    this.mound.customDepthMaterial = moundDepth;
    this.mound.name = 'debrisMounds';
    this.mound.castShadow = true;
    this.mound.receiveShadow = true;
    this.mound.frustumCulled = false;
    this.mound.visible = false;

    this.group.add(this.mound, this.rocks.mesh, this.slabs.mesh, this.sticks.mesh, this.shardMesh);
  }

  set(chunks: ChunkSpec[], shards: ShardSpec[], mound: MoundData): void {
    this.rocks.set(chunks.filter((c) => c.kind === 0));
    this.slabs.set(chunks.filter((c) => c.kind === 1));
    this.sticks.set(chunks.filter((c) => c.kind === 2));
    this.setShards(shards);
    this.setMound(mound);
  }

  private setShards(list: ShardSpec[]): void {
    this.shardGeom.dispose();
    const g = new THREE.InstancedBufferGeometry();
    // A sliver triangle pair (irregular quad).
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.3, 0, 0.45, -0.5, 0, 0.3, 0.55, 0, -0.35, 0.4, 0]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const n = list.length;
    const S = new Float32Array(n * 4);
    const R = new Float32Array(n * 4);
    const A = new Float32Array(n * 2);
    list.forEach((s, i) => {
      S.set([s.x0, s.y0, s.z0, s.t0], i * 4);
      R.set([s.x1, s.y1, s.z1, s.T], i * 4);
      A.set([s.size, s.seed], i * 2);
    });
    g.setAttribute('aStart', new THREE.InstancedBufferAttribute(S, 4));
    g.setAttribute('aRest', new THREE.InstancedBufferAttribute(R, 4));
    g.setAttribute('aShard', new THREE.InstancedBufferAttribute(A, 2));
    g.instanceCount = n;
    this.shardGeom = g;
    this.shardMesh.geometry = g;
    this.shardMesh.visible = n > 0;
  }

  private setMound(m: MoundData): void {
    this.mound.geometry.dispose();
    const g = new THREE.BufferGeometry();
    if (m.indices.length) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
      g.setAttribute('aGround', new THREE.Float32BufferAttribute(m.ground, 1));
      g.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 3));
      g.setAttribute('aGrow', new THREE.Float32BufferAttribute(m.grow, 2));
      g.setIndex(m.indices);
      g.computeVertexNormals();
    }
    this.mound.geometry = g;
    this.mound.visible = m.indices.length > 0;
  }

  update(t: number): void {
    this.uniforms.uTime.value = t;
  }

  clear(): void {
    this.set([], [], { positions: [], ground: [], colors: [], grow: [], indices: [] });
  }
}
