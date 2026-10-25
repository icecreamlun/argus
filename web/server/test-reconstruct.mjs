#!/usr/bin/env node
/**
 * End-to-end test of POST /api/reconstruct with a realistic helicopter chunk.
 *  1. loads the app headless with the 1906 quake seeked to --t (default 110 s);
 *  2. flies a short oblique "helicopter" path (~180 m AGL, ~45° down) over Chinatown / FiDi with
 *     window.__argus.setCamera, drawing a crude AR overlay (B#### · ADDRESS tags + street names) as DOM;
 *  3. screenshots each pose as a 960x540 JPEG, builds the candidate building list from __argus.ctx.city;
 *  4. POSTs the ReconstructionRequest and compares Argon's observation with __argus.result.damage (truth).
 *
 * Usage (dev server running): node server/test-reconstruct.mjs [--frames 10] [--t 110] [--mode auto|replay-only] [--dry]
 * Frames are saved to shots/server/chunk/ for inspection.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const BASE = opt('base', 'http://127.0.0.1:5173');
const N = Number(opt('frames', 10));
const T = Number(opt('t', 110));
const MODE = opt('mode', 'auto');
const DRY = args.includes('--dry');
const FRESH = args.includes('--fresh');
const OUT = resolve('shots/server/chunk');
mkdirSync(OUT, { recursive: true });

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log('health', health);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[pageerror]', e.message));
await page.goto(`${BASE}/?tod=15&quake=san_andreas_1906&t=${T}&ui=0`);
await page.waitForFunction(() => window.__argus?.ready || window.__argus?.error, null, { timeout: 120000 });

// Hard-coded test path: heli flies east along ~Sacramento/Clay St (north of the Stockton/Grant collapse cluster),
// gimbal looking south-ish & down ~45° at Stockton → Grant between California and Bush.
const HA = [-1010, 70];
const HB = [-610, 70];
const TA = [-930, 250];
const TB = [-640, 250];
const AGL = 165;

const waitFrames = (n) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        const f0 = window.__argus.frame;
        const tick = () => (window.__argus.frame >= f0 + n ? res() : requestAnimationFrame(tick));
        tick();
      }),
    n,
  );

const frames = [];
const buildingsById = new Map();
for (let k = 0; k < N; k++) {
  const s = N === 1 ? 0 : k / (N - 1);
  const x = HA[0] + (HB[0] - HA[0]) * s;
  const z = HA[1] + (HB[1] - HA[1]) * s;
  const tx = TA[0] + (TB[0] - TA[0]) * s + Math.sin(k * 0.9) * 25;
  const tz = TA[1] + (TB[1] - TA[1]) * s;
  const heading = Math.atan2(HB[0] - HA[0], -(HB[1] - HA[1])); // 0 = north (-Z), clockwise
  const info = await page.evaluate(
    ({ x, z, tx, tz, AGL, heading }) => {
      const a = window.__argus;
      const { city, terrain, camera } = a.ctx;
      const THREE = a.engineDebug.THREE;
      const gy = terrain.heightAt(x, z);
      const ty = terrain.heightAt(tx, tz);
      a.setCamera([x, gy + AGL, z], [tx, ty, tz]);
      a.renderOnce();
      camera.updateMatrixWorld();
      // ── crude AR overlay ──
      let ov = document.getElementById('ar-test');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'ar-test';
        ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99;font:600 11px/1.1 Menlo,monospace;color:#fff';
        document.body.appendChild(ov);
      }
      ov.innerHTML = '';
      const W = innerWidth;
      const H = innerHeight;
      const v = new THREE.Vector3();
      const ray = new THREE.Raycaster();
      const camPos = camera.position.clone();
      const short = (s) => (s ? s.split(';')[0].replace(/ Street$/, ' St').replace(/ Avenue$/, ' Ave') : '');
      const cands = [];
      city.buildings.forEach((b, i) => {
        if (b.isPart || b.context || b.height < 6) return;
        let cx = 0;
        let cz = 0;
        for (const p of b.footprint) {
          cx += p[0];
          cz += p[1];
        }
        cx /= b.footprint.length;
        cz /= b.footprint.length;
        const st = a.handles.buildings.getState(i);
        const top = b.baseElevation + Math.max(2, b.height * (1 - st.crush));
        const rubble = st.hidden > 0.5 || st.crush > 0.4;
        v.set(cx, top, cz);
        const dist = v.distanceTo(camPos);
        if (dist > 520) return;
        v.project(camera);
        if (v.z > 1 || Math.abs(v.x) > 0.92 || Math.abs(v.y) > 0.88) return;
        cands.push({ i, b, cx, cz, top, dist, rubble, sx: (v.x * 0.5 + 0.5) * W, sy: (-v.y * 0.5 + 0.5) * H });
      });
      // Occlusion: the roof centroid must pick this building (or one of its parts).
      const vis = [];
      for (const c of cands) {
        if (c.rubble) {
          vis.push(c); // rubble piles: the shrunken/hidden mesh may not pick; tag it anyway
          continue;
        }
        const target = new THREE.Vector3(c.cx, c.top - 0.5, c.cz);
        ray.set(camPos, target.clone().sub(camPos).normalize());
        ray.far = c.dist + 2;
        const id = a.handles.buildings.pick(ray);
        if (!id) continue;
        const j = a.handles.buildings.indexOf(id);
        const rec = city.buildings[j];
        if (id === c.b.id || rec?.parentId === c.b.id) vis.push(c);
      }
      vis.sort((p, q) => p.dist - q.dist);
      const tagged = [];
      const placed = [];
      for (const c of vis) {
        if (tagged.length >= 22) break;
        if (placed.some((p) => Math.abs(p[0] - c.sx) < 95 && Math.abs(p[1] - c.sy) < 16)) continue;
        placed.push([c.sx, c.sy]);
        const label = `${c.b.id}${c.b.address ? ' · ' + short(c.b.address) : c.b.name ? ' · ' + c.b.name : ''}`;
        const el = document.createElement('div');
        el.style.cssText = `position:absolute;left:${c.sx}px;top:${c.sy - 18}px;transform:translateX(-50%);white-space:nowrap;padding:1px 4px;background:rgba(0,0,0,.55);border:1px solid rgba(120,255,160,.9);color:#c8ffd8`;
        el.textContent = label;
        const dot = document.createElement('div');
        dot.style.cssText = `position:absolute;left:${c.sx - 2}px;top:${c.sy - 2}px;width:4px;height:4px;background:#7dffa0`;
        ov.appendChild(el);
        ov.appendChild(dot);
        tagged.push({
          id: c.b.id,
          tag: c.b.id,
          address: short(c.b.address) || undefined,
          name: c.b.name,
          x: Math.round(c.cx),
          z: Math.round(c.cz),
          height: Math.round(c.b.height),
          levels: c.b.levels,
          use: c.b.use,
        });
      }
      // Street labels: midpoint of each named road segment in view.
      const seen = new Set();
      for (const r of city.roads) {
        if (!r.name || seen.has(r.name)) continue;
        for (let s = 0; s < r.points.length - 1; s++) {
          const [x0, z0] = r.points[s];
          const [x1, z1] = r.points[s + 1];
          if (Math.hypot(x1 - x0, z1 - z0) < 40) continue;
          const mx = (x0 + x1) / 2;
          const mz = (z0 + z1) / 2;
          v.set(mx, terrain.heightAt(mx, mz) + 1, mz);
          if (v.distanceTo(camPos) > 450) continue;
          v.project(camera);
          if (v.z > 1 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) continue;
          seen.add(r.name);
          const el = document.createElement('div');
          el.style.cssText = `position:absolute;left:${(v.x * 0.5 + 0.5) * W}px;top:${(-v.y * 0.5 + 0.5) * H}px;transform:translate(-50%,-50%);color:#ffe066;text-shadow:0 0 3px #000,0 0 2px #000;font-size:12px;letter-spacing:1px`;
          el.textContent = r.name.toUpperCase();
          ov.appendChild(el);
          break;
        }
      }
      const bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;left:0;right:0;top:0;padding:3px 8px;background:rgba(0,0,0,.6);color:#9fe;font-size:11px';
      bar.textContent = `AIR 1 · SFPD   EO WFOV   ALT ${Math.round(camPos.y)} m   HDG ${Math.round(((heading * 180) / Math.PI + 360) % 360)}°`;
      ov.appendChild(bar);
      return { position: [camPos.x, camPos.y, camPos.z], tagged };
    },
    { x, z, tx, tz, AGL, heading },
  );
  await waitFrames(4);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 82 });
  writeFileSync(`${OUT}/f_${String(k).padStart(3, '0')}.jpg`, jpeg);
  for (const t of info.tagged) buildingsById.set(t.id, t);
  frames.push({
    index: k,
    flightS: k,
    simS: T + k,
    position: info.position,
    heading,
    jpegBase64: jpeg.toString('base64'),
    taggedBuildingIds: info.tagged.map((t) => t.id),
  });
  console.log(`frame ${k}: ${info.tagged.length} tags, ${(jpeg.length / 1024).toFixed(0)} KB`);
}

const truth = await page.evaluate((ids) => {
  const a = window.__argus;
  const out = {};
  for (const id of ids) {
    const i = a.handles.buildings.indexOf(id);
    const d = a.result.damage[i];
    out[id] = { state: d.state, collapsed: d.collapsed, fire: d.fire, failTimeS: d.failTimeS, pCol: d.exceedance[3] };
  }
  return out;
}, [...buildingsById.keys()]);
await browser.close();

const req = { chunkIndex: 0, scenarioId: 'san_andreas_1906', localHour: 15, frames, buildings: [...buildingsById.values()], mode: MODE };
const bodyStr = JSON.stringify(req);
console.log(`request: ${frames.length} frames, ${req.buildings.length} candidate buildings, ${(bodyStr.length / 1e6).toFixed(2)} MB`);
writeFileSync(`${OUT}/truth.json`, JSON.stringify(truth, null, 1));
writeFileSync(`${OUT}/req.json`, JSON.stringify({ ...req, frames: req.frames.map((f) => ({ ...f, jpegBase64: '' })) }));
if (DRY) process.exit(0);

const t0 = Date.now();
const res = await fetch(`${BASE}/api/reconstruct${FRESH ? '?fresh=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyStr });
const json = await res.json();
const wall = Date.now() - t0;
writeFileSync(`${OUT}/result.json`, JSON.stringify(json, null, 1));
if (!res.ok) {
  console.error('HTTP', res.status, json);
  process.exit(1);
}
console.log(`\nHTTP ${res.status} mode=${json.mode} model=${json.model} latency=${json.latencyMs} ms wall=${wall} ms usage=${JSON.stringify(json.usage)} notes=${JSON.stringify(json.notes)}`);
console.log(`observed ${json.buildings.length}/${req.buildings.length} buildings, ${json.roads.length} roads, ${json.crowds.length} crowds`);
console.log('summary:', json.summary);

const NAMES = ['none', 'slight', 'moderate', 'extensive', 'complete'];
const OBS = { none: 0, slight: 1, moderate: 2, extensive: 3, collapsed: 4 };
let exact = 0;
let within1 = 0;
let colHit = 0;
let colTruth = 0;
let colObs = 0;
for (const b of json.buildings) {
  const t = truth[b.id];
  const o = OBS[b.damage];
  if (o === t.state) exact++;
  if (Math.abs(o - t.state) <= 1) within1++;
  if (t.collapsed) colTruth++;
  if (b.damage === 'collapsed') colObs++;
  if (t.collapsed && b.damage === 'collapsed') colHit++;
  console.log(
    `  ${b.id.padEnd(6)} obs=${b.damage.padEnd(9)} c=${b.confidence.toFixed(2)} | truth=${NAMES[t.state]}${t.collapsed ? '(COLLAPSED)' : ''}${t.fire ? ' fire' : ''} | ppl=${b.peopleVisible}${b.trappedSigns ? ' TRAPPED' : ''}${b.fire ? ' FIRE' : ''}${b.smoke ? ' smoke' : ''} s=${b.evidenceS} | ${b.notes ?? ''}`,
  );
}
const n = json.buildings.length || 1;
const allColTruth = Object.values(truth).filter((t) => t.collapsed).length;
console.log(`\nexact ${(exact / n * 100).toFixed(0)}%  within-one ${(within1 / n * 100).toFixed(0)}%  collapses: truth(all candidates)=${allColTruth} truth(observed)=${colTruth} observed=${colObs} hit=${colHit}`);
for (const r of json.roads) console.log(`  road ${r.street}: ${r.status} s=${r.evidenceS} ${r.notes ?? ''}`);
for (const c of json.crowds) console.log(`  crowd ${c.place ?? '?'} ~${c.approxCount} s=${c.evidenceS}`);
