/**
 * AIR 1 scan coverage, the slight grey "unscanned" veil, and off-screen frame capture with AR overlay.
 *
 * The current footprint outline / route line are drawn by the helicopter module; this module draws the veil
 * (with a faint glow on the scanned-area boundary).
 *
 * Coverage: the helicopter camera footprint (heli.poseAt(t).footprint, clipped to SCAN_RANGE around the
 * aircraft) is rasterised every DT seconds of flight time into a 4 m world grid. Fixed sample times make
 * setCoverageUntil(T) a pure function of T: increasing T only rasterises the new samples, decreasing T rebuilds.
 * A building is scanned once its footprint centroid's cell is covered; its veil fades 1 → 0 over VEIL_FADE_S
 * of flight time after that (also a pure function of T).
 */
import * as THREE from 'three';
import type { AppContext, BuildingsHandle, Engine, HelicopterHandle, LandmarksHandle, ScanFrame, ScanHandle } from '../../contracts';
import { project } from '../../geo';
import { buildDrapeGeometry } from '../../quake/fx/drape';
import { FrameCapture } from './capture';
import { cellAt, centroid, fillPolygon, makeGrid, type GridRect } from './grid';

export { buildingLabel, FRAME_W, FRAME_H } from './capture';

const CELL = 4;
const DT = 0.5;
const SCAN_RANGE = 900;
const VEIL_FADE_S = 0.5;

export interface ScanDeps {
  engine: Engine;
  buildings: BuildingsHandle;
  landmarks: LandmarksHandle;
  heli: HelicopterHandle;
  /** Extra objects hidden while capturing a frame (e.g. recon markers). The helicopter and the veil are always hidden. */
  hideDuringCapture?: THREE.Object3D[];
}

export interface ScanHandleExt extends ScanHandle {
  /** Debug: duration of the last captureFrame (ms). */
  readonly lastCaptureMs: number;
  /** Current coverage flight time (null = off). */
  readonly coverageT: number | null;
  /** Debug counters of the last capture. */
  readonly debug: FrameCapture['debug'];
}

const VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vW;
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vW = wp.xyz;
	vec4 mvPosition = viewMatrix * wp;
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <fog_pars_fragment>
uniform sampler2D uCov;
uniform vec4 uRect; // minX, minZ, 1/sizeX, 1/sizeZ
uniform vec2 uTexel;
uniform float uAlpha;
varying vec3 vW;
float cov( vec2 uv ) { return texture2D( uCov, uv ).r; }
void main() {
	vec2 uv = ( vW.xz - uRect.xy ) * uRect.zw;
	// Soft edge: 9-tap blur ≈ 10 m.
	vec2 o = uTexel * 1.6;
	float c = cov( uv ) * 0.25
		+ ( cov( uv + vec2( o.x, 0.0 ) ) + cov( uv - vec2( o.x, 0.0 ) ) + cov( uv + vec2( 0.0, o.y ) ) + cov( uv - vec2( 0.0, o.y ) ) ) * 0.125
		+ ( cov( uv + o ) + cov( uv - o ) + cov( uv + vec2( o.x, -o.y ) ) + cov( uv + vec2( -o.x, o.y ) ) ) * 0.0625;
	// Fade out at the edge of the coverage grid.
	vec2 e = min( uv, 1.0 - uv );
	float inside = smoothstep( 0.0, 0.03, min( e.x, e.y ) );
	float water = vW.y < 0.9 ? 0.55 : 1.0;
	float veil = ( 1.0 - c ) * uAlpha * inside * water;
	// Faint glow on the scanned-area boundary.
	float edge = smoothstep( 0.0, 0.5, c ) * smoothstep( 1.0, 0.5, c ) * inside;
	vec3 col = mix( vec3( 0.20, 0.21, 0.23 ), vec3( 0.35, 0.85, 1.0 ), edge * 0.9 );
	float a = veil + edge * 0.22;
	if ( a < 0.003 ) discard;
	gl_FragColor = vec4( col, a );
	#include <fog_fragment>
}
`;

export function createScan(ctx: AppContext, deps: ScanDeps): ScanHandleExt {
  const { engine, buildings, heli } = deps;
  const city = ctx.city;
  const recs = city.buildings;
  const N = recs.length;

  // ── Grid over the context area (+ margin) ──
  const cb = city.meta.contextBBox;
  const [cx0, cz1] = project(cb.south, cb.west);
  const [cx1, cz0] = project(cb.north, cb.east);
  const M = 150;
  const grid: GridRect = makeGrid(cx0 - M, cz0 - M, cx1 + M, cz1 + M, CELL);
  const cells = grid.w * grid.h;
  const mask = new Uint8Array(cells);
  const kb = city.meta.bbox;
  const [kx0, kz1] = project(kb.south, kb.west);
  const [kx1, kz0] = project(kb.north, kb.east);
  const ci0 = Math.max(0, Math.floor((kx0 - grid.minX) / CELL));
  const ci1 = Math.min(grid.w - 1, Math.floor((kx1 - grid.minX) / CELL));
  const cj0 = Math.max(0, Math.floor((kz0 - grid.minZ) / CELL));
  const cj1 = Math.min(grid.h - 1, Math.floor((kz1 - grid.minZ) / CELL));
  const coreCells = (ci1 - ci0 + 1) * (cj1 - cj0 + 1);
  let coreCovered = 0;

  // Buildings by centroid cell (linked lists).
  const head = new Int32Array(cells).fill(-1);
  const next = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const fp = recs[i].footprint;
    if (fp.length < 3) continue;
    const [x, z] = centroid(fp);
    const k = cellAt(grid, x, z);
    if (k < 0) continue;
    next[i] = head[k];
    head[k] = i;
  }
  const scannedAt = new Float32Array(N).fill(Infinity);

  // ── Visuals: draped ground veil + current footprint outline ──
  const object = new THREE.Group();
  object.name = 'scanVeil';
  object.visible = false;
  const covTex = new THREE.DataTexture(mask, grid.w, grid.h, THREE.RedFormat, THREE.UnsignedByteType);
  covTex.unpackAlignment = 1;
  covTex.minFilter = THREE.LinearFilter;
  covTex.magFilter = THREE.LinearFilter;
  covTex.wrapS = covTex.wrapT = THREE.ClampToEdgeWrapping;
  covTex.generateMipmaps = false;
  covTex.needsUpdate = true;
  const sizeX = grid.w * CELL;
  const sizeZ = grid.h * CELL;
  const veilMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uCov: { value: null },
        uRect: { value: new THREE.Vector4(grid.minX, grid.minZ, 1 / sizeX, 1 / sizeZ) },
        uTexel: { value: new THREE.Vector2(1 / grid.w, 1 / grid.h) },
        uAlpha: { value: 0.2 },
      },
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  veilMat.uniforms.uCov.value = covTex;
  const drapeGeo = buildDrapeGeometry(ctx.terrain, { minX: grid.minX, minZ: grid.minZ, maxX: grid.minX + sizeX, maxZ: grid.minZ + sizeZ }, 1.3, 0.6);
  const drape = new THREE.Mesh(drapeGeo, veilMat);
  drape.name = 'scanVeilGround';
  drape.renderOrder = 2;
  drape.frustumCulled = false;
  object.add(drape);

  // ── Coverage state ──
  let active = false;
  let lastK = -1; // highest rasterised sample index
  let curT: number | null = null;
  let maskDirty = false;
  const veilNow = new Float32Array(N);

  const clearCoverage = () => {
    mask.fill(0);
    scannedAt.fill(Infinity);
    coreCovered = 0;
    lastK = -1;
    maskDirty = true;
  };

  const rasterise = (t: number) => {
    const pose = heli.poseAt(t);
    if (!pose.footprint || pose.footprint.length < 3) return;
    fillPolygon(
      grid,
      pose.footprint,
      (k) => {
        if (mask[k]) return;
        mask[k] = 255;
        maskDirty = true;
        const i = k % grid.w;
        const j = (k - i) / grid.w;
        if (i >= ci0 && i <= ci1 && j >= cj0 && j <= cj1) coreCovered++;
        for (let b = head[k]; b >= 0; b = next[b]) if (scannedAt[b] === Infinity) scannedAt[b] = t;
      },
      pose.position[0],
      pose.position[2],
      SCAN_RANGE,
    );
  };

  const setVeil = (i: number, v: number) => {
    if (veilNow[i] === v) return;
    veilNow[i] = v;
    buildings.setVeil?.(i, v);
  };

  const capture = new FrameCapture(ctx, engine, buildings, grid);
  /** Lift the per-building veil for the off-screen render (Argon must see true colours), then restore. */
  const liftVeils = () => {
    if (!buildings.setVeil) return false;
    let any = false;
    for (let i = 0; i < N; i++)
      if (veilNow[i] > 0) {
        buildings.setVeil(i, 0);
        any = true;
      }
    if (any) buildings.commit();
    return any;
  };
  const restoreVeils = () => {
    for (let i = 0; i < N; i++) if (veilNow[i] > 0) buildings.setVeil!(i, veilNow[i]);
    buildings.commit();
  };
  // Build the occlusion raster off the critical path so the first live capture stays cheap.
  setTimeout(() => capture.warm(), 2500);
  let frameCounter = 0;
  let lastCaptureMs = 0;
  ctx.events.on('quake-started', ({ event }) => (capture.originMs = event.properties.time));
  ctx.events.on('quake-reset', () => (capture.originMs = null));

  const handle: ScanHandleExt = {
    object,
    get lastCaptureMs() {
      return lastCaptureMs;
    },
    get coverageT() {
      return curT;
    },
    get debug() {
      return capture.debug;
    },
    setCoverageUntil(T) {
      if (T === null || !Number.isFinite(T)) {
        if (active) {
          for (let i = 0; i < N; i++) setVeil(i, 0);
          object.visible = false;
          active = false;
        }
        curT = null;
        return;
      }
      if (!active) {
        active = true;
        object.visible = true;
      }
      const kT = Math.floor(Math.min(T, heli.durationS) / DT + 1e-6);
      if (kT < lastK) clearCoverage();
      for (let k = lastK + 1; k <= kT; k++) rasterise(k * DT);
      lastK = Math.max(lastK, kT);
      curT = T;
      if (maskDirty) {
        covTex.needsUpdate = true;
        maskDirty = false;
      }
      for (let i = 0; i < N; i++) {
        const s = scannedAt[i];
        const v = s > T ? 1 : Math.max(0, 1 - (T - s) / VEIL_FADE_S);
        setVeil(i, Math.round(v * 64) / 64);
      }
    },
    isScanned(i) {
      return curT !== null && scannedAt[i] <= curT;
    },
    scannedFraction() {
      return curT === null ? 0 : coreCovered / coreCells;
    },
    captureFrame(pose, simS): ScanFrame {
      if (capture.originMs === null) {
        const r = (window as unknown as { __argus?: { result?: { scenario: { event: { properties: { time: number } } } } | null } }).__argus?.result;
        if (r) capture.originMs = r.scenario.event.properties.time;
      }
      const index = frameCounter++;
      const lifted = liftVeils();
      let out: ReturnType<FrameCapture['capture']>;
      try {
        out = capture.capture(pose, simS, index, [heli.object, object, ...(deps.hideDuringCapture ?? [])]);
      } finally {
        if (lifted) restoreVeils();
      }
      lastCaptureMs = out.ms;
      return { index, flightS: pose.flightS, simS, pose, jpegBase64: out.jpegBase64, taggedBuildingIds: out.taggedBuildingIds };
    },
    async captureFrameAsync(pose, simS): Promise<ScanFrame> {
      if (capture.originMs === null) {
        const r = (window as unknown as { __argus?: { result?: { scenario: { event: { properties: { time: number } } } } | null } }).__argus?.result;
        if (r) capture.originMs = r.scenario.event.properties.time;
      }
      const index = frameCounter++;
      // captureAsync renders synchronously before its first await, so the veils can be restored right after the call.
      const lifted = liftVeils();
      let pending: Promise<ReturnType<FrameCapture['capture']>>;
      try {
        pending = capture.captureAsync(pose, simS, index, [heli.object, object, ...(deps.hideDuringCapture ?? [])]);
      } finally {
        if (lifted) restoreVeils();
      }
      const out = await pending;
      lastCaptureMs = out.ms;
      return { index, flightS: pose.flightS, simS, pose, jpegBase64: out.jpegBase64, taggedBuildingIds: out.taggedBuildingIds };
    },
    reset() {
      handle.setCoverageUntil(null);
      clearCoverage();
      covTex.needsUpdate = true;
      maskDirty = false;
      frameCounter = 0;
    },
  };
  return handle;
}
