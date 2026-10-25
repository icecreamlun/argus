#!/usr/bin/env node
/**
 * End-to-end test of the whole Argus app through its real UI (headless Chromium on the real GPU, like shot.mjs).
 *
 *   node scripts/e2e.mjs [--base http://127.0.0.1:5173] [--out shots/e2e] [--w 1600 --h 900] [--quick] [--chrome]
 *
 * Flow: load → ready → no console errors → every camera-preset button → time-of-day (Day marker, golden hour
 * via the slider, night via a real click on the slider track) → pick a building by clicking the canvas
 * (inspector opens) → every scenario via its Simulate button at 2× → pause / resume → overlays
 * None / ShakeMap / Damage → let HayWired finish → M3 AIR 1 (air=mock: helicopter, veil, recon panel, seek
 * time-gate) → Reset → verify the city, HUD and AIR state are restored → M4 drones (air=mock: Argon plan card
 * pauses the sim, Approve via the button, drones fly, accuracy timeline gains a drone point, Reset clears it) →
 * M5 Copilot (air=mock: open the drawer, quick prompt → plan card, routes auto-shown, Show on map re-draws,
 * Dispatch moves units, Reset clears chat + layer).
 * Screenshots and an fps sample are taken at each checkpoint. Exits 1 on any failed check, console
 * error, page error or WebGL/shader warning. The dev server must be running.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const base = opt('base', 'http://127.0.0.1:5173');
const outDir = resolve(opt('out', 'shots/e2e'));
const W = Number(opt('w', 1600));
const H = Number(opt('h', 900));
const quick = flag('quick');
// --chrome: installed Google Chrome in new-headless mode (same GPU compositor as desktop Chrome) instead of
// Playwright's headless shell. Closer to the real target for fps and HUD (backdrop-filter) costs.
const useChrome = flag('chrome');
mkdirSync(outDir, { recursive: true });

// ───────────────────────── harness ─────────────────────────
const failures = [];
const consoleProblems = [];
const notes = [];
const fpsTable = [];
let current = 'boot';

const isFatalWarning = (t) => /GL_INVALID|WebGL: |Shader Error|THREE\.WebGLProgram|THREE\.WebGLRenderer: .*error|context lost/i.test(t);

const browser = await chromium.launch({
  headless: true,
  ...(useChrome ? { channel: 'chrome' } : {}),
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Swallow the Vite HMR websocket so concurrent source edits don't full-reload the page mid-test.
await page.routeWebSocket(/token=/, () => {});
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') consoleProblems.push(`[${current}] console.error: ${t}`);
  else if (m.type() === 'warning') (isFatalWarning(t) ? consoleProblems : notes).push(`[${current}] console.warn: ${t}`);
});
page.on('pageerror', (e) => consoleProblems.push(`[${current}] pageerror: ${e.message}`));
page.on('crash', () => consoleProblems.push(`[${current}] page crashed`));

function check(cond, msg) {
  if (!cond) {
    failures.push(`[${current}] ${msg}`);
    console.log(`   ✘ ${msg}`);
  }
  return !!cond;
}

async function step(name, fn) {
  current = name;
  const t0 = Date.now();
  const f0 = failures.length;
  const c0 = consoleProblems.length;
  try {
    await fn();
  } catch (e) {
    failures.push(`[${name}] threw: ${String(e?.message ?? e).split('\n')[0]}`);
    console.log(`   ✘ threw: ${String(e?.message ?? e).split('\n').slice(0, 3).join(' | ')}`);
  }
  const bad = failures.length - f0 + consoleProblems.length - c0;
  console.log(`${bad ? '✘' : '✔'} ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const p of consoleProblems.slice(c0, c0 + 8)) console.log(`     ${p.slice(0, 400)}`);
}

const A = (fn, arg) => page.evaluate(fn, arg);

/** Wait until n new frames have been rendered (shader compiles can stall the loop for seconds). */
async function freshFrames(n = 5, timeout = 60000) {
  const f0 = await A(() => window.__argus.frame);
  await page.waitForFunction((f) => window.__argus.frame >= f, f0 + n, { timeout });
}

/** Measure fps over `ms` from the app's own frame counter. */
async function sampleFps(label, ms = 2000) {
  await freshFrames(3);
  const r = await A(async (ms) => {
    const f0 = window.__argus.frame;
    const t0 = performance.now();
    await new Promise((res) => setTimeout(res, ms));
    const frames = window.__argus.frame - f0;
    const secs = (performance.now() - t0) / 1000;
    const p = window.__argus.perf ?? {};
    return { fps: frames / secs, calls: p.calls, tris: p.triangles, pr: p.pixelRatio, frameMs: p.frameMs };
  }, ms);
  const row = { label, fps: Math.round(r.fps * 10) / 10, calls: r.calls, trisM: r.tris ? Math.round(r.tris / 1e4) / 100 : null, pr: r.pr };
  fpsTable.push(row);
  console.log(`     fps ${row.fps.toFixed(1).padStart(5)}  calls ${String(row.calls).padStart(4)}  tris ${row.trisM}M  pr ${row.pr}   ${label}`);
  return row.fps;
}

async function shot(name) {
  await freshFrames(3);
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path });
  return path;
}

const uiState = () =>
  A(() => {
    const app = document.querySelector('.ag');
    const insp = document.querySelector('.ag-insp');
    const alert = document.querySelector('.ag-alert');
    return {
      phase: app?.dataset.phase,
      theme: app?.dataset.theme,
      inspectorOpen: !!insp && !insp.hidden,
      inspectorTitle: insp?.querySelector('.ag-insp__title')?.textContent ?? null,
      inspectorDamage: !!insp?.querySelector('.ag-dsbadge'),
      inspectorPending: !!insp?.querySelector('.ag-insp__damage--pending'),
      alertVisible: !!alert && !alert.hidden,
      eventCard: !!document.querySelector('.ag-feed__event .ag-event'),
      pbActive: document.querySelector('.ag-pb')?.dataset.active,
      pbPlaying: document.querySelector('.ag-pb')?.dataset.playing,
      pbClock: document.querySelector('.ag-pb__clock')?.textContent,
      overlayOn: document.querySelector('.ag-overlay .ag-seg__btn.is-on')?.dataset.v,
      speedOn: document.querySelector('.ag-pb .ag-seg__btn.is-on')?.dataset.v,
      viewOn: document.querySelector('.ag-view.is-on .ag-view__label')?.textContent,
      trapped: document.querySelector('.ag-hero__num')?.textContent,
    };
  });

const appState = () =>
  A(() => {
    const a = window.__argus;
    const { engine, fx, buildings, landmarks } = a.handles;
    const cam = engine.camera.position;
    let nonDefault = 0;
    const replaced = new Set(landmarks.replacedBuildingIds);
    const ids = a.ctx.city.buildings;
    for (let i = 0; i < buildings.count; i++) {
      const s = buildings.getState(i);
      const hiddenOk = replaced.has(ids[i].id) ? s.hidden > 0.5 : s.hidden < 0.5;
      if (s.shakeX || s.shakeZ || s.tiltX || s.tiltZ || s.crush || s.damage || s.lightsOut || !hiddenOk) nonDefault++;
    }
    const root = a.ctx.cityRoot.position;
    return {
      tod: engine.env.timeOfDay,
      night: engine.env.nightFactor,
      haze: engine.env.haze,
      cam: [cam.x, cam.y, cam.z],
      simSeconds: fx.simSeconds,
      playing: fx.playing,
      result: a.result ? a.result.scenario.id : null,
      durationS: a.result?.durationS ?? null,
      nonDefault,
      cityRootOffset: Math.hypot(root.x, root.y, root.z),
      selected: a.selected,
      fxStats: fx.debug?.stats?.(),
    };
  });

// ───────────────────────── 1. load ─────────────────────────
await step('load', async () => {
  const t0 = Date.now();
  // air=mock: deterministic Argon results, no network (the live Gemini path is exercised by shots/integration-m3/live.mjs).
  await page.goto(`${base}/?tod=14&air=mock`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__argus && (window.__argus.ready || window.__argus.error), null, { timeout: 120000 });
  const err = await A(() => window.__argus.error);
  check(!err, `boot error: ${err}`);
  await freshFrames(10);
  const timings = await A(() => window.__argus.timings);
  console.log(`     ready in ${Date.now() - t0} ms; boot timings ${JSON.stringify(timings)}`);
  await page.waitForTimeout(1200);
  check(!(await A(() => !!document.getElementById('boot'))), 'boot screen still present after ready');
  const ui = await uiState();
  check(ui.phase === 'monitoring', `phase is ${ui.phase}, expected monitoring`);
  check(ui.pbActive === 'false', 'playback island should be inactive before any event');
  const n = await A(() => document.querySelectorAll('.ag-scn').length);
  check(n >= 3, `expected ≥3 scenario cards, got ${n}`);
  await shot('01-load');
  await sampleFps('load / overview day (HUD on)');
});

// ───────────────────────── 2. camera presets ─────────────────────────
const presetIds = await A(() => window.__argus.handles.engine.cameraPresets.map((p) => p.id));
await step('camera presets', async () => {
  const buttons = page.locator('.ag-views__list .ag-view');
  const count = await buttons.count();
  check(count === presetIds.length, `expected ${presetIds.length} view buttons, got ${count}`);
  for (let i = 0; i < count; i++) {
    const id = presetIds[i];
    await buttons.nth(i).click();
    await page.waitForTimeout(3000); // 2.5 s flight
    const st = await appState();
    const want = await A((id) => window.__argus.handles.engine.cameraPresets.find((p) => p.id === id).position, id);
    const d = Math.hypot(st.cam[0] - want[0], st.cam[1] - want[1], st.cam[2] - want[2]);
    check(d < 5, `camera ${id} ended ${d.toFixed(1)} m from its preset position`);
    const ui = await uiState();
    check(!!ui.viewOn, `no active view chip after clicking ${id}`);
    await shot(`02-cam-${id}`);
    if (!quick || id === 'overview' || id === 'street') await sampleFps(`preset ${id} (day 14:00)`, 1500);
  }
});

// ───────────────────────── 3. time of day ─────────────────────────
await step('time of day', async () => {
  await page.locator('.ag-view', { hasText: 'Overview' }).click();
  await page.waitForTimeout(3000);
  // Day marker button.
  await page.locator('.ag-tod__mark', { hasText: 'Day' }).click();
  await freshFrames(5);
  let st = await appState();
  check(Math.abs(st.tod - 12) < 0.01, `Day marker → tod ${st.tod}, expected 12`);
  check(st.night < 0.1, `Day marker → nightFactor ${st.night}`);
  await shot('03-tod-day');
  await sampleFps('overview day 12:00');

  // Golden hour via the slider's input events (how a drag reports).
  await A(() => {
    const el = document.querySelector('.ag-tod__range');
    el.value = '17.6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await freshFrames(8);
  st = await appState();
  check(Math.abs(st.tod - 17.6) < 0.01, `slider → tod ${st.tod}, expected 17.6`);
  await shot('03-tod-golden');
  await sampleFps('overview golden 17:36');

  // Night via a real mouse click on the slider track.
  const box = await page.locator('.ag-tod__range').boundingBox();
  await page.mouse.click(box.x + box.width * (22 / 24), box.y + box.height / 2);
  await freshFrames(8);
  await page.waitForTimeout(800);
  st = await appState();
  check(Math.abs(st.tod - 22) < 1.0, `slider click → tod ${st.tod}, expected ≈22`); // thumb inset shifts the mapping
  check(st.night > 0.5, `night → nightFactor ${st.night}`);
  const ui = await uiState();
  check(ui.theme === 'night', `HUD theme ${ui.theme} at night`);
  await shot('03-tod-night');
  await sampleFps('overview night 22:00');
});

// ───────────────────────── 4. select a building by clicking the canvas ─────────────────────────
let pickedId = null;
await step('select building', async () => {
  // Back to day for the street-level work.
  await A(() => {
    const el = document.querySelector('.ag-tod__range');
    el.value = '14';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.ag-view', { hasText: 'Chinatown' }).click();
  await page.waitForTimeout(3200);
  // Find a screen point near the centre where the canvas (not a HUD panel) is on top and a building is hit.
  const target = await A(() => {
    const { engine, buildings } = window.__argus.handles;
    const THREE = window.__argus.engineDebug.THREE;
    const rc = new THREE.Raycaster();
    const canvas = engine.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    for (let ring = 0; ring < 12; ring++) {
      for (let k = 0; k < Math.max(1, ring * 8); k++) {
        const a = (k / Math.max(1, ring * 8)) * Math.PI * 2;
        const x = r.left + r.width / 2 + Math.cos(a) * ring * 28;
        const y = r.top + r.height * 0.45 + Math.sin(a) * ring * 22;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), engine.camera);
        const id = buildings.pick(rc);
        if (id) return { x, y, id };
      }
    }
    return null;
  });
  if (!check(target, 'no clickable building found near the screen centre')) return;
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(600);
  const ui = await uiState();
  const st = await appState();
  check(st.selected === target.id, `clicked ${target.id}, selected ${st.selected}`);
  check(ui.inspectorOpen, 'inspector did not open');
  check(!!ui.inspectorTitle, 'inspector has no title');
  pickedId = st.selected;
  console.log(`     picked ${target.id} → "${ui.inspectorTitle}"`);
  await shot('04-select');
  // Esc closes the inspector and clears the selection (and highlight).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(!(await uiState()).inspectorOpen, 'Esc did not close the inspector');
  check((await appState()).selected === null, 'Esc did not clear the selection');
  // Re-select for the quake (checks the inspector refreshes live when damage manifests).
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(400);
  check((await appState()).selected === target.id, 're-select failed');
});

// ───────────────────────── 5. scenarios ─────────────────────────
const scenarioIds = await A(() => [...document.querySelectorAll('.ag-scn')].map((c) => c.dataset.id));

async function simulate(id) {
  // After an event the feed folds its scenario list away; open it like a user would.
  const btn = page.locator(`.ag-scn[data-id="${id}"] button`);
  if ((await page.locator('.ag-section--scenarios').getAttribute('data-open')) !== 'true') {
    await page.locator('.ag-section--scenarios .ag-disclosure').click();
    await page.waitForTimeout(500);
  }
  await btn.click({ timeout: 10000 });
  await freshFrames(3);
}

/** Overlay switch lives in the Impact panel, which folds when the inspector needs the room. */
async function clickOverlay(mode) {
  const btn = page.locator(`.ag-overlay .ag-seg__btn[data-v="${mode}"]`);
  if ((await page.locator('.ag-impact').getAttribute('data-collapsed')) === 'true') {
    await page.locator('.ag-impact .ag-panel__toggle').click();
    await page.waitForTimeout(500);
  }
  await btn.click({ timeout: 10000 });
}

await step('speed 2×', async () => {
  await page.locator('.ag-pb .ag-seg__btn[data-v="2"]').click();
  check((await uiState()).speedOn === '2', 'speed 2× chip not active');
});

for (const id of scenarioIds) {
  await step(`scenario ${id}`, async () => {
    const night = id === 'san_andreas_1906';
    // 1906 is the perf worst case: play it at night from the overview; the others in daylight.
    await A((h) => window.__argus.setTimeOfDay(h), night ? 22 : 14);
    await page.locator('.ag-view', { hasText: night ? 'Overview' : 'Chinatown' }).click();
    await page.waitForTimeout(2800);
    const tClick = Date.now();
    await simulate(id);
    let st = await appState();
    let ui = await uiState();
    check(st.result === id, `result is ${st.result}, expected ${id}`);
    check(ui.eventCard, 'USGS event card not shown');
    check(ui.pbActive === 'true', 'playback island not active');
    check(ui.pbPlaying === 'true', 'play button not in playing state');
    const s0 = st.simSeconds;
    await page.waitForTimeout(3000);
    st = await appState();
    const rate = (st.simSeconds - s0) / 3;
    check(rate > 1.2 && rate < 2.6, `sim advanced at ${rate.toFixed(2)}×, expected ≈2×`);
    console.log(`     trigger→+3 s: T+${st.simSeconds.toFixed(1)} s, phase ${(await uiState()).phase}, ${Date.now() - tClick} ms wall`);
    await shot(`05-${id}-early`);

    // Peak shaking at the city: seek the clock just past the centre S arrival and play on.
    const peak = await A(() => {
      const r = window.__argus.result;
      return r.shakeAlert.issuedAtS + Math.max(0, r.shakeAlert.warningSecondsAtCentre) + 6;
    });
    if (st.simSeconds < peak) await page.waitForFunction((p) => window.__argus.handles.fx.simSeconds >= p, peak, { timeout: 60000 });
    ui = await uiState();
    check(['shaking', 'aftermath'].includes(ui.phase), `phase ${ui.phase} at peak`);
    await shot(`05-${id}-peak`);
    await sampleFps(`${id} peak shaking (${night ? 'night 22:00, overview' : 'day 14:00, chinatown'})`, 2500);

    if (pickedId && id === scenarioIds[0]) {
      // Inspector should have swapped "pending" for a damage badge once this building's damage manifested.
      const failT = await A((pid) => {
        const i = window.__argus.handles.buildings.indexOf(pid);
        return window.__argus.result.damage[i].failTimeS;
      }, pickedId);
      if (failT <= (await appState()).simSeconds) {
        await page.waitForTimeout(300);
        check((await uiState()).inspectorDamage, `inspector did not refresh with damage (failT ${failT.toFixed(1)} s)`);
      } else notes.push(`[${current}] picked building fails at ${failT.toFixed(1)} s; live refresh not exercised yet`);
    }

    // Pause / resume via the play button.
    await page.locator('.ag-play').click();
    await page.waitForTimeout(200);
    const p0 = (await appState()).simSeconds;
    await page.waitForTimeout(1200);
    const p1 = (await appState()).simSeconds;
    check(Math.abs(p1 - p0) < 1e-6, `clock moved while paused (${p0.toFixed(2)} → ${p1.toFixed(2)})`);
    check((await uiState()).pbPlaying === 'false', 'play button still shows playing after pause');
    // Speed change while paused must stick on resume.
    await page.locator('.ag-pb .ag-seg__btn[data-v="4"]').click();
    await page.locator('.ag-play').click();
    await page.waitForTimeout(1000);
    const p2 = (await appState()).simSeconds;
    check(p2 - p1 > 2.4, `after resume at 4× the clock advanced only ${(p2 - p1).toFixed(2)} s in 1 s`);
    check((await uiState()).pbPlaying === 'true', 'play button not playing after resume');
    await page.locator('.ag-pb .ag-seg__btn[data-v="2"]').click();
    // Keyboard: Space toggles too.
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    check((await uiState()).pbPlaying === 'false', 'Space did not pause');
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    check((await uiState()).pbPlaying === 'true', 'Space did not resume');

    // Overlays.
    for (const mode of ['shakemap', 'damage', 'none']) {
      await clickOverlay(mode);
      await freshFrames(4);
      check((await uiState()).overlayOn === mode, `overlay chip ${mode} not active`);
      if (mode !== 'none' && (!quick || night)) await shot(`05-${id}-overlay-${mode}`);
    }
    if (night) await sampleFps(`${id} aftermath (night)`, 1500);
  });
}

// ───────────────────────── 6. play to the end ─────────────────────────
await step('play to finish (hayward)', async () => {
  const id = scenarioIds.find((s) => s.includes('hayward')) ?? scenarioIds[0];
  await page.locator('.ag-pb .ag-seg__btn[data-v="4"]').click();
  await simulate(id);
  const dur = await A(() => window.__argus.result.durationS);
  await page.waitForFunction((d) => window.__argus.handles.fx.simSeconds > d + 1, dur, { timeout: (dur / 4 + 30) * 1000 });
  await page.waitForTimeout(500);
  const ui = await uiState();
  const st = await appState();
  check(ui.phase === 'aftermath', `phase ${ui.phase} after the event, expected aftermath`);
  check(!st.playing, 'fx.playing still true after durationS');
  check(!ui.alertVisible, 'ShakeAlert banner still visible in the aftermath');
  if (pickedId) {
    // main.ts re-shows the selected building when its damage manifests: the inspector must carry it by now.
    const failT = await A((pid) => window.__argus.result.damage[window.__argus.handles.buildings.indexOf(pid)].failTimeS, pickedId);
    if (failT <= st.simSeconds) check(ui.inspectorDamage, `inspector did not refresh with damage (failT ${failT.toFixed(1)} s, T+${st.simSeconds.toFixed(1)} s)`);
    else notes.push(`[${current}] picked building fails at ${failT.toFixed(1)} s > T+${st.simSeconds.toFixed(1)}; live refresh not exercised`);
  }
  await shot('06-finished');
  await page.locator('.ag-pb .ag-seg__btn[data-v="2"]').click();
});

// ───────────────────────── 6b. M3: AIR 1 aerial recon (mock) ─────────────────────────
const airState = () =>
  A(() => {
    const a = window.__argus;
    const { heli, scan, recon, people } = a.handles;
    const panel = document.querySelector('.ag-air__status')?.closest('.ag-panel');
    const st = recon.stats();
    // Veiled = core buildings not yet scanned (scan veils them slightly grey).
    let veiled = 0;
    if (scan.coverageT !== null) a.ctx.city.buildings.forEach((b, i) => !b.isPart && !b.context && !scan.isScanned(i) && veiled++);
    return {
      heliVisible: heli.object.visible,
      flightTime: heli.flightTime,
      scanVisible: scan.object.visible,
      coverageT: scan.coverageT,
      scanned: scan.scannedFraction(),
      chunksDone: st.chunksDone,
      observed: st.buildingsObserved,
      reconAcc: st.reconAccuracy,
      predAcc: st.predictionAccuracy,
      mode: st.mode,
      panelVisible: !!panel && !panel.hidden && panel.offsetParent !== null,
      status: document.querySelector('.ag-air__status')?.textContent?.trim() ?? null,
      bigNum: document.querySelector('.ag-air__bignum--argon')?.textContent ?? null,
      peopleTruth: people.truth ? people.truth.persons.length : null,
      pins: document.querySelectorAll('.ag-pin, [class*="pin"]').length,
      veiled,
    };
  });
await step('M3 air recon (mock)', async () => {
  await page.locator('.ag-pb .ag-seg__btn[data-v="2"]').click();
  await A(() => {
    window.__argus.trigger('san_andreas_1906');
    window.__argus.pause();
    window.__argus.seek(30);
  });
  await freshFrames(5);
  let a = await airState();
  check(!a.heliVisible, 'helicopter visible before launch (t=30)');
  check(a.coverageT === null, `scan coverage active before launch (${a.coverageT})`);
  check(a.peopleTruth > 0, `no truth people generated (${a.peopleTruth})`);
  await A(() => window.__argus.seek(100));
  await freshFrames(5);
  a = await airState();
  check(a.heliVisible && Math.abs(a.flightTime - 50) < 0.01, `helicopter not flying at t=100 (visible ${a.heliVisible}, flight ${a.flightTime})`);
  check(a.scanVisible && a.scanned > 0.1, `veil/coverage missing at t=100 (visible ${a.scanVisible}, scanned ${a.scanned})`);
  check(a.veiled > 100, `expected unscanned (veiled) core buildings at t=100, got ${a.veiled}`);
  check(a.chunksDone >= 3 && a.observed > 50, `recon not applied at t=100 (chunks ${a.chunksDone}, observed ${a.observed})`);
  check(a.mode === 'mock', `recon mode ${a.mode}, expected mock`);
  check(a.panelVisible, 'AIR 1 panel not visible at t=100');
  check(/scanning/i.test(a.status ?? ''), `AIR status '${a.status}' at t=100, expected Scanning`);
  await shot('06b-air-t100');
  await A(() => window.__argus.seek(175));
  await freshFrames(5);
  const end = await airState();
  check(!end.heliVisible, 'helicopter still visible after the flight');
  check(end.chunksDone > a.chunksDone, `no new chunks after the flight (${end.chunksDone} vs ${a.chunksDone})`);
  check(/complete/i.test(end.status ?? ''), `AIR status '${end.status}' after the flight, expected Complete`);
  check(end.reconAcc > end.predAcc, `mock Argon accuracy ${end.reconAcc} not above prediction ${end.predAcc}`);
  console.log(`     t=175: ${end.observed} observed, prediction ${(end.predAcc * 100).toFixed(0)}% → Argon ${(end.reconAcc * 100).toFixed(0)}%, scanned ${(end.scanned * 100).toFixed(0)}%`);
  await shot('06b-air-t175');
  // Time gate: seeking back hides later results (pure function of simSeconds).
  await A(() => window.__argus.seek(70));
  await freshFrames(3);
  const back = await airState();
  check(back.chunksDone < end.chunksDone, `seek back did not hide later chunks (${back.chunksDone} vs ${end.chunksDone})`);
  await A(() => window.__argus.seek(175));
  await freshFrames(3);
  // The AIR panel folds Impact on launch: fold AIR and unfold Impact like a user would (the reset step uses the
  // overlay buttons; AIR + Impact + an open inspector do not fit the right column at 900 px).
  const airToggle = page.locator('.ag-panel', { has: page.locator('.ag-air__status') }).locator('.ag-panel__toggle[aria-expanded="true"]');
  if (await airToggle.count()) await airToggle.first().click();
  const impactToggle = page.locator('.ag-panel', { has: page.locator('.ag-overlay') }).locator('.ag-panel__toggle[aria-expanded="false"]');
  if (await impactToggle.count()) await impactToggle.first().click();
  await page.waitForTimeout(400);
});

// ───────────────────────── 7. reset ─────────────────────────
await step('reset', async () => {
  await clickOverlay('damage');
  await page.locator('.ag-feed__foot .ag-btn').click();
  await page.waitForTimeout(800);
  await freshFrames(5);
  const st = await appState();
  const ui = await uiState();
  check(st.result === null, `result not cleared (${st.result})`);
  check(st.simSeconds === 0, `fx clock ${st.simSeconds} after reset`);
  check(st.nonDefault === 0, `${st.nonDefault} buildings still in a non-default state`);
  check(st.cityRootOffset < 1e-6, `cityRoot offset ${st.cityRootOffset}`);
  check(st.haze < 0.05, `haze ${st.haze} after reset`);
  check(ui.phase === 'monitoring', `phase ${ui.phase} after reset`);
  check(!ui.alertVisible, 'ShakeAlert visible after reset');
  check(!ui.eventCard, 'event card still shown after reset');
  check(ui.pbActive === 'false', 'playback island still active after reset');
  // FX meshes: nothing visible should remain under the fx root.
  const visible = await A(() => {
    const out = [];
    window.__argus.handles.fx.object.traverseVisible((o) => {
      if ((o.isMesh || o.isPoints || o.isLineSegments) && (o.count ?? 1) > 0 && o.geometry?.drawRange?.count !== 0) out.push(o.name || o.type);
    });
    return out;
  });
  check(visible.length === 0, `fx objects still visible after reset: ${visible.slice(0, 8).join(', ')}`);
  // M3: helicopter, veil, recon and AIR panel cleared.
  const air = await airState();
  check(!air.heliVisible, 'helicopter visible after reset');
  check(!air.scanVisible && air.coverageT === null, 'scan veil still active after reset');
  check(air.chunksDone === 0 && air.observed === 0, `recon not cleared (chunks ${air.chunksDone}, observed ${air.observed})`);
  check(!air.panelVisible, 'AIR 1 panel still visible after reset');
  check(air.peopleTruth === null, 'truth people not cleared after reset');
  // Selection survives a reset and the inspector drops the quake section.
  if (pickedId) check(!(await uiState()).inspectorDamage, 'inspector still shows damage after reset');
  await page.keyboard.press('Escape');
  await A(() => window.__argus.setTimeOfDay(14));
  await page.locator('.ag-view', { hasText: 'Overview' }).click();
  await page.waitForTimeout(3000);
  await shot('07-reset');
  await sampleFps('overview day after reset');
});

// ───────────────────────── 8. M4: Argon-planned drone verification (mock) ─────────────────────────
const m4State = () =>
  A(() => {
    const a = window.__argus;
    const { fleet, recon, fx } = a.handles;
    const card = document.querySelector('.ag-plan');
    const feeds = document.querySelector('.ag-dfeeds');
    const st = recon.stats();
    return {
      sim: fx.simSeconds,
      fxPlaying: fx.playing,
      card: card && !card.hidden ? card.dataset.state : null,
      planState: a.drones?.planState ?? null,
      schedule: fleet.schedule().length,
      fleetVisible: fleet.object.visible,
      phases: fleet.posesAt(fx.simSeconds).map((p) => p.phase),
      feedsVisible: !!feeds && !feeds.hidden,
      history: (st.history ?? []).length,
      droneHistory: (st.history ?? []).filter((h) => h.source === 'drone').length,
      droneObserved: st.droneObserved ?? 0,
      waves: (a.drones?.waves ?? []).map((w) => `${w.wave}:${w.decision}`),
      firstLeave: Math.min(...fleet.schedule().flatMap((e) => e.targets.map((t) => t.leaveS))),
    };
  });
await step('M4 drones (mock)', async () => {
  await page.locator('.ag-pb .ag-seg__btn[data-v="4"]').click();
  await A(() => window.__argus.trigger('san_andreas_1906'));
  // Wave 1 is planned once ≥ 2 heli chunks are revealed (mock: ~T+80 s) → the sim pauses on the proposed card.
  await page.waitForSelector('.ag-plan[data-state="proposed"]', { timeout: 90000 });
  await page.waitForTimeout(600);
  let m = await m4State();
  check(m.planState === 'proposed', `plan state ${m.planState}, expected proposed`);
  check(!m.fxPlaying, 'sim not paused while the plan awaits approval');
  check(m.schedule === 0, `drones scheduled before approval (${m.schedule})`);
  await shot('08-m4-plan-proposed');
  await page.locator('.ag-plan__approve').click();
  await page.waitForTimeout(800);
  m = await m4State();
  check(m.schedule >= 1, `no drone missions scheduled after Approve (${m.schedule})`);
  check(m.fxPlaying, 'sim did not resume after Approve');
  check(m.card === 'executing', `plan card '${m.card}' after Approve, expected executing`);
  check(m.feedsVisible, 'drone feed strip not shown after Approve');
  check(m.waves.includes('1:approved'), `wave 1 not recorded as approved (${m.waves})`);
  const h0 = m.history;
  // Drones fly: wait until one is in the air, then jump past the first target's orbit (deterministic mock result).
  await page.waitForFunction(() => window.__argus.handles.fleet.posesAt(window.__argus.handles.fx.simSeconds).some((p) => p.phase === 'transit' || p.phase === 'orbit'), null, { timeout: 60000 });
  await A((t) => window.__argus.seek(t), m.firstLeave + 2);
  await freshFrames(5);
  m = await m4State();
  check(m.phases.some((p) => p === 'transit' || p === 'orbit' || p === 'return'), `no drone flying after the first orbit (${m.phases})`);
  check(m.droneHistory >= 1 && m.history > h0, `accuracy timeline did not grow with a drone point (history ${h0} → ${m.history}, drone ${m.droneHistory})`);
  check(m.droneObserved >= 1, `no drone observation applied (${m.droneObserved})`);
  const timeline = await A(() => !!document.querySelector('.ag-air svg, .ag-tl svg, [class*="timeline"] svg'));
  check(timeline, 'accuracy timeline svg missing');
  await shot('08-m4-drones');
  await sampleFps('M4 drones flying (mock)');
  // Reset clears drones, plan card, feeds.
  await page.locator('.ag-feed__foot .ag-btn').click();
  await page.waitForTimeout(800);
  m = await m4State();
  check(m.schedule === 0, `drone schedule not cleared after reset (${m.schedule})`);
  check(!m.fleetVisible || m.phases.every((p) => p === 'idle'), 'drones still flying after reset');
  check(m.card === null, `plan card '${m.card}' still visible after reset`);
  check(!m.feedsVisible, 'drone feeds still visible after reset');
  check(m.waves.length === 0, `waves not cleared after reset (${m.waves})`);
  await page.locator('.ag-pb .ag-seg__btn[data-v="1"]').click();
});

// ───────────────────────── 9. M5: Argus Copilot (mock) ─────────────────────────
const m5State = () =>
  A(() => {
    const a = window.__argus;
    const { rescue } = a.handles;
    const c = a.copilot;
    const last = c?.messages.at(-1);
    return {
      open: !!document.querySelector('.ag.is-copilot'),
      messages: c?.messages.length ?? 0,
      log: c?.log.length ?? 0,
      mode: last?.mode ?? null,
      planState: last?.planState ?? null,
      hasPlan: !!last?.plan,
      cards: document.querySelectorAll('.ag-cpl').length,
      routed: c?.routed.length ?? 0,
      layerVisible: !!rescue?.object.visible,
      dispatched: !!rescue?.dispatched,
      invalid: c?.log.at(-1)?.invalidIds ?? [],
      routes: c?.log.at(-1)?.routes ?? 0,
    };
  });
await step('M5 copilot (mock)', async () => {
  // A quake with Argon recon to reason about: San Andreas at T+12:40 (mock helicopter results revealed by seek).
  await A(() => {
    window.__argus.trigger('san_andreas_1906');
    window.__argus.pause();
    window.__argus.seek(760);
  });
  await freshFrames(5);
  await page.locator('.ag-cop-launch').click();
  await page.waitForTimeout(500);
  let m = await m5State();
  check(m.open, 'copilot drawer did not open from the launcher');
  check(m.messages === 0, `chat not empty at start (${m.messages})`);
  // Quick prompt → mock answer with a plan card; the plan is auto-shown on the map.
  await page.locator('.ag-cop__sugg').first().click();
  await page.waitForFunction(() => (window.__argus.copilot?.log.length ?? 0) >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(2000);
  m = await m5State();
  check(m.mode === 'mock', `answer mode '${m.mode}', expected mock`);
  check(m.hasPlan && m.cards >= 1, `no plan card after the quick prompt (plan ${m.hasPlan}, cards ${m.cards})`);
  check(m.invalid.length === 0, `plan references unknown ids (${m.invalid})`);
  check(m.routed > 0 && m.layerVisible, `routes not drawn (routed ${m.routed}, layer ${m.layerVisible})`);
  check(m.planState === 'shown', `planState '${m.planState}', expected shown`);
  await shot('09-m5-plan');
  // Show on map re-draws the plan after the layer was cleared.
  await A(() => window.__argus.handles.rescue.clear());
  await page.locator('.ag-cpl__show').last().click();
  await page.waitForTimeout(800);
  m = await m5State();
  check(m.layerVisible && m.routed > 0, 'Show on map did not draw the routes');
  check(!m.dispatched, 'units dispatched before Dispatch');
  // Dispatch moves the units.
  await page.locator('.ag-cpl__dispatch').last().click();
  await page.waitForTimeout(3000);
  m = await m5State();
  check(m.dispatched, 'rescue layer not dispatched after Dispatch');
  check(m.planState === 'dispatched', `planState '${m.planState}', expected dispatched`);
  await shot('09-m5-dispatched');
  await sampleFps('M5 routes + units moving (mock)');
  // Reset clears chat + layer.
  await page.locator('.ag-cop__close').click();
  await page.locator('.ag-feed__foot .ag-btn').click();
  await page.waitForTimeout(800);
  m = await m5State();
  check(m.messages === 0, `chat not cleared after reset (${m.messages} messages)`);
  check(!m.layerVisible, 'rescue layer still visible after reset');
  check(m.cards === 0, `plan cards still in the drawer after reset (${m.cards})`);
});

await browser.close();

// ───────────────────────── report ─────────────────────────
console.log('\nfps summary (%s, %dx%d, DPR 1):', useChrome ? 'Google Chrome new-headless' : 'headless shell', W, H);
for (const r of fpsTable) console.log(`  ${r.fps.toFixed(1).padStart(5)} fps  ${String(r.calls).padStart(4)} calls  ${String(r.trisM).padStart(5)}M tris  ${r.label}`);
if (notes.length) {
  console.log(`\nnotes (${notes.length}):`);
  for (const n of [...new Set(notes)].slice(0, 30)) console.log(`  ${n}`);
}
const problems = [...failures, ...consoleProblems];
if (problems.length) {
  console.log(`\nE2E FAILED — ${failures.length} failed checks, ${consoleProblems.length} console problems:`);
  for (const p of [...new Set(problems)].slice(0, 60)) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`\nE2E PASSED — screenshots in ${outDir}`);
