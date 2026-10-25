/**
 * UI dev page driver (ui-dev.html): renders the real HUD over a painted backdrop with mock data and a
 * deterministic mock quake playback that mirrors main.ts's wiring.
 *
 * URL params:
 *   state=idle|alert|shaking|aftermath   freeze a phase of the default scenario (or use t=<s>)
 *   scn=<scenarioId>  t=<simSeconds>     freeze an exact moment
 *   inspect=1                            open the building inspector
 *   tod=<hours>                          scene time (also picks day/night theme)
 *   collapse=feed,impact                 start with panels collapsed
 *   play=1                               play in real time instead of freezing
 */
import './styles.css';
import type { CameraPresetId, EnvironmentState, OverlayMode, QuakeScenario } from '../contracts';
import { createEventBus } from '../events';
import { createUI } from './index';
import { paintBackdrop } from './dev-backdrop';
import { MOCK_PRESETS, MOCK_SCENARIOS, alertTiming, mockBuilding, mockBuildingQuake, mockCity, mockRun, type MockRun } from './dev-mocks';
import { nightFactorFor } from './format';

declare global {
  interface Window {
    __ui?: Record<string, unknown>;
  }
}

const params = new URLSearchParams(location.search);
const bus = createEventBus();
const city = mockCity();
const backdrop = document.getElementById('backdrop') as HTMLCanvasElement;
const root = document.getElementById('ui-root')!;

let tod = Number(params.get('tod') ?? 16.5);
let run: MockRun | null = null;
let sim = 0;
let playing = false;
let timeScale = Number(params.get('speed') ?? 1) || 1;
let inspectOpen = false;

const env = (h: number): EnvironmentState => ({
  timeOfDay: h,
  nightFactor: nightFactorFor(h),
  sunDirection: {} as EnvironmentState['sunDirection'],
  haze: 0,
});

const ui = createUI(root, { city, events: bus }, {
  onTriggerScenario(id) {
    const s = MOCK_SCENARIOS.find((x) => x.id === id);
    if (s) start(s, true);
  },
  onTriggerCustom(lat, lon, depthKm, mag) {
    const base = MOCK_SCENARIOS[0];
    const ev = structuredClone(base.event);
    ev.id = 'nc_custom';
    ev.geometry.coordinates = [lon, lat, depthKm];
    ev.properties.mag = mag;
    ev.properties.alert = null;
    ev.properties.status = 'automatic';
    ev.properties.title = `M ${mag.toFixed(1)} - Custom event`;
    start({ ...base, id: 'custom', name: 'Custom event', event: ev }, true);
  },
  onReset() {
    run = null;
    playing = false;
    sim = 0;
    ui.hideShakeAlert();
    ui.updateStats(null, 0);
    ui.setPlaying(false);
    bus.emit({ type: 'quake-reset' });
    if (inspectOpen) inspect();
  },
  onTimeOfDay(h) {
    tod = h;
    paint();
    bus.emit({ type: 'environment-changed', env: env(h) });
  },
  onOverlay(mode: OverlayMode) {
    bus.emit({ type: 'overlay-changed', overlay: mode });
  },
  onCameraPreset(id: CameraPresetId) {
    console.info('[dev] camera preset', id);
  },
  onTimeScale(scale) {
    timeScale = scale;
  },
  onPauseToggle() {
    if (!run) return;
    playing = !playing;
    ui.setPlaying(playing);
  },
});

ui.setScenarios(MOCK_SCENARIOS);
ui.setCameraPresets(MOCK_PRESETS);
ui.setCityStats(city);
ui.setTimeOfDay(tod);
bus.emit({ type: 'environment-changed', env: env(tod) });

function paint() {
  paintBackdrop(backdrop, nightFactorFor(tod));
}
paint();
addEventListener('resize', paint);

function start(s: QuakeScenario, autoplay: boolean) {
  run = mockRun({ ...s, localHour: tod }, city);
  sim = 0;
  ui.showEvent(run.scenario.event, run.scenario);
  bus.emit({ type: 'quake-started', event: run.scenario.event });
  playing = autoplay;
  ui.setPlaying(autoplay);
  tick(0);
}

/** Same per-tick wiring as main.ts: ShakeAlert countdown + progressive stats. */
function tick(t: number) {
  if (!run) return;
  sim = t;
  bus.emit({ type: 'quake-tick', simSeconds: t });
  const { result } = run;
  const toShaking = result.shakeAlert.warningSecondsAtCentre + result.shakeAlert.issuedAtS - t;
  if (t >= result.shakeAlert.issuedAtS && toShaking > -20) ui.showShakeAlert(toShaking, result.shakeAlert.expectedMmi);
  else if (toShaking <= -20) ui.hideShakeAlert();
  const byState: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let collapsed = 0;
  let fires = 0;
  let trapped = 0;
  for (const d of result.damage) {
    if (d.failTimeS <= t) {
      byState[d.state]++;
      if (d.collapsed) collapsed++;
      if (d.fire) fires++;
      trapped += d.trappedEstimate;
    } else byState[0]++;
  }
  const frac = result.stats.collapsed ? collapsed / result.stats.collapsed : 0;
  ui.updateStats(
    { ...result.stats, byState, collapsed, fires, trappedEstimate: Math.round(trapped), blockedSegments: Math.round(result.stats.blockedSegments * frac) },
    t,
  );
  if (inspectOpen) inspect();
  if (t >= result.durationS) {
    playing = false;
    ui.setPlaying(false);
    bus.emit({ type: 'quake-finished' });
  }
}

function inspect(open = true) {
  inspectOpen = open;
  if (!open) return ui.showBuilding(null);
  const q = run ? mockBuildingQuake(run) : null;
  ui.showBuilding({
    record: mockBuilding(),
    shaking: q?.shaking,
    damage: q && q.damage.failTimeS <= sim ? q.damage : undefined,
  });
}
bus.on('building-selected', ({ id }) => {
  if (id === null) inspectOpen = false;
});

// Real-time playback loop.
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (run && playing) tick(sim + dt * timeScale);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── Initial state from the URL ──
const scn = MOCK_SCENARIOS.find((s) => s.id === params.get('scn')) ?? MOCK_SCENARIOS[0];
const state = params.get('state');
let t = params.has('t') ? Number(params.get('t')) : null;
if (t === null && state && state !== 'idle') {
  const a = alertTiming(scn);
  t = state === 'alert' ? a.issuedAtS + a.warning * 0.35 : state === 'shaking' ? a.sArrival + 3.5 : a.sArrival + 60;
}
if (t !== null) {
  start(scn, false);
  // Step through time so progressive state (phase, alert, stats) evolves exactly as in playback.
  for (let k = 0; k <= t; k += 0.5) tick(Math.min(k, t));
  tick(t);
  if (params.get('play') === '1') {
    playing = true;
    ui.setPlaying(true);
  }
}
if (params.get('inspect') === '1') inspect();
for (const id of (params.get('collapse') ?? '').split(',').filter(Boolean)) {
  document.querySelector<HTMLElement>(`.ag-${id} .ag-panel__toggle`)?.click();
}

window.__ui = { ui, bus, start: (id: string) => start(MOCK_SCENARIOS.find((s) => s.id === id) ?? scn, true), seek: tick, inspect };
// Harness compatibility with scripts/shot.mjs-style waits.
void document.fonts.ready.then(() => {
  (window as unknown as { __argus: unknown }).__argus = { ready: true, fps: 0 };
});
