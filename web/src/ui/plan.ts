/**
 * M4 "Argon plan" card: the commander's decision moment. Argon (gemini-4-argon) proposes drone missions over the
 * most uncertain parts of the picture; the sim pauses until the commander approves (A) or rejects (X). Once
 * approved the card collapses into per-mission progress driven by the deterministic drone schedule.
 */
import { focusBuilding } from './focus';
import type { CityData, DroneId, DroneMission, DronePlan, DroneScheduleEntry, PlanUiState, UiHandlers } from '../contracts';
import { h, setText } from './dom';
import { icon } from './icons';
import { buildingTitle } from './format';
import { DRONE_COLORS, DRONE_IDS } from './droneFeeds';

export interface PlanInfo {
  schedule?: DroneScheduleEntry[];
  simS?: number;
  wavesUsed?: number;
}

const MAX_WAVES = 2;
const AUTO_HIDE_MS: Partial<Record<PlanUiState, number>> = { hold: 7000, rejected: 6000 };

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(t.type);
}

export function droneChip(id: DroneId): HTMLElement {
  return h('span', { class: 'ag-dchip', style: { '--dc': DRONE_COLORS[id] } as Partial<CSSStyleDeclaration> }, id);
}

export function createPlanCard(city: CityData, handlers: UiHandlers) {
  const recById = new Map(city.buildings.map((b) => [b.id, b]));
  const nameOf = (id: string) => {
    const rec = recById.get(id);
    return rec ? buildingTitle(rec).replace(/;[^ ]*/g, '') : id;
  };

  const title = h('span', { class: 'ag-label ag-plan__title' }, 'Argon plan');
  const mode = h('span', { class: 'ag-air__mode', dataset: { mode: 'none' } }, '–');
  const sub = h('div', { class: 'ag-plan__sub' }, '');
  const body = h('div', { class: 'ag-plan__body' });
  const el = h(
    'section',
    { class: 'ag-plan', hidden: true, 'aria-label': 'Argon drone plan', 'aria-live': 'polite', dataset: { state: 'thinking' } },
    h('header', { class: 'ag-plan__head' }, h('span', { class: 'ag-panel__icon' }, icon('drone')), title, mode),
    sub,
    body,
  );

  let state: PlanUiState = 'thinking';
  let plan: DronePlan | null = null;
  let key = '';
  let hideTimer = 0;
  let decided = false;
  /** Executing view: per-mission rows updated every call without a rebuild. */
  let progRows: { entry: DroneScheduleEntry; phase: HTMLElement; fill: HTMLElement; eta: HTMLElement; row: HTMLElement }[] = [];
  let progFoot: HTMLElement | null = null;

  function decide(approve: boolean) {
    if (state !== 'proposed' || decided || el.hidden) return;
    decided = true;
    el.classList.add(approve ? 'is-approving' : 'is-rejecting');
    for (const b of el.querySelectorAll<HTMLButtonElement>('.ag-plan__actions button')) b.disabled = true;
    const btn = el.querySelector<HTMLElement>(approve ? '.ag-plan__approve .ag-plan__btnText' : '.ag-plan__reject .ag-plan__btnText');
    if (btn) setText(btn, approve ? 'Dispatching…' : 'Rejected');
    if (approve) handlers.onApprovePlan?.();
    else handlers.onRejectPlan?.();
  }

  window.addEventListener('keydown', (e) => {
    if (state !== 'proposed' || el.hidden || decided) return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      decide(true);
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      decide(false);
    }
  });

  const waveOf = (info?: PlanInfo) => plan?.wave ?? Math.min(MAX_WAVES, (info?.wavesUsed ?? 0) + 1);
  const wavesLine = (info?: PlanInfo) => `${info?.wavesUsed ?? 0} of ${MAX_WAVES} waves used`;

  function header(info?: PlanInfo) {
    setText(title, `Argon plan · Wave ${waveOf(info)}`);
    const m = plan?.mode ?? null;
    mode.dataset.mode = m ?? 'none';
    setText(mode, m === 'gemini' ? 'Live' : m === 'replay' ? 'Replay' : m === 'mock' ? 'Mock' : '···');
    mode.hidden = !m;
    mode.title = m === 'mock' ? 'Argon unavailable: rule-based fallback plan' : m === 'replay' ? 'Cached Argon plan' : m === 'gemini' ? 'Live gemini-4-argon plan' : 'Waiting for Argon';
    const model = plan?.model || 'gemini-4-argon';
    const lat = plan && plan.latencyMs > 0 ? ` · planned in ${(plan.latencyMs / 1000).toFixed(1)} s` : '';
    setText(sub, state === 'thinking' ? `${model} · text-only planning` : `${model}${lat}`);
  }

  function missionRow(m: DroneMission): HTMLElement {
    const names = m.targetBuildingIds.map(nameOf);
    const row = h(
      'div',
      { class: 'ag-plan__mission', role: 'listitem', style: { '--dc': DRONE_COLORS[m.droneId] } as Partial<CSSStyleDeclaration> },
      droneChip(m.droneId),
      h(
        'div',
        { class: 'ag-plan__mbody' },
        h(
          'div',
          { class: 'ag-plan__mtop' },
          h('span', { class: 'ag-plan__kind', title: m.kind === 'survey_area' ? 'Survey an area' : 'Verify buildings' }, icon(m.kind === 'survey_area' ? 'survey' : 'orbit'), m.kind === 'survey_area' ? 'Survey' : 'Verify'),
          h('span', { class: 'ag-plan__targets', title: names.join(' · ') }, names.join(' · ')),
        ),
        h('p', { class: 'ag-plan__purpose' }, m.purpose),
      ),
      h('span', { class: `ag-plan__prio ${m.priority <= 1 ? 'is-top' : ''}`, title: `Priority ${m.priority} (1 = highest)` }, `P${m.priority}`),
    );
    row.title = 'Show on map';
    row.addEventListener('click', () => focusBuilding(m.targetBuildingIds[0]));
    return row;
  }

  function note(ico: Parameters<typeof icon>[0], strong: string, text: string, cls = ''): HTMLElement {
    return h('div', { class: `ag-plan__note ${cls}` }, icon(ico), h('p', {}, h('b', {}, strong), text ? ` ${text}` : ''));
  }

  function buildProposed(p: DronePlan) {
    const missions = p.missions.slice().sort((a, b) => a.priority - b.priority || a.droneId.localeCompare(b.droneId));
    const used = new Set(missions.map((m) => m.droneId));
    const reserve = DRONE_IDS.filter((d) => !used.has(d));
    const approve = h(
      'button',
      { class: 'ag-btn ag-btn--primary ag-plan__approve', type: 'button' },
      icon('check'),
      h('span', { class: 'ag-plan__btnText' }, `Approve ${missions.length} mission${missions.length === 1 ? '' : 's'}`),
      h('span', { class: 'ag-kbd ag-kbd--inv' }, 'A'),
    );
    const reject = h('button', { class: 'ag-btn ag-btn--ghost ag-plan__reject', type: 'button' }, h('span', { class: 'ag-plan__btnText' }, 'Reject'), h('span', { class: 'ag-kbd' }, 'X'));
    approve.addEventListener('click', () => decide(true));
    reject.addEventListener('click', () => decide(false));
    body.replaceChildren(
      ...([
      h('p', { class: 'ag-plan__rationale' }, p.rationale),
      p.error ? note('alert', 'Note:', p.error, 'ag-plan__note--warn') : null,
      h('div', { class: 'ag-plan__lhead' }, h('span', { class: 'ag-label' }, `Proposed missions · ${missions.length}`), h('span', { class: 'ag-plan__aside' }, 'priority')),
      h('div', { class: 'ag-plan__missions', role: 'list' }, ...missions.map(missionRow)),
      reserve.length
        ? h('div', { class: 'ag-plan__reserve' }, ...reserve.map(droneChip), h('span', {}, 'held in reserve for the next wave'))
        : null,
      h('div', { class: 'ag-plan__paused' }, icon('pause'), h('span', {}, 'Simulation paused for approval'), h('span', { class: 'ag-plan__waves' }, wavesLine(lastInfo))),
      h('div', { class: 'ag-plan__actions' }, approve, reject),
      ].filter(Boolean) as HTMLElement[]),
    );
  }

  function buildProgress(info?: PlanInfo) {
    const sched = (info?.schedule ?? []).filter((e) => !plan || plan.missions.some((m) => m.id === e.missionId));
    progRows = sched
      .slice()
      .sort((a, b) => a.droneId.localeCompare(b.droneId))
      .map((entry) => {
        const span = Math.max(1, entry.endS - entry.startS);
        const segs = entry.targets.map((t) =>
          h('span', { class: 'ag-plan__seg', style: { left: `${(((t.arriveS - entry.startS) / span) * 100).toFixed(2)}%`, width: `${(((t.leaveS - t.arriveS) / span) * 100).toFixed(2)}%` } }),
        );
        const fill = h('span', { class: 'ag-plan__pfill' });
        const phase = h('span', { class: 'ag-plan__phase' }, '');
        const eta = h('span', { class: 'ag-plan__eta' }, '');
        const row = h(
          'div',
          { class: 'ag-plan__prow', style: { '--dc': DRONE_COLORS[entry.droneId] } as Partial<CSSStyleDeclaration> },
          droneChip(entry.droneId),
          h('div', { class: 'ag-plan__pmain' }, h('div', { class: 'ag-plan__ptop' }, phase, eta), h('div', { class: 'ag-plan__pbar' }, ...segs, fill)),
        );
        return { entry, phase, fill, eta, row };
      });
    body.replaceChildren(...progRows.map((r) => r.row));
    if (!progRows.length && plan) {
      body.append(
        ...plan.missions.map((m) =>
          h('div', { class: 'ag-plan__prow', style: { '--dc': DRONE_COLORS[m.droneId] } as Partial<CSSStyleDeclaration> }, droneChip(m.droneId), h('div', { class: 'ag-plan__pmain' }, h('span', { class: 'ag-plan__phase' }, `Dispatched · ${m.targetBuildingIds.map(nameOf).join(' · ')}`))),
        ),
      );
    }
    progFoot = h('div', { class: 'ag-plan__pfoot' }, '');
    body.append(progFoot);
  }

  function updateProgress(info?: PlanInfo) {
    const s = info?.simS ?? 0;
    let done = 0;
    let targetsDone = 0;
    let targetsTotal = 0;
    for (const r of progRows) {
      const e = r.entry;
      const n = e.targets.length;
      targetsTotal += n;
      let text: string;
      let eta = '';
      if (s < e.startS) {
        text = 'Launching from Embarcadero Plaza';
        eta = `in ${Math.ceil(e.startS - s)} s`;
      } else if (s >= e.endS) {
        text = `Done · ${n} target${n === 1 ? '' : 's'} inspected`;
        done++;
        targetsDone += n;
      } else {
        const lastLeave = n ? e.targets[n - 1].leaveS : e.startS;
        if (s >= lastLeave) {
          text = 'Returning to base';
          eta = `${Math.ceil(e.endS - s)} s`;
          targetsDone += n;
        } else {
          const i = e.targets.findIndex((t) => s < t.leaveS);
          const t = e.targets[i];
          targetsDone += i;
          if (s < t.arriveS) {
            text = `Transit → ${nameOf(t.buildingId)}`;
            eta = `${Math.ceil(t.arriveS - s)} s`;
          } else {
            text = `Orbit ${i + 1} of ${n} · ${nameOf(t.buildingId)}`;
            eta = `${Math.ceil(t.leaveS - s)} s`;
          }
        }
      }
      setText(r.phase, text);
      r.phase.title = text;
      setText(r.eta, eta);
      const f = Math.max(0, Math.min(1, (s - e.startS) / Math.max(1, e.endS - e.startS)));
      r.fill.style.transform = `scaleX(${f.toFixed(4)})`;
    }
    if (progFoot) {
      setText(
        progFoot,
        progRows.length ? `${targetsDone} of ${targetsTotal} targets inspected · ${done}/${progRows.length} drones home · ${wavesLine(info)}` : wavesLine(info),
      );
    }
  }

  let lastInfo: PlanInfo | undefined;
  function build(info?: PlanInfo) {
    lastInfo = info;
    progRows = [];
    progFoot = null;
    decided = false;
    el.classList.remove('is-approving', 'is-rejecting');
    const wave = waveOf(info);
    switch (state) {
      case 'thinking':
        body.replaceChildren(
          h(
            'div',
            { class: 'ag-plan__thinking' },
            h('span', { class: 'ag-plan__spin' }),
            h('div', {}, h('b', { class: 'ag-plan__shimmer' }, 'Argon is planning…'), h('span', {}, 'Weighing unscanned blocks, low-confidence calls and people at risk')),
          ),
        );
        break;
      case 'hold':
        body.replaceChildren(note('info', 'Argon recommends holding.', plan?.holdReason || plan?.rationale || 'No drone mission adds enough information right now.'));
        break;
      case 'proposed':
        if (plan) buildProposed(plan);
        break;
      case 'rejected':
        body.replaceChildren(note('close', 'Plan rejected.', `Drones stay at Embarcadero Plaza · ${wavesLine(info)}.`, 'ag-plan__note--muted'));
        break;
      case 'approved':
      case 'executing':
        buildProgress(info);
        break;
      case 'done': {
        const n = (info?.schedule ?? []).filter((e) => !plan || plan.missions.some((m) => m.id === e.missionId));
        const targets = n.reduce((a, e) => a + e.targets.length, 0) || plan?.missions.reduce((a, m) => a + m.targetBuildingIds.length, 0) || 0;
        const drones = new Set((n.length ? n : plan?.missions ?? []).map((e) => e.droneId)).size;
        body.replaceChildren(note('check', `Wave ${wave} complete.`, `${targets} target${targets === 1 ? '' : 's'} inspected by ${drones} drone${drones === 1 ? '' : 's'} · ${wavesLine(info)}.`, 'ag-plan__note--ok'));
        break;
      }
    }
  }

  return {
    el,
    get state() {
      return state;
    },
    get visible() {
      return !el.hidden;
    },
    set(p: DronePlan | null, s: PlanUiState, info?: PlanInfo) {
      if (!p && s !== 'thinking') {
        // null hides (thinking may arrive before a plan exists).
        window.clearTimeout(hideTimer);
        el.hidden = true;
        key = '';
        return;
      }
      plan = p;
      state = s;
      const k = `${s}|${p?.wave ?? ''}|${p?.createdAtSimS ?? ''}|${p?.missions.length ?? ''}|${info?.schedule?.length ?? 0}|${info?.wavesUsed ?? 0}`;
      if (k !== key) {
        key = k;
        window.clearTimeout(hideTimer);
        el.hidden = false;
        el.dataset.state = s;
        el.classList.toggle('is-compact', s !== 'proposed');
        el.classList.remove('is-enter');
        void el.offsetWidth;
        el.classList.add('is-enter');
        build(info);
        const ms = AUTO_HIDE_MS[s];
        if (ms) hideTimer = window.setTimeout(() => (el.hidden = true), ms);
      }
      header(info);
      if (s === 'approved' || s === 'executing') updateProgress(info);
    },
  };
}
