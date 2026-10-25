/**
 * M6 resident-reports session: simulated community-app posts (generated from the truth world) → batches →
 * POST /api/reports (gemini-4-argon links each to a building, reads damage / trapped / hazards, rates credibility)
 * → recon.applyReports (third, low-weight evidence source) + toasts / COMMUNITY REPORTS panel.
 *
 * Time base (seek-safe): reports are posted at their simS; batches are planned up front at FIXED sim times
 * (every BATCH_EVERY_S, or early once BATCH_MIN reports are pending), so batch contents — and the server cache
 * hash — are deterministic. A report is "received" once simS ≤ sim; its analysis shows once the batch's
 * revealS ≤ sim (recon time-gates the fusion the same way).
 *
 * Modes (?reports=, default follows ?air=):
 *   live    a batch is sent when the clock reaches its send time (playing or seeking); revealS = max(send, arrival sim);
 *           a failed batch falls back to the offline mock.
 *   replay  every batch is fetched at begin with mode 'replay-only'; a miss is asked live once, then mocked.
 *           revealS = send + recorded latency (deterministic).
 *   mock    offline keyword heuristic (createMockReportsResponse), revealS = send + MOCK_LAG_S.
 *   off     disabled.
 * Drone planning and the Copilot never see resident reports (recon keeps them out of observations()).
 */
import type { AppContext, CitizenReport, ObservedDamage, PeopleTruth, QuakeResult, ReconHandle, ReportItem, ReportsRequest, ReportsResponse, UiHandle } from '../contracts';
import { buildReportsRequest, generateReports } from '../truth/reports';
import { createMockReportsResponse } from '../argus/reportsMock';

export type ReportsMode = 'live' | 'replay' | 'mock' | 'off';

const BATCH_EVERY_S = 30;
/** A batch closes early once this many reports are pending. */
const BATCH_MIN = 15;
const MAX_IN_FLIGHT = 6;
const MOCK_LAG_S = 4;
/** On a jump (seek / deep link) only reports received or analysed this recently pop a toast. */
const TOAST_WINDOW_S = 25;
const REQUEST_TIMEOUT_MS = 150_000;
const DAMAGE: ObservedDamage[] = ['none', 'slight', 'moderate', 'extensive', 'collapsed'];
const XBD: Record<ObservedDamage, number> = { none: 0, slight: 1, moderate: 2, extensive: 2, collapsed: 3 };

export interface ReportsBatchLog {
  batchIndex: number;
  reports: number;
  sendS: number;
  status: 'planned' | 'sent' | 'done' | 'failed';
  /** Where the analysis came from (replay hit, live Gemini, mock fallback). */
  mode?: ReportsResponse['mode'];
  latencyMs?: number;
  revealS?: number;
  error?: string;
}

export interface ReportsEval {
  batches: number;
  analysed: number;
  /** Reports whose truthRef names a building. */
  withTruth: number;
  linkCorrect: number;
  damageExact: number;
  damageXbd: number;
  linkedNull: number;
  latencyMs: { mean: number; min: number; max: number };
  modes: Record<string, number>;
}

export interface ReportsSession {
  readonly mode: ReportsMode;
  begin(result: QuakeResult, truth: PeopleTruth | null): void;
  /** Call on every quake-tick (playing or seek). */
  tick(simSeconds: number, playing: boolean): void;
  reset(): void;
  /** All generated reports (with the hidden truthRef — debug / evaluation only). */
  readonly reports: readonly CitizenReport[];
  readonly log: readonly ReportsBatchLog[];
  /** Received reports at sim (default: now), analysis attached when revealed. */
  items(simSeconds?: number): ReportItem[];
  /** Audience / harness: Argon's link + damage accuracy vs the hidden truthRef over all analysed batches. */
  evaluate(): ReportsEval;
  /** Resolves when every planned batch has an analysis (replay / mock / a live run past the last send time). */
  settled(): Promise<void>;
}

export interface ReportsSessionDeps {
  ctx: AppContext;
  ui: UiHandle;
  recon: ReconHandle;
  /** Force the AIR panel / timeline to refresh (after a batch lands while paused). */
  refresh(): void;
}

interface Batch {
  index: number;
  reports: CitizenReport[];
  sendS: number;
  req?: ReportsRequest;
  res?: ReportsResponse;
  revealS?: number;
  log: ReportsBatchLog;
}

/** Deterministic batches: close at every BATCH_EVERY_S boundary, or early when BATCH_MIN are pending. */
function planBatches(reports: CitizenReport[]): Batch[] {
  const out: Batch[] = [];
  if (!reports.length) return out;
  let cur: CitizenReport[] = [];
  let boundary = (Math.floor(reports[0].simS / BATCH_EVERY_S) + 1) * BATCH_EVERY_S;
  const close = (sendS: number) => {
    const index = out.length;
    out.push({ index, reports: cur, sendS, log: { batchIndex: index, reports: cur.length, sendS, status: 'planned' } });
    cur = [];
  };
  for (const r of reports) {
    while (r.simS >= boundary) {
      if (cur.length) close(boundary);
      boundary += BATCH_EVERY_S;
    }
    cur.push(r);
    if (cur.length >= BATCH_MIN) close(Math.round(r.simS * 10) / 10);
  }
  if (cur.length) close(boundary);
  return out;
}

export function createReportsSession(deps: ReportsSessionDeps, opts: { mode: ReportsMode }): ReportsSession {
  const { ctx, ui, recon } = deps;
  const city = ctx.city;
  const mode = opts.mode;
  const parentOf = new Map<string, string>();
  for (const b of city.buildings) if (b.parentId) parentOf.set(b.id, b.parentId);
  const idIndex = new Map<string, number>();
  city.buildings.forEach((b, i) => idIndex.set(b.id, i));

  let gen = 0;
  let result: QuakeResult | null = null;
  let reports: CitizenReport[] = [];
  let byId = new Map<string, CitizenReport>();
  let batches: Batch[] = [];
  let batchOf = new Map<string, Batch>();
  let lastSim = -Infinity;
  let inFlight = 0;
  const queue: Batch[] = [];
  const toastedNew = new Set<string>();
  const toastedDone = new Set<string>();
  let panelKey = '';
  let shown = false;
  let settleWaiters: (() => void)[] = [];

  const reqFor = (b: Batch): ReportsRequest => {
    if (!b.req) b.req = buildReportsRequest(city, b.reports, b.index, result!.scenario.id, result!.scenario.localHour);
    return b.req;
  };

  function checkSettled() {
    if (!settleWaiters.length) return;
    if (batches.every((b) => b.res)) {
      const w = settleWaiters;
      settleWaiters = [];
      w.forEach((f) => f());
    }
  }

  /** A batch got its analysis: fuse it (recon gates on revealS) and refresh panels. */
  function land(b: Batch, res: ReportsResponse, revealS: number, myGen: number) {
    if (myGen !== gen || !result) return;
    b.res = res;
    b.revealS = revealS;
    b.log.status = res.mode === 'mock' && mode !== 'mock' ? 'failed' : 'done';
    b.log.mode = res.mode;
    b.log.revealS = Math.round(revealS * 10) / 10;
    recon.applyReports?.(res, b.reports, revealS);
    checkSettled();
    if (Number.isFinite(lastSim)) {
      deps.refresh();
      pushUi(lastSim);
    }
  }

  function mockFor(b: Batch): ReportsResponse {
    return createMockReportsResponse(reqFor(b), byId);
  }

  async function post(req: ReportsRequest): Promise<ReportsResponse> {
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: ac.signal });
      const j = (await r.json().catch(() => ({}))) as ReportsResponse & { error?: string };
      if (!r.ok || !Array.isArray(j.analyses)) {
        const e = new Error(j.error || `HTTP ${r.status}`) as Error & { status?: number };
        e.status = r.status;
        throw e;
      }
      return j;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function send(b: Batch, myGen: number) {
    inFlight++;
    b.log.status = 'sent';
    const t0 = performance.now();
    const sentAtSim = lastSim;
    let res: ReportsResponse;
    let revealS: number;
    try {
      if (mode === 'replay') {
        try {
          res = await post({ ...reqFor(b), mode: 'replay-only' });
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err;
          console.info(`[reports] batch ${b.index}: no replay, asking Argon live`);
          res = await post({ ...reqFor(b), mode: 'auto' });
        }
        revealS = b.sendS + Math.max(0, res.latencyMs ?? 0) / 1000;
      } else {
        res = await post({ ...reqFor(b), mode: 'auto' });
        revealS = Math.max(b.sendS, Number.isFinite(lastSim) ? lastSim : sentAtSim);
      }
      b.log.latencyMs = res.latencyMs;
      console.info(`[reports] batch ${b.index}: ${res.mode} ${res.analyses.filter((a) => a.buildingId).length}/${b.reports.length} linked, Argon ${((res.latencyMs ?? 0) / 1000).toFixed(1)} s, wall ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      console.warn(`[reports] batch ${b.index} failed (${msg}); using mock analysis`);
      b.log.error = msg;
      res = { ...mockFor(b), error: msg };
      revealS = mode === 'replay' ? b.sendS + MOCK_LAG_S : Math.max(b.sendS, Number.isFinite(lastSim) ? lastSim : b.sendS);
    }
    inFlight = Math.max(0, inFlight - 1);
    if (myGen !== gen) return;
    land(b, res, revealS, myGen);
    pump();
  }

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) void send(queue.shift()!, gen);
  }

  // ── UI ──
  function itemsAt(sim: number): ReportItem[] {
    const out: ReportItem[] = [];
    for (const r of reports) {
      if (r.simS > sim + 1e-6) break;
      const b = batchOf.get(r.id);
      const a = b?.res && b.revealS !== undefined && b.revealS <= sim + 1e-6 ? (b.res.analyses.find((x) => x.reportId === r.id) ?? null) : null;
      out.push({ report: r, analysis: a });
    }
    return out;
  }

  function pushUi(sim: number) {
    if (!result || mode === 'off') return;
    const items = itemsAt(sim);
    const received = new Set(items.map((i) => i.report.id));
    // Backward seek: forget toasts of reports that are not received / analysed any more (re-toast going forward).
    for (const id of toastedNew) if (!received.has(id)) toastedNew.delete(id);
    const analysedIds = new Set(items.filter((i) => i.analysis).map((i) => i.report.id));
    for (const id of toastedDone) if (!analysedIds.has(id)) toastedDone.delete(id);

    for (const it of items) {
      const id = it.report.id;
      if (it.analysis) {
        if (toastedDone.has(id)) continue;
        toastedDone.add(id);
        const fresh = sim - (batchOf.get(id)?.revealS ?? sim) <= TOAST_WINDOW_S;
        // Analysed in the same jump it was received in: one toast with the analysis.
        if (fresh) ui.showReport?.(it);
        toastedNew.add(id);
      } else if (!toastedNew.has(id)) {
        toastedNew.add(id);
        if (sim - it.report.simS <= TOAST_WINDOW_S) ui.showReport?.(it);
      }
    }

    let lastMode: ReportsResponse['mode'] | null = null;
    let lastReveal = -Infinity;
    const linked = new Set<string>();
    let analysed = 0;
    for (const b of batches) {
      if (!b.res || b.revealS === undefined || b.revealS > sim + 1e-6) continue;
      if (b.revealS >= lastReveal) {
        lastReveal = b.revealS;
        lastMode = b.res.mode;
      }
    }
    for (const it of items) {
      if (!it.analysis) continue;
      analysed++;
      const a = it.analysis;
      if (a.buildingId && a.damage) linked.add(parentOf.get(a.buildingId) ?? a.buildingId);
    }
    const stats = { received: items.length, analysed, buildings: linked.size, mode: lastMode ?? (mode === 'mock' ? 'mock' : null) };
    const key = `${stats.received}|${stats.analysed}|${stats.buildings}|${stats.mode}`;
    if (key === panelKey) return;
    panelKey = key;
    ui.setReports?.(items, stats);
    shown = true;
  }

  function clearUi() {
    toastedNew.clear();
    toastedDone.clear();
    panelKey = '';
    if (shown) ui.setReports?.([], { received: 0, analysed: 0, buildings: 0, mode: null });
    shown = false;
  }

  const session: ReportsSession = {
    mode,
    get reports() {
      return reports;
    },
    get log() {
      return batches.map((b) => b.log);
    },
    begin(r, truth) {
      session.reset();
      if (mode === 'off') return;
      gen++;
      const myGen = gen;
      result = r;
      const t0 = performance.now();
      reports = generateReports(city, r, truth);
      byId = new Map(reports.map((x) => [x.id, x]));
      batches = planBatches(reports);
      batchOf = new Map();
      for (const b of batches) for (const x of b.reports) batchOf.set(x.id, b);
      console.info(`[reports] ${reports.length} resident reports in ${batches.length} batches (${(performance.now() - t0).toFixed(0)} ms, mode ${mode})`);
      if (mode === 'mock') {
        for (const b of batches) land(b, mockFor(b), b.sendS + MOCK_LAG_S, myGen);
      } else if (mode === 'replay') {
        queue.push(...batches);
        pump();
      }
    },
    tick(sim, _playing) {
      if (!result || mode === 'off') return;
      lastSim = sim;
      if (mode === 'live') {
        let added = false;
        for (const b of batches) {
          if (b.log.status !== 'planned' || b.sendS > sim + 1e-6) continue;
          b.log.status = 'sent';
          queue.push(b);
          added = true;
        }
        if (added) pump();
      }
      pushUi(sim);
    },
    reset() {
      gen++;
      result = null;
      reports = [];
      byId = new Map();
      batches = [];
      batchOf = new Map();
      queue.length = 0;
      inFlight = 0;
      lastSim = -Infinity;
      clearUi();
      const w = settleWaiters;
      settleWaiters = [];
      w.forEach((f) => f());
    },
    items(sim) {
      return itemsAt(sim ?? lastSim);
    },
    settled() {
      if (!batches.length || batches.every((b) => b.res)) return Promise.resolve();
      return new Promise((res) => settleWaiters.push(res));
    },
    evaluate() {
      const ev: ReportsEval = { batches: 0, analysed: 0, withTruth: 0, linkCorrect: 0, damageExact: 0, damageXbd: 0, linkedNull: 0, latencyMs: { mean: 0, min: 0, max: 0 }, modes: {} };
      const lat: number[] = [];
      const anchor = (id: string | null) => (id ? (parentOf.get(id) ?? id) : null);
      for (const b of batches) {
        if (!b.res) continue;
        ev.batches++;
        ev.modes[b.res.mode] = (ev.modes[b.res.mode] ?? 0) + 1;
        if (b.res.latencyMs) lat.push(b.res.latencyMs);
        for (const a of b.res.analyses) {
          ev.analysed++;
          if (!a.buildingId) ev.linkedNull++;
          const t = byId.get(a.reportId)?.truthRef;
          if (!t?.buildingId || !result) continue;
          ev.withTruth++;
          const tid = anchor(t.buildingId)!;
          if (anchor(a.buildingId) !== tid) continue;
          ev.linkCorrect++;
          const i = idIndex.get(tid);
          if (i === undefined || !a.damage) continue;
          const d = result.damage[i];
          const truthName = DAMAGE[d.collapsed ? 4 : d.state];
          if (a.damage === truthName) ev.damageExact++;
          if (XBD[a.damage] === XBD[truthName]) ev.damageXbd++;
        }
      }
      if (lat.length) ev.latencyMs = { mean: Math.round(lat.reduce((s, v) => s + v, 0) / lat.length), min: Math.min(...lat), max: Math.max(...lat) };
      return ev;
    },
  };
  return session;
}
