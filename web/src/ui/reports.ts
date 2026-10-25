/**
 * M6 "Resident reports" UI: toasts as community-app reports arrive (top-left of the scene, beside the Seismic
 * feed) and a compact collapsible COMMUNITY REPORTS panel in the left column. Each report shows its text, then an
 * Argon row that fills in when gemini-4-argon has linked it to a building (damage / trapped / credibility / note).
 * Reports are a low-weight evidence source: the drone planner and the Copilot never see them.
 */
import type { CityData, ObservedDamage, ReportItem, ReportsResponse } from '../contracts';
import { h, setText } from './dom';
import { icon } from './icons';
import { createPanel } from './panel';
import { buildingTitle, fmtInt } from './format';

export type ReportsStats = { received: number; analysed: number; buildings: number; mode: ReportsResponse['mode'] | null };

const TOAST_MS = 6000;
const TOAST_AFTER_ANALYSIS_MS = 4200;
const MAX_TOASTS = 3;
const LIST_MAX = 30;

/** ObservedDamage → xBD class (no damage / minor / major / destroyed), same mapping as the recon metrics. */
const XBD_OF: Record<ObservedDamage, { key: string; label: string }> = {
  none: { key: 'none', label: 'No damage' },
  slight: { key: 'minor', label: 'Minor' },
  moderate: { key: 'major', label: 'Major' },
  extensive: { key: 'major', label: 'Major' },
  collapsed: { key: 'destroyed', label: 'Destroyed' },
};
const LANG: Record<string, string> = { en: 'EN', zh: '中文', es: 'ES' };
const MODE: Record<string, string> = { gemini: 'Live', replay: 'Replay', mock: 'Mock' };

const tPlus = (s: number) => {
  const a = Math.max(0, Math.round(s));
  return `T+${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};

export function createReports(city: CityData, onSelect: (item: ReportItem) => void) {
  const recById = new Map(city.buildings.map((b) => [b.id, b]));
  const buildingLabel = (id: string) => {
    const b = recById.get(id);
    // OSM multi-number addresses ("874;876;878 Lombard Street") → "874–878 Lombard Street".
    return b ? buildingTitle(b).replace(/^(\d+)(?:;\d+)*;(\d+)/, '$1–$2').replace(/;/g, ', ') : `Building ${id}`;
  };

  // ── Shared pieces ──
  function damageChip(d: ObservedDamage | null) {
    if (!d) return null;
    const x = XBD_OF[d];
    return h('span', { class: `ag-rep__dmg ag-rep__dmg--${x.key}`, title: `Damage read by Argon: ${d} (xBD ${x.label.toLowerCase()})` }, h('span', { class: 'ag-rep__dmgDot' }), x.label);
  }
  function credMeter(c: number, compact = false) {
    const v = Math.max(0, Math.min(1, c));
    const lvl = v >= 0.7 ? 'hi' : v >= 0.4 ? 'mid' : 'lo';
    return h(
      'span',
      { class: `ag-rep__cred ag-rep__cred--${lvl}`, title: `Argon credibility ${Math.round(v * 100)}%` },
      compact ? null : h('span', { class: 'ag-rep__credLabel' }, 'Cred'),
      h('span', { class: 'ag-rep__credBar' }, h('span', { class: 'ag-rep__credFill', style: { transform: `scaleX(${v.toFixed(3)})` } })),
      h('b', {}, `${Math.round(v * 100)}%`),
    );
  }
  /** Argon verdict line(s) for a report (pending shimmer when the analysis has not arrived). */
  function argonRow(item: ReportItem, compact: boolean): HTMLElement {
    const a = item.analysis;
    if (!a) {
      return h('div', { class: 'ag-rep__argon is-pending' }, icon('spark'), h('span', { class: 'ag-rep__pending' }, 'Argon reading report…'));
    }
    const target = a.buildingId
      ? h('span', { class: 'ag-rep__bld', title: `${buildingLabel(a.buildingId)} (${a.buildingId})` }, compact ? null : icon('building'), buildingLabel(a.buildingId))
      : h('span', { class: 'ag-rep__bld is-none' }, icon(item.report.category === 'road' ? 'roadBlock' : 'pin'), item.report.category === 'road' ? 'Street report' : 'Not linked');
    const trapped = a.peopleTrapped > 0 ? h('span', { class: 'ag-rep__trapped' }, icon('trapped'), `${fmtInt(a.peopleTrapped)} trapped`) : null;
    const hazards = (compact ? [] : a.hazards.slice(0, 2)).map((z) => h('span', { class: 'ag-rep__haz' }, z));
    const dup = a.duplicateOf ? h('span', { class: 'ag-rep__haz is-dup' }, `dup ${a.duplicateOf}`) : null;
    // Compact (panel row): credibility rides on the first line; the second only appears for trapped / duplicates.
    const line1 = h('div', { class: 'ag-rep__line' }, icon('spark', 'ag-rep__spark'), target, damageChip(a.damage), compact ? credMeter(a.credibility, true) : null);
    const line2 = h('div', { class: 'ag-rep__line ag-rep__line--2' }, trapped, ...hazards, dup, compact ? null : credMeter(a.credibility));
    const note = !compact && a.note ? h('div', { class: 'ag-rep__note', title: a.note }, a.note) : null;
    return h('div', { class: `ag-rep__argon ${a.credibility < 0.4 ? 'is-doubt' : ''}` }, line1, line2, note);
  }

  // ── Toasts ──
  const toastsEl = h('div', { class: 'ag-rtoasts', 'aria-live': 'polite', 'aria-label': 'Resident reports' });
  type Toast = { el: HTMLElement; argon: HTMLElement; item: ReportItem; due: number; left: number; hover: boolean; timer: number };
  const toasts = new Map<string, Toast>();

  function buildToast(item: ReportItem): Toast {
    const r = item.report;
    const argon = h('div', { class: 'ag-rtoast__argon' }, argonRow(item, false));
    const el = h(
      'article',
      { class: 'ag-rtoast', role: 'button', tabindex: '0', 'aria-label': `Resident report ${r.id}` },
      h(
        'header',
        { class: 'ag-rtoast__head' },
        h('span', { class: 'ag-rtoast__ico' }, icon('phoneSignal')),
        h('span', { class: 'ag-label ag-rtoast__kind' }, 'Resident report'),
        h('span', { class: 'ag-rtoast__time' }, tPlus(r.simS)),
        h('span', { class: 'ag-rep__lang' }, LANG[r.lang] ?? r.lang.toUpperCase()),
        h('button', { class: 'ag-iconbtn ag-rtoast__x', type: 'button', 'aria-label': 'Dismiss report' }, icon('close')),
      ),
      h('p', { class: 'ag-rtoast__text', lang: r.lang, title: r.text }, `“${r.text}”`),
      h('div', { class: 'ag-rtoast__who' }, `— ${r.reporter}`, h('span', { class: 'ag-dim' }, ` · GPS ±${Math.round(r.accuracyM)} m`)),
      argon,
    );
    const t: Toast = { el, argon, item, due: 0, left: TOAST_MS, hover: false, timer: 0 };
    el.addEventListener('mouseenter', () => {
      t.hover = true;
      t.left = Math.max(1200, t.due - performance.now());
      window.clearTimeout(t.timer);
    });
    el.addEventListener('mouseleave', () => {
      t.hover = false;
      arm(t, t.left);
    });
    el.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.ag-rtoast__x')) return dismiss(r.id);
      openFor(t.item);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFor(t.item);
      }
    });
    return t;
  }
  function arm(t: Toast, ms: number) {
    window.clearTimeout(t.timer);
    t.due = performance.now() + ms;
    if (!t.hover) t.timer = window.setTimeout(() => dismiss(t.item.report.id), ms);
  }
  function dismiss(id: string) {
    const t = toasts.get(id);
    if (!t) return;
    toasts.delete(id);
    window.clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    window.setTimeout(() => t.el.remove(), 260);
  }
  function updateToast(t: Toast, item: ReportItem) {
    const hadAnalysis = !!t.item.analysis;
    t.item = item;
    if (!item.analysis || hadAnalysis) return;
    t.argon.replaceChildren(argonRow(item, false));
    t.argon.classList.remove('is-filled');
    void t.argon.offsetWidth;
    t.argon.classList.add('is-filled');
    t.el.dataset.severity = severityOf(item);
    // Give the commander time to read the verdict.
    if (!t.hover && t.due - performance.now() < TOAST_AFTER_ANALYSIS_MS) arm(t, TOAST_AFTER_ANALYSIS_MS);
  }
  function addToast(item: ReportItem) {
    const t = buildToast(item);
    t.el.dataset.severity = severityOf(item);
    toasts.set(item.report.id, t);
    toastsEl.prepend(t.el); // newest on top
    arm(t, TOAST_MS);
    // Keep at most MAX_TOASTS on screen: drop the oldest.
    const ids = [...toasts.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TOASTS))) dismiss(id);
  }
  function severityOf(item: ReportItem): string {
    const a = item.analysis;
    if (!a) return 'pending';
    if (a.peopleTrapped > 0 || a.damage === 'collapsed') return 'crit';
    if (a.damage === 'extensive' || a.damage === 'moderate' || a.hazards.length) return 'warn';
    return 'calm';
  }
  const importance = (it: ReportItem) => {
    const a = it.analysis;
    if (!a) return it.report.simS * 1e-6; // pending: newest first
    const dmg = a.damage ? ['none', 'slight', 'moderate', 'extensive', 'collapsed'].indexOf(a.damage) : 0;
    return 10 + (a.peopleTrapped > 0 ? 10 : 0) + dmg * 2 + a.credibility * 3;
  };

  // Burst throttle: a seek (or a whole batch) can deliver many reports in one frame — toast at most the
  // MAX_TOASTS most relevant new ones; the panel still lists everything.
  let pending: ReportItem[] = [];
  let flushQueued = false;
  function queue(item: ReportItem) {
    pending.push(item);
    if (flushQueued) return;
    flushQueued = true;
    window.setTimeout(flush, 90);
  }
  function flush() {
    flushQueued = false;
    const batch = pending;
    pending = [];
    // Last write per report wins.
    const latest = new Map<string, ReportItem>();
    for (const it of batch) latest.set(it.report.id, it);
    const fresh: ReportItem[] = [];
    for (const it of latest.values()) {
      const t = toasts.get(it.report.id);
      if (t) updateToast(t, it);
      else if (!seen.has(it.report.id) || (it.analysis && !seenAnalysed.has(it.report.id) && isNotable(it))) fresh.push(it);
      seen.add(it.report.id);
      if (it.analysis) seenAnalysed.add(it.report.id);
    }
    fresh.sort((a, b) => importance(b) - importance(a) || b.report.simS - a.report.simS);
    const show = fresh.slice(0, MAX_TOASTS).sort((a, b) => a.report.simS - b.report.simS);
    for (const it of show) addToast(it);
  }
  /** An analysis that arrives after its toast is gone re-pops only when it matters (trapped / heavy damage). */
  const isNotable = (it: ReportItem) => !!it.analysis && (it.analysis.peopleTrapped > 0 || it.analysis.damage === 'collapsed' || it.analysis.damage === 'extensive');
  const seen = new Set<string>();
  const seenAnalysed = new Set<string>();

  // ── Panel ──
  const panel = createPanel({ id: 'reports', title: 'Community reports', icon: 'phone', className: 'ag-reports' });
  panel.el.dataset.active = 'false';
  const modeBadge = h('span', { class: 'ag-rep__mode', dataset: { mode: 'none' } }, '–');
  const headCount = h('span', { class: 'ag-rep__headCount' }, '0');
  panel.meta.append(headCount, modeBadge);
  const sumCount = h('b', {}, '0');
  const sumBld = h('b', {}, '0');
  panel.summary.append(
    h('span', { class: 'ag-rep__sum', title: 'Reports received' }, icon('phone'), sumCount),
    h('span', { class: 'ag-rep__sum', title: 'Buildings informed' }, icon('building'), sumBld),
  );

  const stat = (label: string) => {
    const v = h('b', { class: 'ag-rep__statV' }, '0');
    return { v, el: h('div', { class: 'ag-rep__stat' }, v, h('span', { class: 'ag-rep__statL' }, label)) };
  };
  const sRecv = stat('Received');
  const sAna = stat('Analysed by Argon');
  const sBld = stat('Buildings informed');
  const list = h('ol', { class: 'ag-rep__list' });
  const empty = h('p', { class: 'ag-rep__empty' }, 'Waiting for reports from the community app…');
  panel.body.append(
    h('div', { class: 'ag-rep__stats' }, sRecv.el, sAna.el, sBld.el),
    h('p', { class: 'ag-rep__caption' }, icon('info'), 'Low-weight evidence for the damage model. Not used by drone planning or the Copilot.'),
    empty,
    list,
  );

  let lastSig = '';
  let flashId: string | null = null;
  function row(item: ReportItem): HTMLElement {
    const r = item.report;
    const li = h(
      'li',
      { class: 'ag-rep__row', dataset: { id: r.id, severity: severityOf(item) }, tabindex: '0', role: 'button', title: r.text },
      h(
        'div',
        { class: 'ag-rep__rowHead' },
        h('span', { class: 'ag-rep__rowTime' }, tPlus(r.simS)),
        h('span', { class: 'ag-rep__lang' }, LANG[r.lang] ?? r.lang),
        h('span', { class: 'ag-rep__rowText', lang: r.lang }, `“${r.text}”`),
      ),
      argonRow(item, true),
    );
    li.addEventListener('click', () => onSelect(item));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(item);
      }
    });
    return li;
  }

  function set(items: ReportItem[], stats: ReportsStats) {
    const active = items.length > 0 || stats.received > 0;
    panel.el.dataset.active = String(active);
    setText(sRecv.v, fmtInt(stats.received));
    setText(sAna.v, fmtInt(stats.analysed));
    setText(sBld.v, fmtInt(stats.buildings));
    setText(headCount, fmtInt(stats.received));
    setText(sumCount, fmtInt(stats.received));
    setText(sumBld, fmtInt(stats.buildings));
    modeBadge.dataset.mode = stats.mode ?? 'none';
    setText(modeBadge, stats.mode ? MODE[stats.mode] ?? stats.mode : '–');
    modeBadge.title = stats.mode === 'gemini' ? 'gemini-4-argon (live)' : stats.mode === 'replay' ? 'Recorded gemini-4-argon answers' : stats.mode === 'mock' ? 'Offline mock analysis' : '';
    empty.hidden = items.length > 0;
    // Re-render the list only when it changed.
    const latest = [...items].sort((a, b) => b.report.simS - a.report.simS || b.report.id.localeCompare(a.report.id)).slice(0, LIST_MAX);
    const sig = latest.map((it) => `${it.report.id}${it.analysis ? `:${it.analysis.buildingId}:${it.analysis.damage}:${it.analysis.peopleTrapped}:${it.analysis.credibility}` : ''}`).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    list.replaceChildren(...latest.map(row));
    if (flashId) highlightRow(flashId, false);
  }

  function highlightRow(id: string, scroll: boolean) {
    flashId = id;
    const li = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return;
    li.classList.remove('is-flash');
    void li.offsetWidth;
    li.classList.add('is-flash');
    if (scroll) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function openFor(item: ReportItem) {
    if (panel.collapsed) panel.setCollapsed(false, false);
    requestAnimationFrame(() => highlightRow(item.report.id, true));
    onSelect(item);
  }

  function reset() {
    for (const id of [...toasts.keys()]) dismiss(id);
    pending = [];
    seen.clear();
    seenAnalysed.clear();
    flashId = null;
    lastSig = '';
    set([], { received: 0, analysed: 0, buildings: 0, mode: null });
  }

  return {
    panel,
    el: panel.el,
    toastsEl,
    /** Toast a report (analysis null = just received; call again with the analysis to fill the Argon row). */
    show: queue,
    set,
    reset,
  };
}
