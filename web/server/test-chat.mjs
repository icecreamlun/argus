#!/usr/bin/env node
/**
 * End-to-end test of POST /api/chat (M5 Argus Copilot) with a realistic CopilotSituation:
 *  1. loads the app headless at --t (default 760 s) with the 1906 quake and air=replay (all heli + drone recon);
 *  2. builds the CopilotSituation in-page: uses the router/situation module if the app exposes one
 *     (window.__argus.handles.copilot.situation() / buildCopilotSituation), else constructs one by hand from
 *     recon.observations() / observedRoads() / observedCrowds() + unscanned planner candidates + real SF
 *     facilities, with straight-line × 1.35 road ETAs (roadMin null for one site to exercise helicopters);
 *  3. POSTs three questions (Chinese allocation, EN trapped count, EN follow-up with history) and prints latency,
 *     reply, plan; checks every incidentId / fromFacilityId exists and that replies cite real numbers;
 *  4. prints the mock (src/rescue/chatMock.ts) answer for each question for comparison.
 *
 * Usage (dev server running): node server/test-chat.mjs [--t 760] [--fresh] [--mode auto|replay-only] [--dump situation.json] [--mock-only]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const BASE = opt('base', 'http://127.0.0.1:5173');
const T = Number(opt('t', 760));
const MODE = opt('mode', 'auto');
const FRESH = args.includes('--fresh');
const DUMP = opt('dump', '');
const MOCK_ONLY = args.includes('--mock-only');

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[pageerror]', e.message));
await page.goto(`${BASE}/?tod=15&quake=san_andreas_1906&t=${T}&air=replay&ui=0`);
await page.waitForFunction(() => window.__argus?.ready || window.__argus?.error, null, { timeout: 120000 });
await page.waitForFunction(() => (window.__argus.handles?.recon?.stats?.().buildingsObserved ?? 0) > 0, null, { timeout: 60000 }).catch(() => console.warn('no recon results revealed'));
// Drone results replay asynchronously too; give them a moment.
await page.waitForTimeout(4000);

const { situation, source } = await page.evaluate(async (T) => {
  const a = window.__argus;
  const h = a.handles;
  // 1. Prefer the app's own situation builder (router engineer).
  try {
    if (h.copilot?.situation) return { situation: await h.copilot.situation(), source: 'handles.copilot.situation()' };
    if (h.copilot?.buildSituation) return { situation: await h.copilot.buildSituation(), source: 'handles.copilot.buildSituation()' };
  } catch (e) {
    console.warn('copilot situation failed', e);
  }
  for (const p of ['/src/rescue/situation.ts', '/src/app/copilotSession.ts']) {
    try {
      const m = await import(p);
      if (typeof m.buildCopilotSituation === 'function' && h.router) {
        return { situation: await m.buildCopilotSituation({ ...h, city: a.ctx.city, result: a.result, simS: T }), source: `${p} buildCopilotSituation` };
      }
    } catch {}
  }

  // 2. Hand-built situation (Argon observations + blind model risk; NEVER truth).
  const { recon, scan, heli } = h;
  const planner = await import('/src/argus/planner.ts');
  const geo = await import('/src/geo.ts');
  const { occupantsAt } = await import('/src/quake/model/damage.ts');
  const city = a.ctx.city;
  const result = a.result;
  const hour = result.scenario.localHour;
  const bById = new Map(city.buildings.map((b) => [b.id, b]));
  const centre = (b) => {
    let x = 0, z = 0;
    for (const p of b.footprint) { x += p[0]; z += p[1]; }
    return [Math.round(x / b.footprint.length), Math.round(z / b.footprint.length)];
  };
  const obs = recon.observations?.() ?? new Map();
  const ev = (o) => (o.source === 'drone' ? `drone ${o.droneId ?? ''} · ${o.missionId ?? ''} · t+${Math.round(o.evidenceS)} s` : `AIR 1 chunk ${o.chunkIndex} · t+${Math.round(o.evidenceS)} s`);
  const incidents = [];
  for (const o of obs.values()) {
    const b = bById.get(o.id);
    if (!b) continue;
    const severe = o.damage === 'collapsed' || o.damage === 'extensive';
    let kind = null;
    if (o.trappedSigns || (o.peopleVisible > 0 && severe)) kind = 'trapped';
    else if (o.fire) kind = 'fire';
    else if (o.damage === 'collapsed') kind = 'collapse';
    if (!kind) continue;
    const [x, z] = centre(b);
    incidents.push({
      id: `I-${b.id}`, kind, buildingId: b.id, label: planner.buildingLabelOf(b), x, z, verified: true,
      confidence: Math.round(o.confidence * 100) / 100, damage: o.damage, peopleSeen: o.peopleVisible || undefined,
      trappedSigns: o.trappedSigns || undefined, fire: o.fire || undefined, occupants: Math.round(occupantsAt(b, hour)), evidence: ev(o),
    });
  }
  (recon.observedCrowds?.() ?? []).slice(0, 4).forEach((c, k) => {
    const b = c.nearBuildingId ? bById.get(c.nearBuildingId) : null;
    if (!b) return;
    const [x, z] = centre(b);
    incidents.push({ id: `I-CROWD-${k + 1}`, kind: 'crowd', label: c.place ?? `near ${planner.buildingLabelOf(b)}`, x, z, verified: true, confidence: 0.8, crowdSize: c.approxCount, evidence: 'AIR 1' });
  });
  // Unverified model risk: top unscanned planner candidates.
  const flightS = T - 50;
  const st = recon.stats();
  const preq = planner.buildPlanRequest({
    city, result, recon, scanned: (i) => scan.isScanned(i), scannedFraction: scan.scannedFraction(),
    heliStatus: flightS >= heli.durationS ? 'complete' : 'scanning', chunksDone: st.chunksDone, chunksTotal: Math.ceil(heli.durationS / 15),
    simS: T, wave: 2, dronesAvailable: ['D1', 'D2', 'D3'],
  });
  preq.candidates.filter((c) => c.kind === 'unscanned' || c.kind === 'unassessed').slice(0, 5).forEach((c) => {
    incidents.push({
      id: `I-${c.buildingId ?? c.id}`, kind: 'suspected_collapse', buildingId: c.buildingId ?? c.buildingIds?.[0], label: c.label, x: c.x, z: c.z,
      verified: false, confidence: Math.round((1 - c.predicted.pDestroyed) * 50) / 100 + 0.2, occupants: c.occupants, pDestroyed: c.predicted.pDestroyed, evidence: 'model prediction (not yet observed)',
    });
  });

  const F = (id, kind, name, address, lat, lon, units) => {
    const [x, z] = geo.project(lat, lon);
    return { id, kind, name, address, lat, lon, x: Math.round(x), z: Math.round(z), units };
  };
  const facilities = [
    F('SFFD-13', 'fire_station', 'SFFD Station 13', '530 Sansome St', 37.7955, -122.4017, { engine: 1, truck: 1 }),
    F('SFFD-2', 'fire_station', 'SFFD Station 2', '1340 Powell St', 37.7978, -122.4105, { engine: 1 }),
    F('SFFD-41', 'fire_station', 'SFFD Station 41', '1325 Leavenworth St', 37.7934, -122.4157, { engine: 1 }),
    F('SFFD-35', 'fire_station', 'SFFD Station 35 (Fireboat)', 'Pier 22½', 37.7893, -122.3878, { engine: 1 }),
    F('SFFD-1', 'fire_station', 'SFFD Station 1', '935 Folsom St', 37.7786, -122.4045, { engine: 1, truck: 1, usar: 1 }),
    F('SFFD-8', 'fire_station', 'SFFD Station 8', '36 Bluxome St', 37.7765, -122.3955, { engine: 1, truck: 1 }),
    F('SFPD-CENTRAL', 'police_station', 'SFPD Central Station', '766 Vallejo St', 37.7986, -122.4098, { police: 30 }),
    F('SFPD-TENDERLOIN', 'police_station', 'SFPD Tenderloin Station', '301 Eddy St', 37.7838, -122.4128, { police: 25 }),
    F('HOSP-CHINESE', 'hospital', 'Chinese Hospital', '845 Jackson St', 37.7956, -122.4093, { ambulance: 2 }),
    F('HOSP-STFRANCIS', 'hospital', 'Saint Francis Memorial Hospital', '900 Hyde St', 37.7896, -122.4166, { ambulance: 3 }),
    F('HOSP-ZSFG', 'hospital', 'Zuckerberg SF General (Level I trauma)', '1001 Potrero Ave', 37.7557, -122.4048, { ambulance: 6 }),
    F('STAGE-EMB', 'staging', 'Embarcadero Plaza staging', '1 Market St', 37.7953, -122.3954, { usar: 1 }),
    F('HELI-PIER27', 'helipad', 'Pier 27 helipad', 'Pier 27', 37.8055, -122.403, { helicopter: 2 }),
  ];
  const roads = [];
  const segs = new Map();
  for (const r of recon.observedRoads?.() ?? []) {
    if (r.status === 'clear') continue;
    const n = (segs.get(r.street) ?? 0) + 1;
    segs.set(r.street, n);
    roads.push({ roadId: r.street, segment: n, name: r.street, status: r.status === 'blocked' ? 'verified_blocked' : 'partial', source: 'argon' });
  }
  // Two model-predicted likely blockages (URM debris on narrow streets).
  roads.push({ roadId: 'Grant Ave', segment: 1, name: 'Grant Ave', status: 'likely_blocked', source: 'model' });
  roads.push({ roadId: 'Jackson St', segment: 1, name: 'Jackson St', status: 'likely_blocked', source: 'model' });

  const unreachable = incidents.filter((i) => i.kind === 'trapped')[1]?.id; // one road-cut site → helicopter
  const travelTimes = [];
  for (const f of facilities) for (const i of incidents) {
    const d = Math.hypot(f.x - i.x, f.z - i.z);
    const roadMin = i.id === unreachable ? null : Math.round((1.5 + (d * 1.35) / 333) * 10) / 10;
    travelTimes.push({ fromFacilityId: f.id, incidentId: i.id, roadMin, airMin: Math.round((2 + d / 3333) * 10) / 10, passesLikelyBlocked: (f.id.length + i.id.length) % 5 === 0 });
  }
  const simH = hour + T / 3600;
  const hh = Math.floor(simH);
  const mm = Math.floor((simH - hh) * 60);
  const trapped = incidents.filter((i) => i.kind === 'trapped');
  return {
    source: 'hand-built (test-chat.mjs)',
    situation: {
      scenarioId: result.scenario.id,
      simS: T,
      localTime: `${hh}:${String(mm).padStart(2, '0')} PDT`,
      minutesSinceQuake: Math.round((T / 60) * 10) / 10,
      summary: {
        buildingsAssessed: st.buildingsObserved,
        collapsesVerified: st.collapsesObserved,
        peopleSeen: st.peopleObserved,
        trappedSitesVerified: trapped.length,
        fires: incidents.filter((i) => i.kind === 'fire' || i.fire).length,
        crowds: st.crowdsObserved,
        areaScannedPct: Math.round(scan.scannedFraction() * 1000) / 10,
        latestArgonSummary: st.lastSummary,
      },
      incidents,
      roads,
      facilities,
      travelTimes,
    },
  };
}, T);

if (DUMP) writeFileSync(DUMP, JSON.stringify(situation, null, 1));
const s = situation;
console.log(`situation from ${source}: ${s.localTime}, ${s.incidents.length} incidents (${s.incidents.filter((i) => i.verified).length} verified), ${s.roads.length} road statuses, ${s.facilities.length} facilities, ${s.travelTimes.length} travel times`);
console.log('summary', JSON.stringify(s.summary).slice(0, 400));
for (const i of s.incidents.slice(0, 40))
  console.log(`  ${i.id.padEnd(14)} ${i.kind.padEnd(18)} ${i.verified ? 'V' : '?'} conf ${i.confidence} ${i.damage ?? ''} people ${i.peopleSeen ?? '-'} occ ${i.occupants ?? '-'} ${i.label.slice(0, 60)}`);
console.log('roads:', [...new Set(s.roads.map((r) => `${r.name}:${r.status}`))].join(', '));

const incIds = new Set(s.incidents.map((i) => i.id));
const facIds = new Set(s.facilities.map((f) => f.id));
const questions = [
  '我现在有10辆消防车、20名警察、2架直升机、6辆救护车，如何安排救援路线和优先级？',
  'How many people are confirmed trapped and where?',
  'If Pine Street is cleared, what changes?',
];

function checkPlan(plan) {
  if (!plan) return 'plan: null';
  const bad = [];
  for (const p of plan.priorities) if (!incIds.has(p.incidentId)) bad.push(`priority ${p.incidentId}`);
  for (const a of plan.assignments) {
    if (!incIds.has(a.incidentId)) bad.push(`incident ${a.incidentId}`);
    if (!facIds.has(a.fromFacilityId)) bad.push(`facility ${a.fromFacilityId}`);
    if (!(a.count >= 1)) bad.push(`count ${a.count}`);
  }
  const tot = {};
  for (const a of plan.assignments) tot[a.unitType] = (tot[a.unitType] ?? 0) + a.count;
  return `ids ${bad.length ? 'INVALID: ' + bad.join(', ') : 'all valid'}; totals ${JSON.stringify(tot)}`;
}
function printPlan(plan) {
  if (!plan) return;
  console.log('  priorities:');
  for (const p of plan.priorities) console.log(`    ${p.rank}. ${p.incidentId} — ${p.reason}`);
  console.log('  assignments:');
  for (const a of plan.assignments) console.log(`    ${String(a.count).padStart(2)}× ${a.unitType.padEnd(10)} ${a.fromFacilityId.padEnd(16)} → ${a.incidentId.padEnd(14)} ${a.task}`);
  if (plan.routeClearing.length) console.log('  routeClearing:', plan.routeClearing.map((r) => `${r.roadName}(${r.unitType}): ${r.reason}`).join(' | '));
  console.log(`  reassess in ${plan.reassessInMinutes} min; assumptions: ${(plan.assumptions ?? []).join(' | ')}`);
}

const history = [];
let ok = true;
for (const q of questions) {
  history.push({ role: 'user', text: q });
  const req = { messages: [...history], situation: s, mode: MODE };
  console.log(`\n══════ Q${history.filter((m) => m.role === 'user').length}: ${q}`);
  const mock = await page.evaluate(async (req) => (await import('/src/rescue/chatMock.ts')).createMockChatResponse(req), req);
  console.log(`── mock (${mock.latencyMs} ms): ${checkPlan(mock.plan)}\n${mock.reply}`);
  printPlan(mock.plan);
  if (MOCK_ONLY) {
    history.push({ role: 'assistant', text: mock.reply });
    continue;
  }
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/chat${FRESH ? '?fresh=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const out = await r.json();
  console.log(`── /api/chat → HTTP ${r.status} in ${Date.now() - t0} ms (mode ${out.mode}, model latency ${out.latencyMs} ms, tokens ${JSON.stringify(out.usage ?? {})})`);
  if (!r.ok) {
    console.log(out);
    ok = false;
    history.push({ role: 'assistant', text: mock.reply });
    continue;
  }
  console.log(out.reply);
  printPlan(out.plan);
  console.log(`  check: ${checkPlan(out.plan)}${out.notes?.length ? `; notes: ${out.notes.join('; ')}` : ''}`);
  const nums = (out.reply.match(/\d+/g) ?? []).map(Number);
  const real = [s.summary.peopleSeen, s.summary.trappedSitesVerified, s.summary.collapsesVerified, s.summary.fires, ...s.incidents.map((i) => i.peopleSeen).filter(Boolean)];
  console.log(`  numbers cited: ${[...new Set(nums)].slice(0, 20).join(',')} — matches situation: ${[...new Set(nums.filter((n) => real.includes(n)))].join(',') || 'none'}`);
  history.push({ role: 'assistant', text: out.reply });
}
await browser.close();
process.exit(ok ? 0 : 1);
