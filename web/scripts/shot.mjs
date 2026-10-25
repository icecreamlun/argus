#!/usr/bin/env node
/**
 * Screenshot harness: renders the app headless (real GPU via ANGLE/Metal) and saves PNGs.
 *
 * Usage:
 *   node scripts/shot.mjs [--base http://127.0.0.1:5173] [--out shots] [--w 1600 --h 900] [--wait 1500] [--chrome] spec [spec...]
 * A spec is  name:querystring  e.g.
 *   overview:cam=overview&tod=16.5&ui=0
 *   quake20:cam=fidi&quake=san_andreas_1906&t=20&ui=0
 *   "ui:cam=overview"            (with UI visible)
 * Defaults to a standard set when no spec is given.
 * Prints console errors/warnings from the page, the FPS reading and the saved paths.
 * The dev server must already be running (npm run dev).
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
const base = opt('base', 'http://127.0.0.1:5173');
const outDir = resolve(opt('out', 'shots'));
const width = Number(opt('w', 1600));
const height = Number(opt('h', 900));
const settle = Number(opt('wait', 1500));
const chromeIdx = args.indexOf('--chrome'); // installed Google Chrome (new headless) instead of the headless shell
const useChrome = chromeIdx >= 0;
if (useChrome) args.splice(chromeIdx, 1);

const DEFAULT_SPECS = [
  'overview:cam=overview&tod=16.5&ui=0',
  'ferry:cam=ferry&tod=17.2&ui=0',
  'chinatown:cam=chinatown&tod=16&ui=0',
  'street:cam=street&tod=15&ui=0',
  'night:cam=overview&tod=21.5&ui=0',
  'ui:cam=overview&tod=16.5',
];
const specs = (args.length ? args : DEFAULT_SPECS).map((s) => {
  const i = s.indexOf(':');
  return { name: s.slice(0, i), query: s.slice(i + 1) };
});

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(useChrome ? { channel: 'chrome' } : {}),
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

for (const { name, query } of specs) {
  logs.length = 0;
  const url = `${base}/?${query}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__argus && (window.__argus.ready || window.__argus.error), null, { timeout: 120000 });
  } catch {
    logs.push('[harness] timed out waiting for __argus.ready');
  }
  const err = await page.evaluate(() => window.__argus?.error);
  if (err) logs.push(`[boot-error] ${err}`);
  // Shader compiles after a time-of-day / quake change can stall the first frames: wait until a few
  // fresh frames have actually been presented before settling, so the capture is never stale.
  try {
    const f0 = await page.evaluate(() => window.__argus?.frame ?? 0);
    await page.waitForFunction((f) => (window.__argus?.frame ?? 0) >= f + 5, f0, { timeout: 60000 });
  } catch {
    logs.push('[harness] page rendered < 5 frames in 60 s');
  }
  await page.waitForTimeout(settle);
  const { fps, perf } = await page.evaluate(() => ({ fps: window.__argus?.fps ?? 0, perf: window.__argus?.perf }));
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path });
  const perfStr = perf ? ` calls=${perf.calls} tris=${(perf.triangles / 1e6).toFixed(2)}M pr=${perf.pixelRatio}` : '';
  console.log(`✔ ${name}  ${path}  load=${Date.now() - t0}ms fps≈${fps}${perfStr}`);
  for (const l of logs.slice(0, 15)) console.log(`   ${l}`);
  if (logs.length > 15) console.log(`   … ${logs.length - 15} more log lines`);
}
await browser.close();
