#!/usr/bin/env node
/**
 * Quake model test & calibration runner.
 *
 *   node scripts/quake-test.mjs                # all presets, night (3.7 h) and day (14 h)
 *   node scripts/quake-test.mjs --seeds 20     # also a seed-sensitivity sweep for each preset
 *   node scripts/quake-test.mjs --synthetic    # force the synthetic test city
 *   node scripts/quake-test.mjs --json out.json  # dump a compact per-building table for inspection
 *
 * Loads src/quake/model/index.ts through Vite's SSR module loader (no extra deps) in middleware mode with
 * HMR/ws disabled and a private cache dir, so it never interferes with the shared dev server.
 * Uses public/data/city.json; if that is still the tiny placeholder (< 50 buildings) a synthetic city
 * resembling the study area (Chinatown URM, Jackson Square brick, FiDi towers on fill) is generated.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  cacheDir: path.join(os.tmpdir(), 'argus-quake-test-vite'),
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});

try {
  const mod = await server.ssrLoadModule('/src/quake/model/index.ts');
  const model = mod.createQuakeModel();

  let city = JSON.parse(fs.readFileSync(path.join(root, 'public/data/city.json'), 'utf8'));
  let source = 'public/data/city.json';
  if (flag('--synthetic') || city.buildings.length < 50) {
    city = syntheticCity();
    source = 'SYNTHETIC test city (real city.json not ready)';
  }
  const B = city.buildings;
  console.log(`\nCity: ${source} — ${B.length} buildings, ${city.roads.length} roads, ` +
    `${B.filter((b) => b.onFill).length} on fill, structures: ${fmtCounts(countBy(B, (b) => b.structure))}`);
  console.log(`  code levels: ${fmtCounts(countBy(B, (b) => b.codeLevel))}; districts: ${fmtCounts(countBy(B, (b) => b.district))}`);
  console.log(`  soft-story: ${B.filter((b) => b.softStory || b.structure === 'W1_SOFT').length}; URM by code: ${fmtCounts(countBy(B.filter((b) => b.structure === 'URM'), (b) => b.codeLevel))}`);
  const vs = B.map((b) => b.vs30).sort((a, b) => a - b);
  console.log(`  Vs30 min/median/max: ${vs[0]} / ${median(vs)} / ${vs[vs.length - 1]}`);

  // ── Scenario events ──
  console.log('\n══ Scenario events (USGS GeoJSON) ══');
  for (const s of model.scenarios) {
    const p = s.event.properties;
    console.log(`  ${s.id.padEnd(18)} ${s.event.id}  "${p.title}"  alert=${p.alert} sig=${p.sig} tsunami=${p.tsunami} mmi=${p.mmi} ` +
      `time=${new Date(p.time).toISOString()} depth=${s.event.geometry.coordinates[2]}km trace=${s.ruptureTrace?.length ?? 0} pts`);
  }

  // ── Per scenario × hour tables ──
  const hours = [3.7, 14];
  for (const s0 of model.scenarios) {
    for (const h of hours) {
      const s = { ...s0, localHour: h };
      const res = model.run(city, s, 1976);
      report(res, s, city, model);
    }
  }

  // ── Determinism & performance ──
  console.log('\n══ Determinism & performance ══');
  const s1906 = model.scenarios[0];
  const a = JSON.stringify(model.run(city, s1906, 42));
  const b = JSON.stringify(model.run(city, s1906, 42));
  const c = JSON.stringify(model.run(city, s1906, 43));
  console.log(`  same seed identical: ${a === b}   different seed differs: ${a !== c}`);
  for (const s of model.scenarios) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      model.run(city, s, 100 + i);
      times.push(model.lastRunMs);
    }
    times.sort((x, y) => x - y);
    console.log(`  run() ${s.id.padEnd(18)} median ${times[2].toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[4].toFixed(1)}) for ${B.length} buildings`);
  }
  // Scale test: replicate the city to ≥ 3000 buildings.
  if (B.length < 3000) {
    const big = { ...city, buildings: [] };
    for (let k = 0; big.buildings.length < 3000; k++)
      for (const bb of B) big.buildings.push({ ...bb, id: `${bb.id}_${k}`, parentId: bb.parentId ? `${bb.parentId}_${k}` : undefined, footprint: bb.footprint.map(([x, z]) => [x + (k % 3) * 7, z + Math.floor(k / 3) * 7]) });
    const t = [];
    for (let i = 0; i < 3; i++) {
      model.run(big, s1906, i);
      t.push(model.lastRunMs);
    }
    console.log(`  run() at ${big.buildings.length} buildings: ${Math.min(...t).toFixed(1)}–${Math.max(...t).toFixed(1)} ms`);
  }
  {
    const t0 = performance.now();
    model.mmiAt(city, s1906, 0, 0);
    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < 100000; i++) acc += model.mmiAt(city, s1906, -1500 + (i % 300) * 10, -1000 + Math.floor(i / 300) * 6);
    const t2 = performance.now();
    console.log(`  mmiAt: first call (grid build) ${(t1 - t0).toFixed(1)} ms, then ${(((t2 - t1) / 100000) * 1000).toFixed(2)} µs/call (mean ${(acc / 100000).toFixed(2)})`);
  }

  // ── Seed sweep ──
  const nSeeds = Number(opt('--seeds', 0));
  if (nSeeds > 0) {
    console.log(`\n══ Seed sensitivity (${nSeeds} seeds, night) ══`);
    for (const s0 of model.scenarios) {
      const s = { ...s0, localHour: 3.7 };
      const col = [], ext = [], fire = [], trap = [];
      for (let k = 0; k < nSeeds; k++) {
        const r = model.run(city, s, 1000 + k);
        col.push(r.stats.collapsed);
        ext.push(r.stats.byState[3] + r.stats.byState[4]);
        fire.push(r.stats.fires);
        trap.push(r.stats.trappedEstimate);
      }
      const st = (v) => `${Math.min(...v)}–${Math.max(...v)} (median ${median([...v].sort((x, y) => x - y))})`;
      console.log(`  ${s.id.padEnd(18)} collapsed ${st(col)}; ext+complete ${st(ext)}; fires ${st(fire)}; trapped ${st(trap)}`);
    }
  }

  // ── Custom scenario ──
  console.log('\n══ Custom scenarios ══');
  for (const [lat, lon, d, m] of [[37.79, -122.30, 10, 6.0], [37.6, -122.45, 9, 7.2]]) {
    const cs = model.customScenario(lat, lon, d, m, 10);
    const r = model.run(city, cs, 7);
    console.log(`  ${cs.id}: "${cs.event.properties.title}" trace=${cs.ruptureTrace?.length ?? 0} ztor=${cs.ztorKm?.toFixed(1)} → ` +
      `MMI median ${median(r.shaking.map((x) => x.mmi).sort((a, b) => a - b)).toFixed(2)}, collapsed ${r.stats.collapsed}, alert ${cs.event.properties.alert}`);
  }

  const out = opt('--json', null);
  if (out) {
    const r = model.run(city, s1906, 1976);
    fs.writeFileSync(out, JSON.stringify(r.damage.map((d, i) => ({ id: B[i].id, s: B[i].structure, c: B[i].codeLevel, d: B[i].district, f: B[i].onFill, mmi: r.shaking[i].mmi, pga: r.shaking[i].pgaG, st: d.state, col: d.collapsed }))));
    console.log(`\nwrote ${out}`);
  }
} finally {
  await server.close();
}

// ───────────────────────────── reporting ─────────────────────────────

function report(res, s, city, model) {
  const B = city.buildings;
  const mmis = res.shaking.map((x) => x.mmi);
  const sorted = [...mmis].sort((a, b) => a - b);
  const fillM = B.map((b, i) => (b.onFill ? mmis[i] : null)).filter((v) => v !== null).sort((a, b) => a - b);
  const nonFillM = B.map((b, i) => (!b.onFill ? mmis[i] : null)).filter((v) => v !== null).sort((a, b) => a - b);
  const pga = res.shaking.map((x) => x.pgaG).sort((a, b) => a - b);
  const pgv = res.shaking.map((x) => x.pgvCms).sort((a, b) => a - b);
  const dur = res.shaking.map((x) => x.durationS).sort((a, b) => a - b);
  const sArr = res.shaking.map((x) => x.sArrivalS).sort((a, b) => a - b);
  const liq = res.shaking.filter((x) => x.liquefaction).length;
  const st = res.stats;
  const tag = s.localHour < 6 || s.localHour > 21 ? 'night' : 'day';
  console.log(`\n══ ${s.name}  [${tag} ${s.localHour} h]  ══`);
  console.log(`  MMI   min/median/max ${sorted[0].toFixed(2)} / ${median(sorted).toFixed(2)} / ${sorted[sorted.length - 1].toFixed(2)}` +
    `   fill median ${fillM.length ? median(fillM).toFixed(2) : '-'} (n=${fillM.length})   non-fill median ${nonFillM.length ? median(nonFillM).toFixed(2) : '-'}`);
  const byD = groupBy(B.map((b, i) => [b.district, mmis[i]]));
  console.log(`  MMI by district: ${Object.entries(byD).map(([k, v]) => `${k} ${median(v.sort((a, b) => a - b)).toFixed(1)}`).join(', ')}`);
  console.log(`  PGA median ${median(pga).toFixed(3)} g (p10 ${pct(pga, 0.1).toFixed(3)}, p90 ${pct(pga, 0.9).toFixed(3)})   PGV median ${median(pgv).toFixed(1)} cm/s (p90 ${pct(pgv, 0.9).toFixed(1)})   liquefied sites ${liq}`);
  console.log(`  S arrival ${sArr[0].toFixed(1)}–${sArr[sArr.length - 1].toFixed(1)} s, strong-shaking duration median ${median(dur).toFixed(1)} s; result.durationS ${res.durationS} s`);
  console.log(`  Damage states none/slight/moderate/extensive/complete: ${st.byState.join(' / ')}   collapsed ${st.collapsed} (${((100 * st.collapsed) / Math.max(1, st.buildings)).toFixed(1)} %)`);
  const col = B.map((b, i) => (res.damage[i].collapsed ? b : null)).filter(Boolean);
  if (col.length) {
    console.log(`  collapses by district: ${fmtCounts(countBy(col, (b) => b.district))}`);
    console.log(`  collapses by type:     ${fmtCounts(countBy(col, (b) => b.structure + '/' + b.codeLevel))}   on fill: ${col.filter((b) => b.onFill).length}`);
  }
  const ext = B.map((b, i) => (res.damage[i].state >= 3 ? b : null)).filter(Boolean);
  if (ext.length) console.log(`  extensive+complete by type: ${fmtCounts(countBy(ext, (b) => b.structure))}`);
  const DS = ['none', 'slight', 'moderate', 'extensive', 'complete'];
  {
    const core = B.map((b, i) => (!b.context ? res.damage[i].state : null)).filter((v) => v !== null);
    const h = [0, 0, 0, 0, 0];
    core.forEach((v) => h[v]++);
    const tall = B.map((b, i) => (!b.context && b.height >= 60 ? i : null)).filter((v) => v !== null);
    const tallC = tall.filter((i) => res.damage[i].state === 4).map((i) => B[i].address || B[i].id);
    console.log(`  core (non-context, n=${core.length}) states ${h.map((v) => ((100 * v) / Math.max(1, core.length)).toFixed(1) + '%').join(' / ')}` +
      `   core ≥60 m (n=${tall.length}) complete ${tallC.length}${tallC.length ? ': ' + [...new Set(tallC)].join(', ') : ''}`);
  }
  for (const codes of [['moderate', 'high'], ['pre', 'low']]) {
    const tall = B.map((b, i) => ((b.levels || 0) >= 15 && codes.includes(b.codeLevel) ? res.damage[i].state : null)).filter((v) => v !== null);
    if (tall.length) console.log(`  high-rises ≥15 st, ${codes.join('/')} code (n=${tall.length}): ${fmtCounts(countBy(tall, (v) => DS[v]))}`);
  }
  const cas = res.damage.reduce((a, d) => a.map((v, k) => v + d.casualties[k]), [0, 0, 0, 0]);
  const impassable = res.roads.filter((r) => r.coverage >= 0.6).length; // roads lists only coverage ≥ 0.5
  const trapBy = { collapsed: 0, complete: 0, extensive: 0, moderate: 0 };
  res.damage.forEach((d) => {
    if (d.collapsed) trapBy.collapsed += d.trappedEstimate;
    else if (d.state === 4) trapBy.complete += d.trappedEstimate;
    else if (d.state === 3) trapBy.extensive += d.trappedEstimate;
    else trapBy.moderate += d.trappedEstimate;
  });
  const fireB = B.map((b, i) => (res.damage[i].fire ? b : null)).filter(Boolean);
  console.log(`  trapped by class: ${fmtCounts(trapBy)};  fires by district: ${fmtCounts(countBy(fireB, (b) => b.district))}`);
  const dr = res.damage.filter((d) => d.debrisRadius > 0).map((d) => d.debrisRadius).sort((a, b) => a - b);
  if (dr.length) console.log(`  debris radius (m) n=${dr.length}: median ${median(dr).toFixed(1)}, p90 ${pct(dr, 0.9).toFixed(1)}, max ${dr[dr.length - 1]}`);
  console.log(`  occupants ${st.occupantsAtTime}   casualties sev1-4 ${cas.map((v) => v.toFixed(1)).join(' / ')}   trapped ${st.trappedEstimate}   fires ${st.fires}`);
  console.log(`  road segments blocked (≥0.5 of carriageway) ${st.blockedSegments} (impassable ≥0.6: ${impassable})   max MMI ${st.maxMmi}`);
  console.log(`  ShakeAlert issued at ${res.shakeAlert.issuedAtS} s, warning at centre ${res.shakeAlert.warningSecondsAtCentre} s ` +
    `${res.shakeAlert.warningSecondsAtCentre <= 0 ? '(BLIND ZONE)' : ''}, expected MMI ${res.shakeAlert.expectedMmi}   mmiAt(0,0) ${model.mmiAt(city, s, 0, 0).toFixed(2)}`);
}

function median(a) {
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function pct(a, p) {
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}
function countBy(arr, f) {
  const m = {};
  for (const x of arr) m[f(x)] = (m[f(x)] || 0) + 1;
  return m;
}
function groupBy(pairs) {
  const m = {};
  for (const [k, v] of pairs) (m[k] ||= []).push(v);
  return m;
}
function fmtCounts(m) {
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
}

// ───────────────────────────── synthetic city (fallback only) ─────────────────────────────

function syntheticCity() {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const buildings = [];
  const roads = [];
  const shoreX = -460; // ~Montgomery St: east of it is Yerba Buena Cove fill
  let id = 0;
  for (let x = -1500; x < 450; x += 50) {
    for (let z = -900; z < 700; z += 50) {
      if (rnd() < 0.15) continue;
      const w = 18 + rnd() * 20;
      const d = 18 + rnd() * 20;
      const cx = x + 25, cz = z + 25;
      const fill = cx > shoreX + (cz + 300) * 0.15;
      let district = 'other';
      if (cx > -900 && cx < -600 && cz > -300 && cz < 420) district = 'chinatown';
      else if (cx > -650 && cx < -420 && cz > -480 && cz < -250) district = 'jackson_square';
      else if (cx > -460 && cx < 150 && cz > -300 && cz < 500) district = 'fidi';
      else if (cx >= 150) district = 'embarcadero';
      else if (cz < -480) district = 'north_beach';
      else if (cx < -900) district = 'nob_hill';
      else district = 'soma';
      const elev = fill ? 3 + rnd() * 2 : Math.max(5, 10 + (-cx - 450) * 0.05 + rnd() * 10);
      const vs30 = fill ? 180 + 50 * Math.exp(-Math.abs(cx - shoreX) / 120) : Math.min(800, 330 + 4.6 * Math.max(0, elev - 6));
      let structure, levels, year, code, use = 'mixed';
      const r = rnd();
      if (district === 'chinatown') {
        year = 1907 + Math.floor(rnd() * 20);
        levels = 2 + Math.floor(rnd() * 4);
        structure = r < 0.6 ? 'URM' : r < 0.72 ? 'W1_SOFT' : r < 0.85 ? 'W1' : 'C3';
      } else if (district === 'jackson_square') {
        year = 1860 + Math.floor(rnd() * 40);
        levels = 2 + Math.floor(rnd() * 3);
        structure = r < 0.7 ? 'URM' : 'W2';
      } else if (district === 'fidi') {
        year = 1920 + Math.floor(rnd() * 100);
        levels = r < 0.4 ? 15 + Math.floor(rnd() * 35) : 4 + Math.floor(rnd() * 10);
        structure = year < 1935 ? (r < 0.5 ? 'S5' : 'C3') : levels >= 15 ? (r < 0.6 ? 'S1' : 'C2') : year < 1976 ? 'C1' : 'C2';
        use = 'office';
      } else {
        year = 1910 + Math.floor(rnd() * 100);
        levels = 2 + Math.floor(rnd() * 5);
        structure = r < 0.4 ? 'W1' : r < 0.55 ? 'W1_SOFT' : r < 0.7 ? 'URM' : r < 0.85 ? 'RM' : 'C2';
        use = 'residential';
      }
      code = structure === 'URM' ? (district === 'jackson_square' ? 'pre' : 'low') : year < 1940 ? 'pre' : year < 1973 ? 'low' : year <= 1994 ? 'moderate' : 'high';
      const area = w * d;
      const gfa = area * levels;
      const occDay = Math.round(use === 'office' ? gfa / 25 : gfa / 60);
      const occNight = Math.round(use === 'office' ? gfa / 800 : gfa / 40);
      buildings.push({
        id: `S${String(++id).padStart(4, '0')}`, osmId: `way/${id}`,
        footprint: [[cx - w / 2, cz + d / 2], [cx + w / 2, cz + d / 2], [cx + w / 2, cz - d / 2], [cx - w / 2, cz - d / 2]],
        baseElevation: elev, height: levels * 3.6, levels, use, structure, yearBuilt: year, codeLevel: code,
        occupantsDay: occDay, occupantsNight: occNight, softStory: structure === 'W1_SOFT', district, onFill: fill, vs30: Math.round(vs30),
        provenance: { height: 'estimated', year: 'estimated', structure: 'estimated' },
      });
    }
  }
  let rid = 0;
  for (let x = -1500; x <= 450; x += 50) roads.push({ id: `R${++rid}`, osmId: 'x', kind: 'residential', points: [[x, -900], [x, 700]], width: 12 });
  for (let z = -900; z <= 700; z += 50) roads.push({ id: `R${++rid}`, osmId: 'x', kind: 'residential', points: [[-1500, z], [450, z]], width: 12 });
  return { meta: { name: 'synthetic', bbox: {}, contextBBox: {}, origin: { lat: 37.7935, lon: -122.398 }, generatedAt: '', sources: [] }, buildings, roads, areas: [], trees: [] };
}
