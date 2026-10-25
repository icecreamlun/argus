#!/usr/bin/env node
/**
 * End-to-end test of M6 resident reports:
 *  1. in node (vite ssrLoadModule, no browser): loads public/data/city.json, runs the quake model
 *     (san_andreas_1906 @ --hour, seed 1976 = the app's DEFAULT_SEED), generates people truth (flat terrain stub —
 *     only trapped counts are used) and the resident reports; prints volume / category / noise stats + samples;
 *  2. builds --batches batches of --size reports (candidates = nearest 6 core buildings within 120 m), POSTs each to
 *     /api/reports (real gemini-4-argon unless cached) and compares Argon's linked building / damage with truthRef
 *     (link accuracy, xBD damage-class accuracy); also scores the heuristic mock on the same batches.
 *
 * Usage (dev server running): node server/test-reports.mjs [--hour 15] [--batches 2] [--size 25] [--fresh] [--mode auto|replay-only] [--gen-only] [--samples 12]
 */
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const BASE = opt('base', 'http://127.0.0.1:5173');
const HOUR = Number(opt('hour', 15));
const NB = Number(opt('batches', 2));
const SIZE = Number(opt('size', 25));
const MODE = opt('mode', 'auto');
const FRESH = args.includes('--fresh');
const GEN_ONLY = args.includes('--gen-only');
const SAMPLES = Number(opt('samples', 12));

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
try {
  const qm = await vite.ssrLoadModule('/src/quake/model/index.ts');
  const pm = await vite.ssrLoadModule('/src/truth/people/generate.ts');
  const rm = await vite.ssrLoadModule('/src/truth/reports.ts');
  const mm = await vite.ssrLoadModule('/src/argus/reportsMock.ts');
  const city = JSON.parse(readFileSync(`${root}/public/data/city.json`, 'utf8'));
  const model = qm.createQuakeModel();
  const sc = qm.scenarioAtHour(model.scenarios.find((s) => s.id === 'san_andreas_1906'), HOUR);
  const result = model.run(city, sc, qm.DEFAULT_SEED);
  const terrain = { meta: {}, data: new Float32Array(0), heightAt: () => 0, normalAt: (_x, _z, t) => t ?? { x: 0, y: 1, z: 0 } };
  const people = pm.generatePeople(city, terrain, result);
  const t0 = Date.now();
  const reports = rm.generateReports(city, result, people, 1906);
  const genMs = Date.now() - t0;
  const reports2 = rm.generateReports(city, result, people, 1906);
  const deterministic = JSON.stringify(reports) === JSON.stringify(reports2);

  const idxOf = new Map(city.buildings.map((b, i) => [b.id, i]));
  const stateOf = (id) => (id && idxOf.has(id) ? (result.damage[idxOf.get(id)].collapsed ? 4 : result.damage[idxOf.get(id)].state) : null);
  const XBD = [0, 1, 2, 2, 3];
  const DMG = { none: 0, slight: 1, moderate: 2, extensive: 3, collapsed: 4 };
  const count = (f) => reports.filter(f).length;
  const tally = (k) => reports.reduce((m, r) => ((m[k(r)] = (m[k(r)] ?? 0) + 1), m), {});
  console.log(`generated ${reports.length} reports in ${genMs} ms (deterministic: ${deterministic}); simS ${reports[0]?.simS}…${reports.at(-1)?.simS}`);
  console.log('  by category', tally((r) => r.category));
  console.log('  by truth kind', tally((r) => r.truthRef.kind), ' lang', tally((r) => r.lang));
  console.log('  by truth state', tally((r) => String(stateOf(r.truthRef.buildingId))));
  console.log('  by minute', tally((r) => Math.floor(r.simS / 60)));
  console.log(`  distinct buildings ${new Set(reports.map((r) => r.truthRef.buildingId).filter(Boolean)).size}; mean accuracy ${(reports.reduce((a, r) => a + r.accuracyM, 0) / reports.length).toFixed(1)} m`);
  const step = Math.max(1, Math.floor(reports.length / SAMPLES));
  for (let i = 0; i < reports.length; i += step) {
    const r = reports[i];
    console.log(`  ${r.id} T+${r.simS.toFixed(0).padStart(3)} ${r.category.padEnd(7)} ${r.truthRef.kind.padEnd(11)} ${String(r.truthRef.buildingId).padEnd(6)} ds${stateOf(r.truthRef.buildingId)} ±${r.accuracyM}m ${r.reporter} | ${r.text}`);
  }
  if (GEN_ONLY) process.exit(0);

  const truthInCands = { n: 0, hit: 0 };
  const score = (label, res, batch, req) => {
    const byId = new Map(batch.map((r) => [r.id, r]));
    let link = 0, linkN = 0, dmg = 0, dmgN = 0, xbd = 0, nullLinks = 0;
    const rows = [];
    for (const a of res.analyses) {
      const r = byId.get(a.reportId);
      if (!r) continue;
      const tid = r.truthRef.buildingId;
      if (tid) {
        linkN++;
        if (a.buildingId === tid) link++;
        if (!a.buildingId) nullLinks++;
        const ts = stateOf(tid);
        if (a.damage && ts !== null) {
          dmgN++;
          if (DMG[a.damage] === ts) dmg++;
          if (XBD[DMG[a.damage]] === XBD[ts]) xbd++;
        }
      }
      rows.push(`    ${r.id} ${r.truthRef.kind.padEnd(11)} truth ${String(tid).padEnd(6)} ds${stateOf(tid)} → ${String(a.buildingId).padEnd(6)} ${String(a.damage).padEnd(9)} cred ${a.credibility.toFixed(2)} trapped ${a.peopleTrapped} ${a.hazards.join(',')}${a.duplicateOf ? ` dup→${a.duplicateOf}` : ''} | ${a.note ?? ''}`);
    }
    console.log(`  [${label}] link ${link}/${linkN} (${((100 * link) / Math.max(1, linkN)).toFixed(0)}%), null links ${nullLinks}; damage exact ${dmg}/${dmgN} (${((100 * dmg) / Math.max(1, dmgN)).toFixed(0)}%), xBD ${xbd}/${dmgN} (${((100 * xbd) / Math.max(1, dmgN)).toFixed(0)}%)`);
    return rows;
  };

  for (let b = 0; b < NB; b++) {
    const batch = reports.slice(b * SIZE, (b + 1) * SIZE);
    if (!batch.length) break;
    const req = rm.buildReportsRequest(city, batch, b, sc.id, HOUR, MODE === 'replay-only' ? 'replay-only' : undefined);
    if (JSON.stringify(req).includes('truthRef')) throw new Error('truthRef leaked into the request');
    for (const [k, r] of batch.entries()) {
      if (!r.truthRef.buildingId) continue;
      truthInCands.n++;
      if (req.reports[k].candidates.some((c) => c.id === r.truthRef.buildingId)) truthInCands.hit++;
    }
    console.log(`\nbatch ${b}: ${batch.length} reports (T+${batch[0].simS.toFixed(0)}…${batch.at(-1).simS.toFixed(0)}), ${req.reports.reduce((a, r) => a + r.candidates.length, 0)} candidates; request ${(JSON.stringify(req).length / 1024).toFixed(1)} KB`);
    const mock = mm.createMockReportsResponse(req, new Map(batch.map((r) => [r.id, r])));
    score('mock', mock, batch, req);
    const t1 = Date.now();
    const resp = await fetch(`${BASE}/api/reports${FRESH ? '?fresh=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const out = await resp.json();
    console.log(`  /api/reports → HTTP ${resp.status} in ${Date.now() - t1} ms (mode ${out.mode}, latencyMs ${out.latencyMs})${out.error ? ` error ${out.error}` : ''}`);
    if (!resp.ok) continue;
    const rows = score('argon', out, batch, req);
    console.log(`  summary: ${out.summary}`);
    if (out.notes?.length) console.log(`  notes: ${out.notes.join('; ')}`);
    rows.forEach((l) => console.log(l));
  }
  console.log(`\ntruth building within the 6 candidates: ${truthInCands.hit}/${truthInCands.n}`);
} finally {
  await vite.close();
}
