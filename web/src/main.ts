import * as THREE from 'three';
import './ui/styles.css';
import type { AppContext, CameraPresetId, CityData, OverlayMode, QuakeResult, QuakeScenario, UpdateFn } from './contracts';
import { createEventBus } from './events';
import { loadHeightfield } from './terrain/heightfield';
import { createEngine } from './engine';
import { createStreets } from './city/streets';
import { createBuildings } from './city/buildings';
import { createLandmarks } from './city/landmarks';
import { createQuakeModel, DEFAULT_SEED, scenarioAtHour } from './quake/model';
import { createQuakeFx } from './quake/fx';
import { createUI } from './ui';
import { createQuakeSession, type QuakeSession } from './app/quakeSession';
import { bootProgress, bootDone, bootFailed } from './app/bootScreen';
import { createFireLightGate } from './app/fireLightGate';
import { createPeople } from './truth/people';
import { createHelicopter } from './air/heli';
import { createScan } from './air/scan';
import { createRecon } from './argus';
import { createAirSession, type AirMode } from './app/airSession';
import { createDroneFleet } from './drones';
import { createDroneSession } from './app/droneSession';
import { createRouter } from './rescue/router';
import { createRescueLayer } from './rescue/layer';
import { createCopilotSession, type CopilotMode } from './app/copilotSession';
import { createReportsSession, type ReportsMode } from './app/reportsSession';

/**
 * Debug / automation surface used by scripts/shot.mjs, scripts/e2e.mjs and the console.
 * URL params: ?cam=<preset>&tod=<hours>&quake=<scenarioId>&t=<simSeconds>&overlay=<mode>&ui=0&select=<buildingId>&speed=<x>
 *   M3: &air=live|mock|replay (default live) &inflight=<n> (concurrent Argon requests, default 2) &play=1 (keep playing after t)
 *   M4: drones + Argon planner follow ?air= (live: real /api/plan + drone capture; mock: heuristic; replay: recorded run)
 *   M5: Copilot chat follows ?air= too (replay → /api/chat replay-only, miss → live; mock → offline heuristic;
 *       live → auto); override with &chat=live|replay|mock. &copilot=1 opens the drawer at boot.
 *   M6: resident reports follow ?air= too (replay → /api/reports replay-only, miss → live once, then mock; mock →
 *       offline heuristic; live → auto); override with &reports=live|replay|mock|off.
 */
declare global {
  interface Window {
    __argus: {
      ready: boolean;
      error?: string;
      ctx?: AppContext;
      flyTo(preset: CameraPresetId, duration?: number): void;
      setCamera(position: [number, number, number], target: [number, number, number]): void;
      setTimeOfDay(h: number): void;
      trigger(scenarioId: string): QuakeResult | null;
      seek(simSeconds: number): void;
      pause(): void;
      resume(): void;
      reset(): void;
      setOverlay(mode: OverlayMode): void;
      select(id: string | null): void;
      /** Select a building and fly the camera to it. */
      focus?(id: string | null): void;
      /** Fly the camera to a world point (span = viewing distance, m). */
      focusPoint?(x: number, y: number, z: number, span?: number): void;
      renderOnce(): void;
      result: QuakeResult | null;
      /** Frames per second over the last full second. */
      fps: number;
      /** Frames rendered since boot (harness: wait for fresh frames after changing state). */
      frame: number;
      /** Currently selected building id. */
      selected: string | null;
      /** Boot timings (ms) for the harness. */
      timings?: Record<string, number>;
      /** Module handles for debugging from the console / harness. */
      handles?: Record<string, unknown>;
      /** M3 AIR 1 session (chunk log, frames captured, captureNow()). */
      air?: import('./app/airSession').AirSession;
      /** M4 drone session (plan log, drone chunk log, approve() / reject()). */
      drones?: import('./app/droneSession').DroneSession;
      /** M5 Argus Copilot session (messages, log, ask(), showPlan(), dispatch(), situation()). */
      copilot?: import('./app/copilotSession').CopilotSession;
      /** M6 resident-reports session (reports, batch log, items(), evaluate(), settled()). */
      reports?: import('./app/reportsSession').ReportsSession;
    };
  }
}

const params = new URLSearchParams(location.search);
/** FX keeps the aftermath clock running this long after the shaking (keep in sync with src/quake/fx). */
const AFTERMATH_S = 1500;

window.__argus = {
  ready: false,
  flyTo: () => {},
  setCamera: () => {},
  setTimeOfDay: () => {},
  trigger: () => null,
  seek: () => {},
  pause: () => {},
  resume: () => {},
  reset: () => {},
  setOverlay: () => {},
  select: () => {},
  renderOnce: () => {},
  result: null,
  fps: 0,
  frame: 0,
  selected: null,
};

async function loadCity(): Promise<CityData> {
  const res = await fetch('/data/city.json');
  if (!res.ok) throw new Error(`city.json missing (${res.status}) — run the data pipeline (scripts/data/build_city.py)`);
  return res.json();
}

/** Let the browser paint the boot screen between synchronous build steps. */
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function boot() {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const mark = (k: string) => (timings[k] = Math.round(performance.now() - t0));
  const viewport = document.getElementById('viewport')!;
  const uiRoot = document.getElementById('ui-root')!;
  const hudOff = params.get('ui') === '0';
  if (hudOff) uiRoot.style.display = 'none';

  bootProgress('Loading San Francisco data', 0.05);
  const [city, terrain] = await Promise.all([loadCity(), loadHeightfield('/data')]);
  mark('data');

  bootProgress('Lighting the sky', 0.3);
  await nextPaint();
  const events = createEventBus();
  const engine = createEngine(viewport);
  engine.setGroundHeightSampler?.((x, z) => terrain.heightAt(x, z));
  const cityRoot = new THREE.Group();
  cityRoot.name = 'cityRoot';
  engine.scene.add(cityRoot);
  mark('engine');

  const updates = new Set<UpdateFn>();
  const ctx: AppContext = {
    scene: engine.scene,
    camera: engine.camera,
    renderer: engine.renderer,
    cityRoot,
    city,
    terrain,
    env: engine.env,
    events,
    onUpdate(fn) {
      updates.add(fn);
      return () => updates.delete(fn);
    },
  };

  bootProgress('Paving streets', 0.4);
  await nextPaint();
  const streets = createStreets(ctx);
  cityRoot.add(streets.object);
  mark('streets');

  bootProgress(`Raising ${city.buildings.length.toLocaleString('en-US')} buildings`, 0.7);
  await nextPaint();
  const buildings = createBuildings(ctx);
  cityRoot.add(buildings.object);
  mark('buildings');

  bootProgress('Placing landmarks', 0.85);
  await nextPaint();
  const landmarks = createLandmarks(ctx, buildings);
  cityRoot.add(landmarks.object);
  mark('landmarks');

  const model = createQuakeModel();
  const fx = createQuakeFx(ctx, { buildings, landmarks, streets, engine, model });
  engine.scene.add(fx.object);
  // FX's pooled fire lights only join the light list once a fire burns (saves ~2.5 ms/frame otherwise).
  const fireGate = createFireLightGate(engine.scene, engine.camera, engine.renderer);
  mark('fx');

  // ── M3: truth people, AIR 1 helicopter, scan coverage/capture, Argon recon layer ──
  const people = createPeople(ctx);
  cityRoot.add(people.object);
  const heli = createHelicopter(ctx);
  engine.scene.add(heli.object);
  const recon = createRecon(ctx, { buildings, landmarks });
  engine.scene.add(recon.object);
  const scan = createScan(ctx, { engine, buildings, landmarks, heli, hideDuringCapture: [recon.object] });
  engine.scene.add(scan.object);
  const fleet = createDroneFleet(ctx);
  engine.scene.add(fleet.object);
  const airParam = params.get('air');
  const airMode: AirMode = airParam === 'mock' || airParam === 'replay' ? airParam : 'live';
  mark('air');

  // ── M5: road router (built once) + 3D rescue layer ──
  const router = createRouter(city, terrain);
  const rescue = createRescueLayer(ctx);
  engine.scene.add(rescue.object);
  const chatParam = params.get('chat') ?? airMode;
  const copilotMode: CopilotMode = chatParam === 'mock' ? 'mock' : chatParam === 'replay' ? 'replay-only' : 'auto';
  mark('rescue');
  const repParam = params.get('reports');
  const reportsMode: ReportsMode = repParam === 'off' || repParam === 'live' || repParam === 'mock' || repParam === 'replay' ? repParam : airMode;

  // ── Quake playback state ──
  let session: QuakeSession | null = null;
  let paused = false;
  let timeScale = Number(params.get('speed') ?? 1) || 1;
  let alertShown = false;
  let selectedId: string | null = null;
  let selectedShownWithDamage = false;

  const setPlaying = (p: boolean) => ui.setPlaying(p);
  // Created after the UI (below); declared here so the playback functions can reach it.
  // eslint-disable-next-line prefer-const
  let air: ReturnType<typeof createAirSession>;
  // eslint-disable-next-line prefer-const
  let drones: ReturnType<typeof createDroneSession>;
  // eslint-disable-next-line prefer-const
  let copilot: ReturnType<typeof createCopilotSession>;
  // eslint-disable-next-line prefer-const
  let reports: ReturnType<typeof createReportsSession>;

  const triggerScenario = (scenario: QuakeScenario) => {
    // Move occupancy AND the USGS origin time to the scene's clock (the event card shows the right time).
    const s = scenario.id.startsWith('custom_') ? scenario : scenarioAtHour(scenario, engine.env.timeOfDay);
    const result = model.run(city, s, DEFAULT_SEED);
    session = createQuakeSession(result, buildings.indexOf);
    window.__argus.result = result;
    const truth = air.begin(result); // people truth + recon baseline + fresh AIR state
    drones.begin(result, truth); // M4: fleet + Argon planner state
    reports.begin(result, truth); // M6: resident reports (generated from the truth world) + batch plan
    copilot.reset(); // M5: a new quake invalidates the chat + routes
    paused = false;
    alertShown = false;
    ui.hideShakeAlert();
    ui.showEvent(s.event, s);
    fx.play(result, { timeScale });
    fireGate.prewarm();
    setPlaying(true);
    events.emit({ type: 'quake-started', event: s.event });
    refreshSelection(true);
    return result;
  };

  const pause = () => {
    if (!session || paused) return;
    paused = true;
    fx.pause();
    setPlaying(false);
  };
  const resume = () => {
    if (!session || !paused) return;
    paused = false;
    // play() with the same result resumes and applies a speed chosen while paused.
    fx.play(session.result, { timeScale });
    setPlaying(true);
  };
  const reset = () => {
    copilot.reset();
    reports.reset();
    drones.reset();
    air.reset();
    fx.reset();
    fireGate.disable();
    session = null;
    paused = false;
    alertShown = false;
    window.__argus.result = null;
    ui.hideShakeAlert();
    ui.updateStats(null, 0);
    setPlaying(false);
    events.emit({ type: 'quake-reset' });
    refreshSelection(true);
  };
  const setOverlay = (mode: OverlayMode) => {
    fx.setOverlay(mode);
    events.emit({ type: 'overlay-changed', overlay: mode });
  };

  const ui = createUI(
    uiRoot,
    { city, events },
    {
      onTriggerScenario(id) {
        const s = model.scenarios.find((x) => x.id === id);
        if (s) triggerScenario(s);
      },
      onTriggerCustom(lat, lon, depthKm, mag) {
        triggerScenario(model.customScenario(lat, lon, depthKm, mag, engine.env.timeOfDay));
      },
      onReset: reset,
      onTimeOfDay(h) {
        engine.setTimeOfDay(h);
      },
      onOverlay: setOverlay,
      onCameraPreset(id) {
        engine.flyTo(id, 2.5);
      },
      onTimeScale(scale) {
        timeScale = scale;
        if (session && !paused) fx.play(session.result, { timeScale: scale });
      },
      onPauseToggle() {
        if (paused) resume();
        else pause();
      },
      onApprovePlan() {
        drones.approve();
      },
      onRejectPlan() {
        drones.reject();
      },
      onCopilotAsk(text) {
        void copilot.ask(text);
      },
      onCopilotShowPlan(id) {
        copilot.showPlan(id);
      },
      onCopilotDispatch(id) {
        copilot.dispatch(id);
      },
      onCopilotHighlight(id) {
        copilot.highlight(id);
      },
      onCopilotToggle(open) {
        copilot.toggled(open);
      },
    },
  );
  air = createAirSession({ ctx, buildings, ui, heli, scan, recon, people }, { mode: airMode, maxInFlight: Number(params.get('inflight') ?? 2) || 2 });
  drones = createDroneSession(
    { ctx, ui, fleet, scan, recon, air, simNow: () => fx.simSeconds, running: () => !!session && !paused, pause, resume },
    { mode: airMode },
  );
  copilot = createCopilotSession(
    {
      ctx,
      ui,
      recon,
      scan,
      router,
      rescue,
      flyTo: (pose, d) => engine.flyTo(pose, d),
      result: () => session?.result ?? null,
      simNow: () => fx.simSeconds,
    },
    { mode: copilotMode },
  );
  reports = createReportsSession({ ctx, ui, recon, refresh: () => air.refresh() }, { mode: reportsMode });
  ui.setScenarios(model.scenarios);
  ui.setCameraPresets(engine.cameraPresets);
  ui.setCityStats(city);
  ui.setTimeOfDay(engine.env.timeOfDay);

  // ── Live ShakeAlert countdown + progressive stats while a quake plays ──
  events.on('quake-tick', ({ simSeconds }) => {
    if (!session) return;
    const { shakeAlert } = session.result;
    const toShaking = session.sArrivalAtCentre - simSeconds;
    const wantAlert = simSeconds >= shakeAlert.issuedAtS && simSeconds < session.alertEndsAt;
    if (wantAlert) {
      ui.showShakeAlert(toShaking, shakeAlert.expectedMmi);
      alertShown = true;
    } else if (alertShown) {
      ui.hideShakeAlert();
      alertShown = false;
    }
    ui.updateStats(session.statsAt(simSeconds), simSeconds);
    refreshSelection(false);
    // "Playing" = the sim clock is running (fx.playing turns false after durationS, but the aftermath clock runs on).
    air.tick(simSeconds, !paused);
    reports.tick(simSeconds, !paused);
    drones.tick(simSeconds, !paused);
  });

  // ── Selection / inspector ──
  const select = (id: string | null) => {
    selectedId = id;
    window.__argus.selected = id;
    buildings.setHighlight(id);
    events.emit({ type: 'building-selected', id });
    refreshSelection(true);
    air.select(id);
  };
  // ── Click-to-focus: map pins, incident markers and list rows fly the camera in (keeps the current heading) ──
  const focusPoint = (x: number, y: number, z: number, span = 180) => {
    const c = engine.camera.position;
    let dx = c.x - x;
    let dz = c.z - z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    engine.flyTo({ position: [x + dx * span * 0.75, y + span * 0.62, z + dz * span * 0.75], target: [x, y, z] }, 1.6);
  };
  const focusBuilding = (id: string | null) => {
    if (!id) return select(null);
    const i = buildings.indexOf(id);
    if (i < 0) return;
    if (id !== selectedId) select(id);
    const b = city.buildings[i];
    let cx = 0;
    let cz = 0;
    for (const [px, pz] of b.footprint) {
      cx += px;
      cz += pz;
    }
    cx /= b.footprint.length || 1;
    cz /= b.footprint.length || 1;
    const h = b.height || 20;
    focusPoint(cx, (b.baseElevation || 0) + h * 0.5, cz, Math.min(420, Math.max(150, h * 2.6)));
  };
  /** Re-show the inspector when the selected building's damage manifests (or on new/cleared results). */
  function refreshSelection(force: boolean) {
    if (!selectedId) {
      if (force) ui.showBuilding(null);
      return;
    }
    const i = buildings.indexOf(selectedId);
    if (i < 0) return;
    const r = session?.result;
    const withDamage = !!r && r.damage[i].failTimeS <= fx.simSeconds;
    if (!force && withDamage === selectedShownWithDamage) return;
    selectedShownWithDamage = withDamage;
    ui.showBuilding({ record: city.buildings[i], shaking: r?.shaking[i], damage: withDamage ? r!.damage[i] : undefined });
  }
  // The inspector's close button / Esc deselects through the bus: drop the highlight too.
  // A non-null id from the HUD (M6 report toast / panel row) selects that building.
  events.on('building-selected', ({ id }) => {
    if (id && id !== selectedId) {
      select(id);
      return;
    }
    if (id === null && selectedId !== null) {
      selectedId = null;
      window.__argus.selected = null;
      buildings.setHighlight(null);
      air.select(null);
    }
  });

  // Click (not drag) on the canvas picks a building; empty ground clears the selection.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt: [number, number] | null = null;
  const canvas = engine.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => (downAt = e.button === 0 ? [e.clientX, e.clientY] : null));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    downAt = null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, engine.camera);
    const id = buildings.pick(raycaster);
    if (id !== selectedId) select(id);
  });

  // ── Frame loop ──
  let frames = 0;
  let acc = 0;
  engine.start(events, (dt, elapsed) => {
    updates.forEach((fn) => fn(dt, elapsed));
    fireGate.update();
    window.__argus.frame++;
    frames++;
    acc += dt;
    if (acc >= 1) {
      window.__argus.fps = Math.round(frames / acc);
      frames = 0;
      acc = 0;
      // FX stops its aftermath clock ~10 min after the event; reflect that on the play button.
      if (session && !paused && !fx.playing && fx.simSeconds > session.result.durationS + AFTERMATH_S - 1) {
        paused = true;
        setPlaying(false);
      }
    }
  });
  mark('ready');

  Object.assign(window.__argus, {
    ctx,
    timings,
    handles: { engine, streets, buildings, landmarks, model, fx, ui, people, heli, scan, recon, air, fleet, drones, router, rescue, copilot, reports },
    air,
    drones,
    copilot,
    reports,
    focus: focusBuilding,
    focusPoint,
    flyTo: (p: CameraPresetId, d = 0) => engine.flyTo(p, d),
    setCamera: (position: [number, number, number], target: [number, number, number]) => engine.flyTo({ position, target }, 0),
    setTimeOfDay: (h: number) => {
      engine.setTimeOfDay(h);
      ui.setTimeOfDay(h);
    },
    trigger: (id: string) => {
      const s = model.scenarios.find((x) => x.id === id);
      return s ? triggerScenario(s) : null;
    },
    seek: (t: number) => {
      fx.seek(t);
      refreshSelection(false);
    },
    pause,
    resume,
    reset,
    setOverlay,
    select,
    renderOnce: () => engine.renderOnce(),
  });

  // ── URL params (screenshot harness / deep links) ──
  const tod = params.get('tod');
  if (tod) window.__argus.setTimeOfDay(Number(tod));
  const cam = params.get('cam') as CameraPresetId | null;
  if (cam) engine.flyTo(cam, 0);
  const quake = params.get('quake');
  if (quake) {
    window.__argus.trigger(quake);
    const t = params.get('t');
    if (t) {
      pause();
      window.__argus.seek(Number(t));
      if (params.get('play') === '1') resume();
    }
  }
  const overlay = params.get('overlay') as OverlayMode | null;
  if (overlay) setOverlay(overlay);
  const sel = params.get('select');
  if (sel) select(sel);
  if (params.get('copilot') === '1') {
    ui.copilotOpen?.(true);
    copilot.toggled(true);
  }

  bootDone(hudOff);
  window.__argus.ready = true;
  // Compile the fire-lit shader variants in the background so the first fire never stalls a frame.
  window.setTimeout(() => fireGate.prewarm(), 2000);
}

boot().catch((err) => {
  console.error(err);
  window.__argus.error = String(err?.stack ?? err);
  bootFailed(String(err?.message ?? err));
});
