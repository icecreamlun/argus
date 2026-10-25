/**
 * ARGUS HUD — plain-DOM situational-awareness overlay on top of the 3D city.
 * Layout: floating glass islands (top), feed column (left), impact + inspector column (right),
 * time / playback / views islands (bottom). Containers ignore the pointer; only panels capture it.
 */
import type {
  BuildingInfo,
  CameraPreset,
  CameraPresetId,
  CityData,
  EventBus,
  QuakeResult,
  QuakeScenario,
  UiHandle,
  UiHandlers,
  UsgsEvent,
} from '../contracts';
import { h } from './dom';
import { createTopBar } from './topbar';
import { createShakeAlert } from './alert';
import { createFeedPanel } from './feed';
import { createImpactPanel } from './impact';
import { createInspector } from './inspector';
import { createAirPanel } from './air';
import { createPlanCard } from './plan';
import { createDroneFeeds } from './droneFeeds';
import { createCopilot } from './copilot';
import { createReports } from './reports';
import type { WaveMark } from './timeline';
import { createFooter, createPlaybackIsland, createTimeIsland, createViewsIsland } from './bottombar';
import { bindKeyboard } from './keyboard';
import { fmtCompact, fmtInt, nightFactorFor, occupancyWeightDay } from './format';
import type { Phase, UiState } from './state';

export function createUI(root: HTMLElement, ctx: { city: CityData; events: EventBus }, handlers: UiHandlers): UiHandle {
  const params = new URLSearchParams(location.search);
  const state: UiState = {
    phase: 'monitoring',
    event: null,
    scenario: null,
    simSeconds: 0,
    playing: false,
    timeScale: Number(params.get('speed') ?? 1) || 1,
    timeOfDay: 16.5,
    overlay: (['none', 'shakemap', 'damage'] as const).find((m) => m === params.get('overlay')) ?? 'none',
    night: false,
  };

  // Wrap handlers so local state stays in sync with what we ask the app to do.
  const hd: UiHandlers = {
    ...handlers,
    onTimeOfDay(hours) {
      setTod(hours);
      handlers.onTimeOfDay(hours);
    },
    onOverlay(mode) {
      state.overlay = mode;
      handlers.onOverlay(mode);
    },
    onTimeScale(scale) {
      state.timeScale = scale;
      handlers.onTimeScale(scale);
    },
  };

  const top = createTopBar();
  const alert = createShakeAlert();
  const feed = createFeedPanel(hd);
  const impact = createImpactPanel(hd);
  impact.overlay.set(state.overlay);
  const inspector = createInspector(() => closeInspector());
  const air = createAirPanel(ctx.city);
  // M4 drones: Argon plan card (decision moment) + drone camera thumbnails, centre-right of the scene.
  const plan = createPlanCard(ctx.city, hd);
  const feeds = createDroneFeeds();
  const m4 = h('div', { class: 'ag-m4' }, plan.el, feeds.el);
  let waveMarks: WaveMark[] = [];
  const tod = createTimeIsland(hd);
  const pb = createPlaybackIsland(hd, state.timeScale);
  pb.setActive(false);
  const views = createViewsIsland(hd, (params.get('cam') as CameraPresetId | null) ?? 'overview');
  const foot = createFooter();
  // M5 Copilot: chat drawer over the right column (Impact / AIR hide while it is open, the inspector moves beside it).
  const copilot = createCopilot(hd, (open) => {
    app.classList.toggle('is-copilot', open);
    if (open) highlightLauncher(false);
  });
  const highlightLauncher = (on: boolean) => copilot.launcher.classList.toggle('is-nudge', on);
  // M6 resident reports: toasts beside the Seismic feed + COMMUNITY REPORTS card under it (folded while the feed is open).
  const reports = createReports(ctx.city, (item) => {
    const id = item.analysis?.buildingId;
    if (id) ctx.events.emit({ type: 'building-selected', id });
  });
  if (!feed.panel.collapsed) reports.panel.setCollapsed(true, false);
  const topRight = h('div', { class: 'ag-top__right' }, copilot.launcher);
  const clockEl = top.el.querySelector('.ag-clock');
  if (clockEl) {
    top.el.replaceChild(topRight, clockEl);
    topRight.append(clockEl);
  } else top.el.append(topRight);

  const right = h('aside', { class: 'ag-col ag-col--right' }, impact.el, air.el, inspector.el);
  const app = h(
    'div',
    { class: 'ag', dataset: { theme: 'day', phase: 'monitoring' } },
    top.el,
    h('div', { class: 'ag-alert-slot' }, alert.el),
    h('aside', { class: 'ag-col ag-col--left' }, feed.el, reports.el),
    right,
    m4,
    copilot.el,
    h('div', { class: 'ag-bottom' }, tod.el, pb.el, views.el),
    foot.el,
    feeds.lightbox,
  );
  root.classList.add('ag-root');
  root.replaceChildren(app);

  // ── Phase / theme ──
  function setPhase(p: Phase) {
    if (state.phase === p) return;
    state.phase = p;
    app.dataset.phase = p;
    top.setPhase(p);
    feed.setPhase(p);
    pb.setCaption({ monitoring: 'No event', alert: 'Waves inbound', shaking: 'Strong shaking', aftermath: 'Aftermath' }[p]);
  }

  function setTheme(night: boolean) {
    if (state.night === night) return;
    state.night = night;
    app.dataset.theme = night ? 'night' : 'day';
    window.setTimeout(() => feed.seismogram.refreshColors(), 650); // after the CSS colour transition
  }

  // ── Clock: scene time ticks in real time; during a quake it follows the simulation. ──
  let todSetAt = performance.now();
  function setTod(hours: number) {
    state.timeOfDay = hours;
    todSetAt = performance.now();
    tod.set(hours);
    setTheme(nightFactorFor(hours) > 0.5);
    refreshExposure();
    tickClock();
  }
  function tickClock() {
    const hours = state.scenario
      ? state.scenario.localHour + state.simSeconds / 3600
      : state.timeOfDay + (performance.now() - todSetAt) / 3.6e6;
    top.setClock(hours);
  }
  window.setInterval(tickClock, 250);

  // ── City exposure ──
  let cityTotals = { buildings: 0, day: 0, night: 0 };
  function refreshExposure() {
    const w = occupancyWeightDay(state.timeOfDay);
    impact.setIdleExposure(w * cityTotals.day + (1 - w) * cityTotals.night, cityTotals.buildings);
  }

  // ── Inspector ──
  let impactAutoCollapsed = false;
  let airFoldedImpact = false;
  let airAutoCollapsed = false;
  let shownId: string | null = null;
  function closeInspector(): boolean {
    if (!inspector.open) return false;
    inspector.show(null);
    restoreImpact();
    ctx.events.emit({ type: 'building-selected', id: null });
    return true;
  }
  function restoreImpact() {
    if (impactAutoCollapsed) impact.panel.setCollapsed(false, false);
    impactAutoCollapsed = false;
    if (airAutoCollapsed) air.panel.setCollapsed(false, false);
    airAutoCollapsed = false;
  }

  // ── Event bus ──
  ctx.events.on('quake-tick', ({ simSeconds }) => {
    state.simSeconds = simSeconds;
    top.setSimTime(simSeconds);
    pb.setSimTime(simSeconds);
    feed.seismogram.setSimTime(simSeconds);
    inspector.tick(simSeconds);
    // Time-driven fallback so the phase is right without a ShakeAlert (blind zone, small event) and
    // when playback seeks straight to a late moment: S arrival → shaking, end of strong motion → aftermath.
    const a = feed.seismogram.arrivals;
    if (!a || alert.visible) return;
    if (state.phase === 'alert' && simSeconds >= a.s) setPhase('shaking');
    if (state.phase === 'shaking' && simSeconds >= a.s + a.dur * 1.6) setPhase('aftermath');
    if (state.phase === 'aftermath' && simSeconds < a.s) setPhase('alert'); // seek backwards
  });
  ctx.events.on('quake-finished', () => {
    if (state.event) setPhase('aftermath');
  });
  ctx.events.on('quake-reset', () => resetUi());
  ctx.events.on('environment-changed', ({ env }) => setTheme(env.nightFactor > 0.5));
  ctx.events.on('overlay-changed', ({ overlay }) => {
    state.overlay = overlay;
    impact.overlay.set(overlay);
  });
  ctx.events.on('building-selected', ({ id }) => {
    if (id === null && inspector.open) {
      inspector.show(null);
      restoreImpact();
    }
  });

  function resetUi() {
    ui.showAir?.(null);
    ui.showPlan?.(null, 'done');
    ui.showDroneFeeds?.([]);
    reports.reset();
    waveMarks = [];
    air.setWaveMarks([]);
    inspector.setComparison(null);
    state.event = null;
    state.scenario = null;
    state.simSeconds = 0;
    alert.hide();
    feed.clearEvent();
    impact.update(null, 0);
    impact.setAwaiting(false);
    pb.setActive(false);
    top.setSimTime(null);
    setPhase('monitoring');
    tickClock();
  }

  // ── Keyboard ──
  bindKeyboard({
    pauseToggle: () => {
      if (state.event) hd.onPauseToggle();
    },
    reset: () => hd.onReset(),
    preset: (i) => views.goIndex(i),
    closeInspector,
    toggleHud: () => app.classList.toggle('is-hud-hidden'),
  });
  // M5: C toggles the Copilot drawer; Esc closes it (after the inspector, which bindKeyboard handles first).
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type)))) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      copilot.toggle();
    } else if (e.key === 'Escape' && copilot.open) {
      e.preventDefault();
      copilot.setOpen(false, true);
    }
  });

  const ui: UiHandle = {
    showReport(item) {
      reports.show(item);
    },
    setReports(items, stats) {
      reports.set(items, stats);
    },
    copilotSetMessages(messages, situation) {
      copilot.setMessages(messages, situation);
      // A new answer while the drawer is closed: nudge the launcher.
      if (!copilot.open && messages.length && messages[messages.length - 1].role === 'assistant') highlightLauncher(true);
    },
    copilotSetThinking(thinking) {
      copilot.setThinking(thinking);
    },
    copilotOpen(open) {
      copilot.setOpen(open, false);
    },
    showEvent(event: UsgsEvent, scenario: QuakeScenario) {
      state.event = event;
      state.scenario = scenario;
      state.simSeconds = 0;
      feed.showEvent(event, scenario);
      impact.setAwaiting(true);
      pb.setActive(true);
      pb.setSimTime(0);
      top.setSimTime(0);
      state.phase = 'monitoring'; // force the transition below to run even on a re-trigger
      setPhase('alert');
      tickClock();
    },
    showShakeAlert(secondsToShaking: number, expectedMmi: number) {
      alert.show(secondsToShaking, expectedMmi);
      feed.seismogram.setMmi(expectedMmi);
      if (state.phase === 'aftermath') return;
      setPhase(secondsToShaking > 0 ? 'alert' : 'shaking');
    },
    hideShakeAlert() {
      alert.hide();
      if (state.phase === 'shaking') setPhase('aftermath');
    },
    updateStats(stats: QuakeResult['stats'] | null, simSeconds: number) {
      impact.update(stats, simSeconds);
    },
    showBuilding(info: BuildingInfo | null) {
      if (!info) {
        inspector.show(null);
        restoreImpact();
        return;
      }
      // A refresh of the same building (main.ts re-shows it when its damage manifests) must not re-fold Impact
      // the user may have expanded meanwhile; only a newly opened / different building does.
      const isRefresh = inspector.open && shownId === info.record.id;
      shownId = info.record.id;
      inspector.show(info, state.simSeconds);
      if (isRefresh) return;
      // Keep the right column on screen: fold Impact to its header if both don't fit.
      requestAnimationFrame(() => {
        // The inspector may have been closed before this frame (fast Esc) — don't fold Impact then.
        if (!inspector.open) return;
        const need = impact.panel.head.offsetHeight + impact.panel.body.scrollHeight + inspector.el.offsetHeight + 12;
        if (!impact.panel.collapsed && need > right.clientHeight) {
          impact.panel.setCollapsed(true, false);
          impactAutoCollapsed = true;
        }
        // M3: fold the AIR panel too when the inspector still would not fit.
        if (air.active && !air.panel.collapsed && impact.panel.head.offsetHeight + air.panel.el.offsetHeight + inspector.el.scrollHeight + 22 > right.clientHeight) {
          air.panel.setCollapsed(true, false);
          airAutoCollapsed = true;
        }
      });
    },
    setTimeOfDay(hours: number) {
      setTod(hours);
    },
    setPlaying(playing: boolean) {
      state.playing = playing;
      pb.setPlaying(playing);
    },
    setScenarios(scenarios: QuakeScenario[]) {
      feed.setScenarios(scenarios);
    },
    setCameraPresets(presets: CameraPreset[]) {
      views.setPresets(presets);
    },
    showAir(s) {
      const wasActive = air.active;
      air.set(s);
      // First launch: fold Impact to its header so the reconstruction panel has room (not remembered).
      if (s && !wasActive && !impact.panel.collapsed) {
        impact.panel.setCollapsed(true, false);
        airFoldedImpact = true;
      }
      if (!s && airFoldedImpact) {
        airFoldedImpact = false;
        impact.panel.setCollapsed(false, false);
      }
    },
    showComparison(c) {
      inspector.setComparison(c);
    },
    showPlan(p, s, info) {
      plan.set(p, s, info);
      // Approved wave → vertical marker on the AIR accuracy timeline.
      if (p && (s === 'approved' || s === 'executing') && !waveMarks.some((m) => m.wave === p.wave)) {
        const starts = (info?.schedule ?? []).filter((e) => p.missions.some((m) => m.id === e.missionId)).map((e) => e.startS);
        waveMarks = [...waveMarks, { wave: p.wave, simS: starts.length ? Math.min(...starts) : (info?.simS ?? p.createdAtSimS) }];
        air.setWaveMarks(waveMarks);
      }
    },
    showDroneFeeds(f) {
      feeds.set(f);
    },
    setCityStats(city: CityData) {
      let buildings = 0;
      let day = 0;
      let night = 0;
      for (const b of city.buildings) {
        if (!b.isPart) buildings++;
        day += b.occupantsDay || 0;
        night += b.occupantsNight || 0;
      }
      cityTotals = { buildings, day, night };
      foot.setStats(`${fmtInt(buildings)} buildings  ·  ${fmtCompact(day)} people by day  ·  ${fmtCompact(night)} at night`);
      refreshExposure();
    },
  };

  watchFrameRate(app, params.get('glass'));

  top.setPhase('monitoring');
  feed.setPhase('monitoring');
  setTod(state.timeOfDay);
  // One orchestrated entrance; skipped for reduced motion via CSS.
  requestAnimationFrame(() => app.classList.add('is-ready'));
  return ui;
}

/**
 * Adaptive glass. backdrop-filter re-samples the WebGL canvas every frame under each panel; if the app
 * sustains < 50 fps for 4 s (after a warm-up), fall back to opaque "solid glass" — same look, no blur.
 * (Integration: threshold raised from 38 → 50. Measured at 1600×900 the blur alone cost 60 → 44 fps in headless
 * Chromium and 60 → 15 in headless Chrome; blur is only kept when the GPU has clear headroom.)
 * ?glass=solid forces the fallback, ?glass=blur disables the guard.
 */
function watchFrameRate(app: HTMLElement, mode: string | null): void {
  if (mode === 'solid') {
    app.classList.add('is-lite');
    return;
  }
  if (mode === 'blur') return;
  const warmUpUntil = performance.now() + 6000;
  let frames = 0;
  let t0 = performance.now();
  let slow = 0;
  const loop = (now: number) => {
    frames++;
    if (now - t0 >= 1000) {
      const fps = (frames * 1000) / (now - t0);
      frames = 0;
      t0 = now;
      if (now > warmUpUntil && !document.hidden) slow = fps < 50 ? slow + 1 : 0;
      if (slow >= 4) {
        app.classList.add('is-lite');
        console.info(`[ui] sustained ${fps.toFixed(0)} fps — switching HUD to solid glass (no backdrop blur)`);
        return;
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
