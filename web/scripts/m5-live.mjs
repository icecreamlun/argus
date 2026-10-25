#!/usr/bin/env node
/**
 * M5 Argus Copilot live test through the real UI (headless Chromium on the real GPU, like shot.mjs).
 *
 *   node scripts/m5-live.mjs [--base http://127.0.0.1:5173] [--out shots/m5] [--phase live|replay|both]
 *
 * live:   /?cam=overview&tod=15&quake=san_andreas_1906&t=760&air=replay&chat=live (full recon state, real
 *         gemini-4-argon) → open the drawer → ask the 3 demo questions via the text box → log latency, reply,
 *         plan validity, routes → screenshots (drawer + plan card, framed map, overview, Chinatown oblique,
 *         highlight, dispatched units).
 * replay: same URL with chat following air=replay (replay-only) → ask the same questions → every answer must
 *         come back with mode 'replay'.
 * Writes <out>/m5-<phase>.json. The dev server must be running.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const base = opt('base', 'http://127.0.0.1:5173');
const outDir = resolve(opt('out', 'shots/m5'));
const phase = opt('phase', 'both');
mkdirSync(outDir, { recursive: true });

export const QUESTIONS = [
  '我现在有10辆消防车、20名警察、2架直升机、6辆救护车，如何安排救援路线和优先级？',
  'How many people are confirmed trapped and where?',
  '如果Pine Street清通了，方案怎么调整？',
];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

async function openPage(query) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/token=/, () => {}); // no HMR reloads mid-test
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__argus && (window.__argus.ready || window.__argus.error), null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__argus.error);
  if (err) throw new Error(err);
  const f0 = await page.evaluate(() => window.__argus.frame);
  await page.waitForFunction((f) => window.__argus.frame >= f + 10, f0, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { page, problems };
}

const shot = async (page, name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`   📸 ${name}.png`);
};

async function ask(page, q, n) {
  await page.fill('.ag-cop__input', q);
  await page.press('.ag-cop__input', 'Enter');
  const t0 = Date.now();
  await page.waitForFunction((k) => (window.__argus.copilot?.log.length ?? 0) >= k, n, { timeout: 120000, polling: 250 });
  const wall = Date.now() - t0;
  await page.waitForTimeout(2200); // typing animation + plan card
  const out = await page.evaluate(() => {
    const c = window.__argus.copilot;
    const log = c.log[c.log.length - 1];
    const msg = c.messages[c.messages.length - 1];
    return { log, reply: msg.text, plan: msg.plan, planState: msg.planState, fps: window.__argus.fps, routed: c.routed.length };
  });
  console.log(`\n── Q${n} (${out.log.mode}, ${out.log.latencyMs} ms server / ${wall} ms wall) ──`);
  console.log(out.reply);
  console.log(
    `   plan: ${out.log.priorities} priorities, ${out.log.assignments} assignments, ${out.log.units} units → ${out.log.routes} drawn routes (${out.routed} unit tracks), unreachable ${out.log.unreachable}, invalid ids [${out.log.invalidIds.join(', ')}], notes ${JSON.stringify(out.log.notes)}${out.log.error ? `, error ${out.log.error}` : ''}`,
  );
  return { question: q, wallMs: wall, ...out };
}

async function fpsSample(page, ms = 2500) {
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__argus.fps);
}

const results = {};

if (phase === 'live' || phase === 'both') {
  console.log('▶ live phase (chat=live)');
  const { page, problems } = await openPage('cam=overview&tod=15&quake=san_andreas_1906&t=760&air=replay&chat=live');
  const sit = await page.evaluate(() => {
    const s = window.__argus.copilot.situation();
    return s && { incidents: s.incidents.length, verified: s.incidents.filter((i) => i.verified).length, roads: s.roads.length, facilities: s.facilities.length, summary: s.summary };
  });
  console.log('   situation', JSON.stringify(sit));
  await page.click('.ag-cop-launch');
  await page.waitForTimeout(600);
  await shot(page, 'm5_empty');
  const qs = [];
  // Q1: allocation
  qs.push(await ask(page, QUESTIONS[0], 1));
  await shot(page, 'm5_q1_drawer');
  await page.waitForTimeout(2000); // camera flight to the plan bounds
  await shot(page, 'm5_q1_framed');
  const fpsRoutes = await fpsSample(page);
  // Highlight: hover the first priority row.
  const prio = page.locator('.ag-cpl__prio').first();
  if (await prio.count()) {
    await prio.hover();
    await page.waitForTimeout(600);
    await shot(page, 'm5_q1_highlight');
    await page.mouse.move(300, 450);
  }
  // Map views without the drawer.
  await page.click('.ag-cop__close');
  await page.evaluate(() => window.__argus.flyTo('overview', 0));
  await page.waitForTimeout(1200);
  await shot(page, 'm5_q1_overview');
  await page.evaluate(() => window.__argus.flyTo('chinatown', 0));
  await page.waitForTimeout(1200);
  await shot(page, 'm5_q1_chinatown');
  // Dispatch from the plan card.
  await page.click('.ag-cop-launch');
  await page.waitForTimeout(500);
  await page.locator('.ag-cpl__dispatch').last().click();
  await page.waitForTimeout(300);
  const dispatched = await page.evaluate(() => ({ layer: window.__argus.handles.rescue.dispatched, state: window.__argus.copilot.messages.at(-1).planState }));
  await page.click('.ag-cop__close');
  await page.evaluate(() => window.__argus.flyTo('overview', 0));
  await page.waitForTimeout(5000);
  await shot(page, 'm5_q1_dispatch_overview');
  await page.evaluate(() => window.__argus.flyTo('chinatown', 0));
  await page.waitForTimeout(3500);
  await shot(page, 'm5_q1_dispatch_chinatown');
  const fpsDispatch = await fpsSample(page, 1500);
  await page.click('.ag-cop-launch');
  await page.waitForTimeout(500);
  // Q2 / Q3 with history.
  qs.push(await ask(page, QUESTIONS[1], 2));
  await shot(page, 'm5_q2_drawer');
  qs.push(await ask(page, QUESTIONS[2], 3));
  await shot(page, 'm5_q3_drawer');
  await page.waitForTimeout(2000);
  await shot(page, 'm5_q3_framed');
  results.live = { situation: sit, questions: qs, fpsRoutes, fpsDispatch, dispatched, problems };
  console.log(`\n   fps with routes ${fpsRoutes}, while dispatched ${fpsDispatch}; dispatched ${JSON.stringify(dispatched)}; console problems ${problems.length}`);
  problems.forEach((p) => console.log('   ⚠', p));
  await page.close();
}

if (phase === 'extra') {
  // Record the remaining quick prompts (as follow-ups to Q1) so every quick prompt replays offline.
  console.log('▶ extra phase (chat=live): quick prompts 3-4 after Q1');
  const { page, problems } = await openPage('cam=overview&tod=15&quake=san_andreas_1906&t=760&air=replay&chat=live&copilot=1');
  const qs = [];
  qs.push(await ask(page, QUESTIONS[0], 1));
  qs.push(await ask(page, 'Which roads should police clear first?', 2));
  qs.push(await ask(page, 'Where should the helicopters go?', 3));
  results.extra = { questions: qs.map((q) => ({ question: q.question, mode: q.log.mode, latencyMs: q.log.latencyMs, routes: q.log.routes, invalidIds: q.log.invalidIds, reply: q.reply })), problems };
  await page.close();
}

if (phase === 'replay' || phase === 'both') {
  console.log('\n▶ replay phase (air=replay → replay-only)');
  const { page, problems } = await openPage('cam=overview&tod=15&quake=san_andreas_1906&t=760&air=replay&copilot=1');
  await page.waitForTimeout(400);
  const qs = [];
  for (let i = 0; i < QUESTIONS.length; i++) qs.push(await ask(page, QUESTIONS[i], i + 1));
  await shot(page, 'm5_replay_q3');
  const modes = qs.map((q) => q.log.mode);
  console.log(`\n   replay modes: ${modes.join(', ')}; console problems ${problems.length}`);
  results.replay = { questions: qs.map((q) => ({ question: q.question, mode: q.log.mode, latencyMs: q.log.latencyMs, wallMs: q.wallMs, routes: q.log.routes, invalidIds: q.log.invalidIds })), modes, problems };
  await page.close();
}

writeFileSync(join(outDir, `m5-${phase}.json`), JSON.stringify(results, null, 2));
await browser.close();
