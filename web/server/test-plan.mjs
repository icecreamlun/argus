#!/usr/bin/env node
/**
 * End-to-end test of POST /api/plan (M4 Argon drone planner) with a real PlanRequest:
 *  1. loads the app headless with the 1906 quake at --t (default 150 s), air=replay (cached AIR 1 results);
 *  2. imports src/argus/planner.ts in the page (Vite serves modules by URL) and builds the PlanRequest from the
 *     live handles (__argus.handles.recon / scan / heli, __argus.result);
 *  3. POSTs it to /api/plan (real gemini-4-argon unless cached) and prints latency, the plan, and checks that
 *     every target exists; also prints the heuristic mock plan for comparison.
 *
 * Usage (dev server running): node server/test-plan.mjs [--t 150] [--wave 1] [--drones D1,D2,D3] [--fresh] [--mode auto|replay-only] [--dump req.json]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const BASE = opt('base', 'http://127.0.0.1:5173');
const T = Number(opt('t', 150));
const WAVE = Number(opt('wave', 1));
const DRONES = opt('drones', 'D1,D2,D3').split(',');
const MODE = opt('mode', 'auto');
const FRESH = args.includes('--fresh');
const DUMP = opt('dump', '');

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[pageerror]', e.message));
await page.goto(`${BASE}/?tod=15&quake=san_andreas_1906&t=${T}&air=replay&ui=0`);
await page.waitForFunction(() => window.__argus?.ready || window.__argus?.error, null, { timeout: 120000 });
// Replay results load asynchronously (GET /api/replay); wait until some are revealed.
await page.waitForFunction(() => (window.__argus.handles?.recon?.stats?.().buildingsObserved ?? 0) > 0, null, { timeout: 60000 }).catch(() => console.warn('no recon results revealed'));

const req = await page.evaluate(
  async ({ T, WAVE, DRONES, MODE }) => {
    const a = window.__argus;
    const { recon, scan, heli } = a.handles;
    const m = await import('/src/argus/planner.ts');
    const flightS = T - 50;
    const dur = heli.durationS;
    const st = recon.stats();
    const status = flightS >= dur ? 'complete' : flightS < 6 ? 'en route' : flightS > dur - 8 ? 'returning' : 'scanning';
    return m.buildPlanRequest({
      city: a.ctx.city,
      result: a.result,
      recon,
      scanned: (i) => scan.isScanned(i),
      scannedFraction: scan.scannedFraction(),
      heliStatus: status,
      chunksDone: st.chunksDone,
      chunksTotal: Math.ceil(dur / 15),
      simS: T,
      wave: WAVE,
      dronesAvailable: DRONES,
      previousPlans: WAVE === 2 ? [{ wave: 1, approved: true, missions: ['W1-D1 → first wave targets'], outcome: 'completed' }] : undefined,
      mode: MODE,
    });
  },
  { T, WAVE, DRONES, MODE },
);
if (DUMP) writeFileSync(DUMP, JSON.stringify(req, null, 1));

console.log(`coverage ${JSON.stringify(req.coverage)}  situation: ${req.situation.collapsesObserved.length} collapses, ${req.situation.peopleSeen} people, ${req.situation.fires.length} fires, ${req.situation.blockedRoads.length} blocked`);
console.log(`${req.candidates.length} candidates (top 12):`);
for (const c of req.candidates.slice(0, 12))
  console.log(`  ${c.id.padEnd(6)} ${String(c.score).padStart(5)} ${String(c.kind).padEnd(14)} ${String(c.distanceFromBaseM).padStart(5)} m  ${c.label.slice(0, 70)} — ${c.reason.slice(0, 90)}`);

const mock = await page.evaluate(async (req) => (await import('/src/argus/planMock.ts')).createMockPlan(req), req);
console.log('\nmock plan:', mock.missions.map((m) => `${m.droneId}→${m.targetBuildingIds.join('+')}`).join('  '));

const t0 = Date.now();
const r = await fetch(`${BASE}/api/plan${FRESH ? '?fresh=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
const plan = await r.json();
console.log(`\n/api/plan → HTTP ${r.status} in ${Date.now() - t0} ms`);
if (!r.ok) {
  console.log(plan);
  await browser.close();
  process.exit(1);
}
console.log(`mode ${plan.mode}  model ${plan.model}  latency ${plan.latencyMs} ms  dispatch=${plan.dispatch}  usage ${JSON.stringify(plan.usage ?? {})}`);
console.log(`rationale: ${plan.rationale}`);
if (plan.holdReason) console.log(`hold: ${plan.holdReason}`);
const ids = new Set(await page.evaluate(() => window.__argus.ctx.city.buildings.map((b) => b.id)));
const candB = new Set(req.candidates.flatMap((c) => c.buildingIds ?? (c.buildingId ? [c.buildingId] : [])));
let bad = 0;
for (const m of plan.missions) {
  const miss = m.targetBuildingIds.filter((id) => !ids.has(id) || !candB.has(id));
  bad += miss.length;
  console.log(`  ${m.id} ${m.kind} p${m.priority} → ${m.targetBuildingIds.join(', ')}${m.areaCentre ? ` @${m.areaCentre}` : ''}${miss.length ? `  INVALID ${miss}` : ''}\n      ${m.purpose}`);
}
if (plan.notes?.length) console.log('notes:', plan.notes);
console.log(bad ? `\n${bad} invalid targets` : '\nall targets valid');
await browser.close();
