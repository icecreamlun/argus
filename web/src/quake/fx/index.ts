/**
 * Earthquake visual effects — composition root of src/quake/fx.
 *
 * Everything visible is a pure function of the playback clock `t` (sim seconds after origin):
 *   motion.ts     buildings (state texture), landmarks, city-root ground motion, camera shake, power grid
 *   waves.ts      P / S fronts draped on the terrain
 *   spawn.ts      → debris.ts (rubble mounds, ballistic chunks, glass) and particles.ts (dust)
 *   fire.ts       flames, embers, smoke emitters, pooled point lights
 *   shakemap.ts / markers.ts   overlays
 *   audio.ts      synthesised rumble / crashes (after a user gesture only)
 * so seek(t) reproduces a frame exactly (only flame flicker and camera shake use wall-clock noise).
 *
 * Playback: play() starts at t = 0; time advances by dt·timeScale. After durationS 'quake-finished' fires
 * once, `playing` reads false, but the aftermath keeps evolving (fires grow, dust drifts) until pause()/reset().
 */
import * as THREE from 'three';
import type {
  AppContext,
  BuildingsHandle,
  Engine,
  LandmarksHandle,
  OverlayMode,
  QuakeFxHandle,
  QuakeModel,
  QuakeResult,
  StreetsHandle,
} from '../../contracts';
import { QuakeAudio } from './audio';
import { DebrisRenderer } from './debris';
import { buildDrapeGeometry, buildHeightTexture, terrainRect, type HeightTexture } from './drape';
import { FireSystem } from './fire';
import { DamageMarkers, RoadClosures, type ClosureSpec, type MarkerSpec } from './markers';
import { BuildingMotion } from './motion';
import { ParticleSystem, makePuffAtlas } from './particles';
import { CityField } from './cityField';
import { prepareCity } from './prep';
import { RuinRenderer, buildRuins } from './ruins';
import { DustDecals, type DustSite } from './dustDecal';
import type { XZ } from '../../contracts';
import { ShakeMapField, mmiColorLinear } from './shakemap';
import { spawnAll, type SpawnResult } from './spawn';
import { smoothstep } from './timeline';
import { WaveFronts } from './waves';

export interface QuakeFxDeps {
  buildings: BuildingsHandle;
  landmarks: LandmarksHandle;
  streets: StreetsHandle;
  engine: Engine;
  model: QuakeModel;
}

/** Extra debug surface (not part of the contract). */
export interface QuakeFxDebug {
  stats(): Record<string, number>;
  wind: THREE.Vector3;
  /** Show/hide a named FX object (e.g. 'quakeDust', 'quakeSmoke', 'debrisMounds') for inspection. */
  show(name: string, visible: boolean): void;
}

interface Systems {
  height: HeightTexture;
  drape: THREE.BufferGeometry;
  waves: WaveFronts;
  shakemap: ShakeMapField;
  /** Dust and smoke share one instanced draw. */
  particles: ParticleSystem;
  field: CityField;
}

export function createQuakeFx(ctx: AppContext, deps: QuakeFxDeps): QuakeFxHandle & { debug: QuakeFxDebug } {
  const root = new THREE.Group();
  root.name = 'quakeFx';
  const prep = prepareCity(ctx.city);
  const rect = terrainRect(ctx.terrain);
  const motion = new BuildingMotion(ctx, deps, prep);
  const debris = new DebrisRenderer();
  const ruins = new RuinRenderer();
  const dustDecals = new DustDecals();
  const fire = new FireSystem(root);
  const markers = new DamageMarkers();
  const closures = new RoadClosures();
  const audio = new QuakeAudio();
  root.add(debris.group, ruins.group, dustDecals.mesh, fire.group, markers.mesh, closures.mesh);

  // Prevailing west-north-westerly off the Pacific: dust and smoke drift east-south-east over the bay.
  const wind = new THREE.Vector3(3.2, 0, 1.0);
  fire.windUniform.copy(wind);

  let sys: Systems | null = null;
  const ensureSystems = (): Systems => {
    if (sys) return sys;
    const height = buildHeightTexture(ctx.terrain, rect, 8);
    const drape = buildDrapeGeometry(ctx.terrain, rect);
    const atlas = makePuffAtlas();
    const field = new CityField(ctx.city, { minX: -1750, minZ: -1350, maxX: 1750, maxZ: 1300 });
    const waves = new WaveFronts(drape, rect, ctx.terrain);
    const shakemap = new ShakeMapField(drape, rect);
    const particles = new ParticleSystem('quakeParticles', atlas, { height, city: field });
    particles.uniforms.uWind.value = wind;
    root.add(waves.group, shakemap.mesh, particles.mesh);
    sys = { height, drape, waves, shakemap, particles, field };
    return sys;
  };

  // ── Playback state ──
  let result: QuakeResult | null = null;
  let spawn: SpawnResult | null = null;
  let t = 0;
  let running = false;
  let timeScale = 1;
  let finished = false;
  let lastApplied = NaN;
  let lastTickEmit = -1;
  let anim = 0;
  let overlay: OverlayMode = 'none';
  let overlayColoured = false;
  let shakemapLoaded = false;
  let baseHaze = deps.engine.env.haze;
  let collapsesSorted: SpawnResult['collapses'] = [];
  let audioT = 0;
  const timing = { loadMs: 0, spawnMs: 0, frameMs: 0, applyMs: 0 };

  const camera = ctx.camera;
  const focus = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const vp = new THREE.Vector2();

  /** Where the camera looks: first terrain hit along the view ray (or a point ~800 m ahead). */
  const updateFocus = () => {
    camera.getWorldDirection(dir);
    const p = camera.position;
    let s = 4;
    let prev = 0;
    for (let k = 0; k < 64; k++) {
      const x = p.x + dir.x * s;
      const y = p.y + dir.y * s;
      const z = p.z + dir.z * s;
      if (y <= Math.max(ctx.terrain.heightAt(x, z), 0)) {
        // refine
        let a = prev;
        let b = s;
        for (let i = 0; i < 8; i++) {
          const m = (a + b) / 2;
          if (p.y + dir.y * m <= Math.max(ctx.terrain.heightAt(p.x + dir.x * m, p.z + dir.z * m), 0)) b = m;
          else a = m;
        }
        focus.set(p.x + dir.x * b, p.y + dir.y * b, p.z + dir.z * b);
        return;
      }
      prev = s;
      s = s * 1.15 + 4;
      if (s > 6000) break;
    }
    focus.set(p.x + dir.x * 800, 0, p.z + dir.z * 800);
  };

  /** Atmospheric dust load from collapses (and fire smoke) → engine haze. */
  const hazeAt = (time: number) => {
    if (!spawn) return baseHaze;
    // Only a faint city-wide lift: the dust itself is local (particles, ground decals), not a global veil.
    let m = 0;
    // Settles with the plumes (~40–60 s), so later aerial footage is clear.
    for (const c of spawn.collapses) m += c.mass * smoothstep(c.t, c.t + 15, time) * (1 - 0.8 * smoothstep(c.t + 25, c.t + 60, time));
    return Math.min(0.85, baseHaze + 0.05 * (1 - Math.exp(-m / 260000)));
  };

  /** Full deterministic state at time t (buildings, power, haze). */
  const applyState = (time: number) => {
    if (!result) return;
    motion.apply(time);
    deps.engine.setHaze(hazeAt(time));
    lastApplied = time;
  };

  /** Per-frame uniforms + camera-dependent effects. */
  const perFrame = (time: number, live: boolean) => {
    if (!result || !sys) return;
    ctx.renderer.getSize(vp);
    sys.waves.update(time);
    sys.particles.update(time, deps.engine.sun, fire.lightList, ctx.renderer, camera, vp.y, ctx.env.nightFactor);
    debris.update(time);
    ruins.update(time);
    dustDecals.update(time);
    fire.update(time, anim, camera, vp.y, ctx.env.nightFactor);
    markers.update(time, vp.x, vp.y);
    closures.update(time);
    sys.shakemap.setBrightness(ctx.env.nightFactor);
    updateFocus();
    const camDist = camera.position.distanceTo(focus);
    motion.applyGround(time, focus, camDist, live);
    root.position.copy(ctx.cityRoot.position);
    // Audio.
    audio.update(motion.intensityAt(focus.x, focus.z, time), motion.pPhaseAt(focus.x, focus.z, time), live);
    if (live && time > audioT) {
      for (const c of collapsesSorted) {
        if (c.t <= audioT) continue;
        if (c.t > time) break;
        audio.crash(Math.hypot(c.x - camera.position.x, c.top - camera.position.y, c.z - camera.position.z), c.mass);
      }
    }
    audioT = time;
  };

  const emitTick = () => ctx.events.emit({ type: 'quake-tick', simSeconds: t });

  const checkFinished = () => {
    if (result && !finished && t > result.durationS) {
      finished = true;
      ctx.events.emit({ type: 'quake-finished' });
    }
  };

  ctx.onUpdate((dt) => {
    anim += dt;
    if (!result) return;
    const f0 = performance.now();
    if (running) {
      t += dt * timeScale;
      // Stop the aftermath clock eventually (dust long gone, fires steady).
      if (t > result.durationS + 1500) running = false; // M4: drone waves run ~10+ min after the event
    }
    const a0 = performance.now();
    if (t !== lastApplied) applyState(t);
    timing.applyMs = timing.applyMs * 0.9 + (performance.now() - a0) * 0.1;
    perFrame(t, running);
    timing.frameMs = timing.frameMs * 0.9 + (performance.now() - f0) * 0.1;
    if (running) {
      // Every frame while the quake plays; ~4 Hz in the aftermath (UI stats only).
      if (t <= result.durationS || t - lastTickEmit > 0.25 * timeScale) {
        lastTickEmit = t;
        emitTick();
      }
      checkFinished();
    }
  });

  // ── Overlays ──
  const clearOverlayColours = () => {
    if (!overlayColoured) return;
    for (let i = 0; i < prep.n; i++) deps.buildings.setOverlayColor(i, null);
    overlayColoured = false;
  };
  const applyOverlay = () => {
    const s = sys;
    if (overlay === 'shakemap' && result) {
      const S = ensureSystems();
      if (!shakemapLoaded) {
        S.shakemap.load(deps.model, ctx.city, result);
        shakemapLoaded = true;
      }
      deps.buildings.setDamageOverlay(false);
      for (let i = 0; i < prep.n; i++) deps.buildings.setOverlayColor(i, mmiColorLinear(result.shaking[i].mmi));
      overlayColoured = true;
      S.shakemap.setVisible(true);
      markers.setVisible(false);
      closures.setVisible(false);
    } else if (overlay === 'damage' && result) {
      clearOverlayColours();
      deps.buildings.setDamageOverlay(true);
      s?.shakemap.setVisible(false);
      markers.setVisible(true);
      closures.setVisible(true);
    } else {
      clearOverlayColours();
      deps.buildings.setDamageOverlay(false);
      s?.shakemap.setVisible(false);
      markers.setVisible(false);
      closures.setVisible(false);
    }
    deps.buildings.commit();
  };

  // ── Load / clear ──
  const load = (r: QuakeResult) => {
    const l0 = performance.now();
    const S = ensureSystems();
    if (!result) baseHaze = deps.engine.env.haze;
    result = r;
    motion.load(r);
    S.waves.load(r);
    const s0 = performance.now();
    spawn = spawnAll(ctx, prep, r);
    timing.spawnMs = performance.now() - s0;
    const ruin = buildRuins(ctx, prep, spawn.fails);
    ruins.set(ruin);
    debris.set(spawn.chunks.concat(ruin.chunks), spawn.shards, spawn.mound);
    S.particles.setParticles(spawn.dust.concat(fire.load(ctx, prep, spawn.fails, ruin.shapes)));
    // Settled dust around every collapse (light, tinted by the facade it came from).
    const dustTint = new THREE.Color().setHex(0xc8beac, THREE.SRGBColorSpace);
    const sites: DustSite[] = spawn.collapses.map((c) => {
      const grp = prep.groups[c.g];
      const rep = ctx.city.buildings[grp.rep];
      return {
        x: c.x,
        z: c.z,
        R: c.R,
        t0: c.t + 6,
        ring: rep.footprint as XZ[],
        col: grp.wall.clone().lerp(dustTint, 0.88).multiplyScalar(1.05),
        overWater: !!rep.overWater,
      };
    });
    dustDecals.set(sites, ctx.terrain, wind);
    // Soft-particle field: collapsed buildings now end at their rubble.
    const roofs = S.field.originalRoofs.slice();
    for (const c of spawn.collapses) for (const i of prep.groups[c.g].members) roofs[i] = c.top;
    S.field.setRoofs(roofs);
    collapsesSorted = [...spawn.collapses].sort((a, b) => a.t - b.t);
    // Markers: collapse pins; road closures as hatched strips on the blocked carriageway.
    const mk: MarkerSpec[] = spawn.collapses.map((c) => ({ x: c.x, y: c.top + 10, z: c.z, t0: c.t + 0.5, kind: 0 }));
    const idIndex = new Map<string, number>();
    ctx.city.buildings.forEach((b, i) => idIndex.set(b.id, i));
    const roadById = new Map(ctx.city.roads.map((rd) => [rd.id, rd] as const));
    const cl: ClosureSpec[] = [];
    for (const rb of r.roads) {
      const ci = idIndex.get(rb.causeBuildingId);
      const road = roadById.get(rb.roadId);
      if (ci === undefined || !road) continue;
      const a = road.points[rb.segment];
      const b = road.points[Math.min(rb.segment + 1, road.points.length - 1)];
      if (!a || !b) continue;
      const f = spawn.fails[prep.groupOf[ci]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      cl.push({
        x: rb.at[0],
        y: ctx.terrain.heightAt(rb.at[0], rb.at[1]) + 0.35,
        z: rb.at[1],
        t0: f.tf + (f.collapsed ? f.tc * 0.5 : 0.5),
        dx: (b[0] - a[0]) / len,
        dz: (b[1] - a[1]) / len,
        length: Math.min(len, 6 + 10 * rb.coverage),
        width: Math.max(2, road.width * Math.min(1, rb.coverage + 0.15)),
        impassable: rb.coverage >= 0.6,
      });
    }
    closures.set(cl);
    markers.set(mk);
    shakemapLoaded = false;
    applyOverlay();
    timing.loadMs = performance.now() - l0;
    // Pre-compile the FX programs (and the scene, if fire lights were just added) while P waves travel.
    try {
      void ctx.renderer.compileAsync(ctx.scene, camera).catch(() => {});
    } catch {
      /* compileAsync unavailable */
    }
  };

  const clearAll = () => {
    motion.clear();
    sys?.waves.clear();
    sys?.particles.clear();
    sys?.field.setRoofs(null);
    sys?.shakemap.clear();
    debris.clear();
    ruins.clear();
    dustDecals.clear();
    fire.clear();
    markers.set([]);
    markers.setVisible(false);
    closures.set([]);
    closures.setVisible(false);
    clearOverlayColours();
    deps.buildings.setDamageOverlay(false);
    deps.buildings.commit();
    deps.engine.setHaze(baseHaze);
    deps.engine.setCameraShake(0);
    audio.silence();
    root.position.set(0, 0, 0);
    result = null;
    spawn = null;
    shakemapLoaded = false;
    collapsesSorted = [];
  };

  /**
   * Compile every FX program once at boot (in the background, after the city is up) so the first quake never
   * stalls on shader compiles: all FX meshes are made visible for one compile pass — with and without the
   * pooled fire lights, the two light configurations the scene will use — then restored.
   */
  const prewarm = () => {
    if (result) return;
    ensureSystems();
    const meshes: THREE.Object3D[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.LineSegments).isLineSegments) meshes.push(o);
    });
    const vis = meshes.map((m) => m.visible);
    const lights = fire.lightList;
    const lightVis = lights.map((l) => l.visible);
    const prevTarget = ctx.renderer.getRenderTarget();
    const probe = new THREE.WebGLRenderTarget(1, 1);
    try {
      meshes.forEach((m) => (m.visible = true));
      ctx.renderer.setRenderTarget(probe);
      for (const lit of [false, true]) {
        lights.forEach((l) => (l.visible = lit));
        void ctx.renderer.compileAsync(root, camera, ctx.scene).catch(() => {});
      }
    } catch {
      /* compileAsync unavailable: programs compile on first use */
    } finally {
      ctx.renderer.setRenderTarget(prevTarget);
      meshes.forEach((m, k) => (m.visible = vis[k]));
      lights.forEach((l, k) => (l.visible = lightVis[k]));
      probe.dispose();
    }
  };
  window.setTimeout(prewarm, 2500);

  const handle: QuakeFxHandle & { debug: QuakeFxDebug } = {
    object: root,
    play(r, opts) {
      if (opts?.timeScale !== undefined && Number.isFinite(opts.timeScale) && opts.timeScale > 0) timeScale = opts.timeScale;
      if (r === result) {
        running = true;
        return;
      }
      clearAll();
      load(r);
      t = 0;
      lastApplied = NaN;
      lastTickEmit = -1;
      audioT = 0;
      finished = false;
      running = true;
      applyState(0);
      perFrame(0, false);
    },
    seek(s) {
      t = Math.max(0, s);
      if (!result) return;
      audioT = t;
      applyState(t);
      perFrame(t, false);
      emitTick();
      checkFinished();
    },
    pause() {
      running = false;
      audio.silence();
    },
    resume() {
      if (result) running = true;
    },
    reset() {
      running = false;
      t = 0;
      finished = false;
      clearAll();
    },
    get playing() {
      return running && !!result && t <= result.durationS;
    },
    get simSeconds() {
      return t;
    },
    setOverlay(mode) {
      overlay = mode;
      applyOverlay();
    },
    debug: {
      wind,
      show(name, visible) {
        const o = root.getObjectByName(name);
        if (o) {
          o.visible = visible;
          o.layers.set(visible ? 0 : 31);
        }
      },
      stats() {
        return {
          chunks: spawn?.chunks.length ?? 0,
          shards: spawn?.shards.length ?? 0,
          dust: spawn?.dust.length ?? 0,
          moundVerts: (spawn?.mound.positions.length ?? 0) / 3,
          collapses: spawn?.collapses.length ?? 0,
          powerOut: motion.powerOut,
          haze: deps.engine.env.haze,
          t,
          ...timing,
        };
      },
    },
  };
  return handle;
}
