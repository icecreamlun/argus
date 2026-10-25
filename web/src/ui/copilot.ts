/**
 * M5 "Argus Copilot" chat drawer (right column). The commander asks in natural language (often Chinese);
 * the app packages the Argon-verified situation, gemini-4-argon answers with markdown + a RescuePlan, and this
 * drawer renders the conversation, a plan card (priorities, routed assignments with road ETAs, route clearing)
 * and the Show-on-map / Dispatch decision. Model text is rendered through a tiny escaping markdown renderer.
 */
import type { ChatMessage, CopilotSituation, IncidentKind, RescueIncident, RescuePlan, UiHandlers, UnitType } from '../contracts';
import { h, setText } from './dom';
import { icon, type IconName } from './icons';
import { renderMarkdown, typeOut } from './markdown';
import { fmtInt, fmtSimTime } from './format';

export const UNIT_ORDER: UnitType[] = ['engine', 'truck', 'usar', 'ambulance', 'police', 'helicopter'];

/** Unit identity, shared with the 3D rescue layer for a consistent legend (hex colours). */
export const UNIT_META: Record<UnitType, { label: string; plural: string; icon: IconName; color: string }> = {
  engine: { label: 'Engine', plural: 'Engines', icon: 'uEngine', color: '#d7261e' },
  truck: { label: 'Ladder truck', plural: 'Ladder trucks', icon: 'uTruck', color: '#b3201a' },
  usar: { label: 'USAR team', plural: 'USAR teams', icon: 'uUsar', color: '#f2621b' },
  ambulance: { label: 'Ambulance', plural: 'Ambulances', icon: 'uAmbulance', color: '#2f9a5c' },
  police: { label: 'Police unit', plural: 'Police', icon: 'uPolice', color: '#2f6fdb' },
  helicopter: { label: 'Helicopter', plural: 'Helicopters', icon: 'uHeli', color: '#d9a514' },
};

/** Priority rank colours (P1 red, P2 orange, P3 amber, P4+ grey). */
export const PRIORITY_COLORS = ['#d7261e', '#f2621b', '#e3a512', '#8a9097'];

export const QUICK_PROMPTS = [
  'I have 10 fire engines, 20 police officers, 2 helicopters and 6 ambulances. How should I route them, and what are the priorities?',
  'How many people are confirmed trapped, and where?',
  'Which roads should police clear first?',
  'Where should the helicopters go?',
];

const KIND_ICON: Record<IncidentKind, IconName> = {
  trapped: 'trapped',
  fire: 'flame',
  suspected_collapse: 'collapse',
  collapse: 'collapse',
  crowd: 'people',
};

const MODE_LABEL: Record<NonNullable<ChatMessage['mode']>, string> = { gemini: 'Live', replay: 'Replay', mock: 'Mock' };
const MODE_TITLE: Record<NonNullable<ChatMessage['mode']>, string> = {
  gemini: 'Live gemini-4-argon answer',
  replay: 'Cached gemini-4-argon answer (replay)',
  mock: 'Argon unavailable: rule-based fallback answer',
};

export interface CopilotDrawer {
  el: HTMLElement;
  /** Top-bar launcher button (Copilot · C). */
  launcher: HTMLButtonElement;
  readonly open: boolean;
  /** notify=true reports the change through UiHandlers.onCopilotToggle (user actions). */
  setOpen(open: boolean, notify?: boolean): void;
  toggle(): void;
  setMessages(messages: ChatMessage[], situation: CopilotSituation | null): void;
  setThinking(thinking: boolean): void;
}

interface Rendered {
  msg: ChatMessage;
  row: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement | null;
  planSlot: HTMLElement | null;
  planKey: string;
  /** Situation snapshot taken when the plan card was first built (labels / ETAs stay stable). */
  planSit: CopilotSituation | null;
  typing: { finish(): void; readonly done: boolean } | null;
}

export function unitChip(t: UnitType, cls = ''): HTMLElement {
  return h('span', { class: `ag-unit ag-unit--${t} ${cls}`, title: UNIT_META[t].label }, icon(UNIT_META[t].icon));
}

function prioChip(rank: number): HTMLElement {
  const r = Math.max(1, Math.min(4, Math.round(rank)));
  return h('span', { class: `ag-prio ag-prio--${r}`, title: `Priority ${rank} (1 = highest)` }, `P${rank}`);
}

const fmtMin = (m: number) => (m < 1 ? '<1 min' : `${Math.round(m)} min`);

export function createCopilot(handlers: UiHandlers, onOpenChange: (open: boolean) => void): CopilotDrawer {
  // ── Header ──
  const mode = h('span', { class: 'ag-air__mode ag-cop__mode', dataset: { mode: 'none' }, hidden: true }, '–');
  const closeBtn = h('button', { class: 'ag-iconbtn ag-cop__close', type: 'button', 'aria-label': 'Close Copilot (C)', title: 'Close (C)' }, icon('close'));
  const subTime = h('span', { class: 'ag-cop__time' }, '');
  const head = h(
    'header',
    { class: 'ag-cop__head' },
    h('span', { class: 'ag-cop__mark' }, icon('spark')),
    h(
      'div',
      { class: 'ag-cop__titles' },
      h('span', { class: 'ag-label ag-cop__title' }, 'Argus Copilot'),
      h('span', { class: 'ag-cop__model' }, 'gemini-4-argon', subTime),
    ),
    mode,
    closeBtn,
  );

  // ── Live situation strip ──
  const stat = (ico: IconName, label: string, title: string) => {
    const v = h('b', { class: 'ag-cop__sv' }, '—');
    const cell = h('div', { class: 'ag-cop__stat', title }, h('span', { class: 'ag-cop__si' }, icon(ico)), h('div', {}, v, h('span', { class: 'ag-cop__sl' }, label)));
    return { cell, v };
  };
  const sCollapse = stat('collapse', 'collapses', 'Building collapses confirmed in Argon footage');
  const sPeople = stat('people', 'people seen', 'People seen by Argon (helicopter + drones)');
  const sFire = stat('flame', 'fires', 'Active fires reported');
  const sArea = stat('survey', 'scanned', 'Share of the study area covered by aerial recon');
  const sitStrip = h('div', { class: 'ag-cop__sit', 'aria-label': 'Live situation (Argon-verified)' }, sCollapse.cell, sPeople.cell, sFire.cell, sArea.cell);

  // ── Log ──
  const log = h('div', { class: 'ag-cop__log', role: 'log', 'aria-live': 'polite' });
  const empty = h(
    'div',
    { class: 'ag-cop__empty' },
    h('span', { class: 'ag-cop__emark' }, icon('spark')),
    h('p', { class: 'ag-cop__etitle' }, 'Plan the rescue with live data'),
    h(
      'p',
      { class: 'ag-cop__esub' },
      'Tell Copilot what units you have. It answers from Argon-verified observations, unverified model risk and road-network ETAs, never ground truth. Units move only after you Dispatch.',
    ),
    h(
      'div',
      { class: 'ag-cop__suggest' },
      ...QUICK_PROMPTS.map((q, i) =>
        h('button', { class: 'ag-cop__sugg', type: 'button', onclick: () => ask(q) }, icon(i === 0 ? 'route' : i === 1 ? 'trapped' : i === 2 ? 'roadBlock' : 'uHeli'), h('span', {}, q)),
      ),
    ),
  );
  const thinking = h(
    'div',
    { class: 'ag-cop__row ag-cop__row--ai ag-cop__thinking', hidden: true },
    h('span', { class: 'ag-cop__av' }, icon('spark')),
    h(
      'div',
      { class: 'ag-cop__bubble' },
      h('span', { class: 'ag-cop__shimmer' }, 'Argon is planning with live data…'),
      h('span', { class: 'ag-cop__tsub' }, ''),
    ),
  );
  const thinkSub = thinking.querySelector('.ag-cop__tsub') as HTMLElement;
  log.append(empty, thinking);

  // ── Legend (shown with a plan) ──
  const legend = h(
    'div',
    { class: 'ag-cop__legend', hidden: true },
    h(
      'div',
      { class: 'ag-cop__lrow' },
      ...(['engine', 'usar', 'ambulance', 'police', 'helicopter'] as UnitType[]).map((t) =>
        h('span', { class: 'ag-cop__litem' }, unitChip(t, 'ag-unit--xs'), t === 'engine' ? 'Fire' : UNIT_META[t].plural.replace(' teams', '')),
      ),
    ),
    h(
      'div',
      { class: 'ag-cop__lrow' },
      h('span', { class: 'ag-cop__litem' }, prioChip(1), prioChip(2), prioChip(3), 'priority'),
      h('span', { class: 'ag-cop__litem' }, h('span', { class: 'ag-cop__vdot is-ver' }), 'Argon-verified'),
      h('span', { class: 'ag-cop__litem' }, h('span', { class: 'ag-cop__vdot' }), 'model risk'),
    ),
  );

  // ── Composer ──
  const chips = h(
    'div',
    { class: 'ag-cop__chips', hidden: true },
    ...QUICK_PROMPTS.map((q) => h('button', { class: 'ag-cop__chip', type: 'button', title: q, onclick: () => ask(q) }, q)),
  );
  const input = h('textarea', {
    class: 'ag-cop__input',
    rows: 1,
    placeholder: 'Ask about units, routes, priorities…',
    'aria-label': 'Message Argus Copilot',
    spellcheck: 'false',
  }) as HTMLTextAreaElement;
  const send = h('button', { class: 'ag-cop__send', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', disabled: true }, icon('send'));
  const composer = h(
    'div',
    { class: 'ag-cop__compose' },
    chips,
    h('div', { class: 'ag-cop__box' }, input, send),
    h('div', { class: 'ag-cop__hint' }, h('span', {}, h('span', { class: 'ag-kbd' }, 'Enter'), ' send · ', h('span', { class: 'ag-kbd' }, 'Shift'), '+', h('span', { class: 'ag-kbd' }, 'Enter'), ' new line'), h('span', {}, 'Argon-verified data only')),
  );

  const el = h(
    'section',
    { class: 'ag-cop', 'aria-label': 'Argus Copilot', 'aria-hidden': 'true', dataset: { open: 'false' } },
    head,
    sitStrip,
    log,
    legend,
    composer,
  );
  el.inert = true;

  const launcher = h(
    'button',
    { class: 'ag-island ag-cop-launch', type: 'button', 'aria-expanded': 'false', title: 'Argus Copilot: plan the rescue with live data (C)' },
    h('span', { class: 'ag-cop-launch__mark' }, icon('spark')),
    h('span', { class: 'ag-cop-launch__label' }, 'Copilot'),
    h('span', { class: 'ag-kbd' }, 'C'),
  ) as HTMLButtonElement;

  // ── State ──
  let open = false;
  let isThinking = false;
  let thinkT0 = 0;
  let thinkTimer = 0;
  let primed = false;
  let situation: CopilotSituation | null = null;
  let pendingEcho: HTMLElement | null = null;
  let hoverId: string | null = null;
  const rendered = new Map<string, Rendered>();
  const dispatchedLocal = new Set<string>();
  const shownLocal = new Set<string>();

  function setOpen(o: boolean, notify = false) {
    if (open === o) return;
    open = o;
    el.dataset.open = String(o);
    el.setAttribute('aria-hidden', String(!o));
    el.inert = !o;
    launcher.setAttribute('aria-expanded', String(o));
    launcher.classList.toggle('is-on', o);
    onOpenChange(o);
    if (o) {
      window.setTimeout(() => {
        if (open && !isThinking) input.focus({ preventScroll: true });
        scrollToEnd(true);
      }, 60);
    } else {
      if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      highlight(null);
    }
    if (notify) handlers.onCopilotToggle?.(o);
  }

  launcher.addEventListener('click', () => setOpen(!open, true));
  closeBtn.addEventListener('click', () => setOpen(false, true));

  // ── Composer behaviour ──
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }
  function refreshSend() {
    send.disabled = isThinking || !input.value.trim();
  }
  input.addEventListener('input', () => {
    autosize();
    refreshSend();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      ask(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value.trim()) input.blur();
      else setOpen(false, true);
    }
  });
  send.addEventListener('click', () => ask(input.value));

  function ask(raw: string) {
    const text = raw.trim();
    if (!text || isThinking) return;
    finishTyping();
    input.value = '';
    autosize();
    refreshSend();
    // Optimistic echo until the app reflects the message back through setMessages().
    pendingEcho?.remove();
    pendingEcho = userRow(text, null);
    pendingEcho.classList.add('is-pending');
    log.insertBefore(pendingEcho, thinking);
    empty.hidden = true;
    scrollToEnd(true);
    handlers.onCopilotAsk?.(text);
  }

  // ── Hover → 3D highlight ──
  function highlight(id: string | null) {
    if (hoverId === id) return;
    hoverId = id;
    for (const n of el.querySelectorAll('.is-hl')) n.classList.remove('is-hl');
    if (id) for (const n of el.querySelectorAll(`[data-incident="${CSS.escape(id)}"]`)) n.classList.add('is-hl');
    handlers.onCopilotHighlight?.(id);
  }
  log.addEventListener('mouseover', (e) => {
    const t = (e.target as Element).closest<HTMLElement>('[data-incident]');
    highlight(t?.dataset.incident ?? null);
  });
  log.addEventListener('mouseleave', () => highlight(null));
  // Click while an answer types out = skip to the end.
  log.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button')) return;
    finishTyping();
  });

  // ── Scrolling ──
  let stick = true;
  log.addEventListener('scroll', () => {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  });
  function scrollToEnd(force = false) {
    if (force || stick) {
      log.scrollTop = log.scrollHeight;
      stick = true;
    }
  }

  function finishTyping() {
    for (const r of rendered.values()) r.typing?.finish();
  }

  // ── Rows ──
  function userRow(text: string, msg: ChatMessage | null): HTMLElement {
    const bubble = h('div', { class: 'ag-cop__bubble' });
    text.split('\n').forEach((l, i) => {
      if (i) bubble.append(h('br'));
      bubble.append(l);
    });
    return h(
      'div',
      { class: 'ag-cop__row ag-cop__row--user', dataset: msg ? { id: msg.id } : {} },
      bubble,
      msg ? h('div', { class: 'ag-cop__foot' }, fmtSimTime(msg.at)) : null,
    );
  }

  const incidentById = (sit: CopilotSituation | null, id: string): RescueIncident | undefined => sit?.incidents.find((i) => i.id === id);

  function mdOpts() {
    return {
      refPattern: /\bI-[A-Z0-9][A-Z0-9-]*\b/,
      refData: (tok: string) => (incidentById(situation, tok) ? tok : null),
    };
  }

  function assistantFoot(msg: ChatMessage): HTMLElement {
    const parts: (Node | string)[] = [];
    if (msg.mode) parts.push(h('span', { class: 'ag-cop__fmode', dataset: { mode: msg.mode }, title: MODE_TITLE[msg.mode] }, MODE_LABEL[msg.mode]));
    parts.push('gemini-4-argon');
    if (msg.latencyMs && msg.latencyMs > 0) parts.push(` · ${(msg.latencyMs / 1000).toFixed(1)} s`);
    parts.push(` · ${fmtSimTime(msg.at)}`);
    return h('div', { class: 'ag-cop__foot' }, ...parts);
  }

  function assistantRow(msg: ChatMessage, animate: boolean): Rendered {
    const body = h('div', { class: 'ag-md' }, renderMarkdown(msg.text, mdOpts()));
    const bubble = h('div', { class: 'ag-cop__bubble' }, body);
    const foot = assistantFoot(msg);
    const planSlot = h('div', { class: 'ag-cop__planslot' });
    const row = h(
      'div',
      { class: 'ag-cop__row ag-cop__row--ai', dataset: { id: msg.id } },
      h('span', { class: 'ag-cop__av', title: 'Argon' }, icon('spark')),
      h('div', { class: 'ag-cop__stack' }, bubble, planSlot, foot),
    );
    const r: Rendered = { msg, row, body, foot, planSlot, planKey: '', planSit: null, typing: null };
    if (animate) {
      row.classList.add('is-new');
      foot.classList.add('is-wait');
      const n = msg.text.length;
      const dur = Math.min(1200, 260 + n * 5);
      r.typing = typeOut(
        body,
        dur,
        () => {
          foot.classList.remove('is-wait');
          syncPlan(r, true);
          if (!r.msg.plan) scrollToEnd();
        },
        () => scrollToEnd(),
      );
    }
    return r;
  }

  function syncPlan(r: Rendered, entering = false) {
    if (!r.planSlot) return;
    if (r.typing && !r.typing.done) return; // plan appears once the text has typed out
    const plan = r.msg.plan;
    if (!plan) {
      r.planSlot.replaceChildren();
      r.planKey = '';
      return;
    }
    if (!r.planSit && situation) r.planSit = situation;
    const st = dispatchedLocal.has(r.msg.id) || r.msg.planState === 'dispatched' ? 'dispatched' : r.msg.planState === 'shown' || shownLocal.has(r.msg.id) ? 'shown' : 'none';
    const key = `${st}|${r.planSit ? 1 : 0}|${plan.assignments.length}|${plan.priorities.length}`;
    if (key === r.planKey) return;
    const firstBuild = r.planKey === '';
    r.planKey = key;
    const card = planCard(r.msg, plan, r.planSit, st);
    if (entering || firstBuild) card.classList.add('is-enter');
    r.planSlot.replaceChildren(card);
    // A freshly typed answer: bring the plan card's top into view (not just its Dispatch button).
    if (entering) {
      requestAnimationFrame(() => {
        const top = card.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 48;
        log.scrollTo({ top: Math.min(top, log.scrollHeight - log.clientHeight), behavior: 'smooth' });
      });
    }
  }

  // ── Plan card ──
  function planCard(msg: ChatMessage, plan: RescuePlan, sit: CopilotSituation | null, st: 'none' | 'shown' | 'dispatched'): HTMLElement {
    const rankOf = new Map(plan.priorities.map((p) => [p.incidentId, p.rank]));
    const incLabel = (id: string) => incidentById(sit, id)?.label ?? id;
    const facName = (id: string) => sit?.facilities.find((f) => f.id === id)?.name ?? id;
    const totalUnits = plan.assignments.reduce((a, x) => a + x.count, 0);
    const sites = new Set(plan.assignments.map((a) => a.incidentId)).size;

    // Priorities
    const prios = plan.priorities
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((p) => {
        const inc = incidentById(sit, p.incidentId);
        const ver = inc?.verified ?? false;
        return h(
          'div',
          { class: 'ag-cpl__prio', dataset: { incident: p.incidentId }, role: 'listitem' },
          prioChip(p.rank),
          h(
            'div',
            { class: 'ag-cpl__pbody' },
            h(
              'div',
              { class: 'ag-cpl__ptop' },
              inc ? icon(KIND_ICON[inc.kind], 'ag-cpl__kind') : null,
              h('span', { class: 'ag-cpl__plabel', title: incLabel(p.incidentId) }, incLabel(p.incidentId)),
              inc
                ? h(
                    'span',
                    { class: `ag-cpl__ver ${ver ? 'is-ver' : ''}`, title: ver ? `Seen by Argon${inc.evidence ? ` · ${inc.evidence}` : ''}` : 'Model-predicted risk, not yet seen' },
                    ver ? icon('check') : null,
                    ver ? 'Verified' : 'Model',
                  )
                : null,
            ),
            h('p', { class: 'ag-cpl__reason' }, p.reason),
          ),
        );
      });

    // Assignments grouped by unit type
    const groups = UNIT_ORDER.map((t) => ({ t, rows: plan.assignments.filter((a) => a.unitType === t) })).filter((g) => g.rows.length);
    const assign = groups.map(({ t, rows }) => {
      const n = rows.reduce((a, x) => a + x.count, 0);
      return h(
        'div',
        { class: 'ag-cpl__group', style: { '--uc': UNIT_META[t].color } as Partial<CSSStyleDeclaration> },
        h('div', { class: 'ag-cpl__ghead' }, unitChip(t), h('span', { class: 'ag-cpl__gname' }, UNIT_META[t].plural), h('span', { class: 'ag-cpl__gcount' }, `${n}`)),
        ...rows.map((a) => {
          const eta = etaFor(sit, a.unitType, a.fromFacilityId, a.incidentId);
          const rank = rankOf.get(a.incidentId);
          return h(
            'div',
            {
              class: 'ag-cpl__asg',
              dataset: { incident: a.incidentId },
              style: { '--pc': rank ? PRIORITY_COLORS[Math.min(3, rank - 1)] : 'var(--ag-line-2)' } as Partial<CSSStyleDeclaration>,
            },
            h('span', { class: 'ag-cpl__count' }, `${a.count}×`),
            h(
              'div',
              { class: 'ag-cpl__abody' },
              h(
                'div',
                { class: 'ag-cpl__path' },
                h('span', { class: 'ag-cpl__from', title: facName(a.fromFacilityId) }, facName(a.fromFacilityId)),
                icon('arrowRight', 'ag-cpl__arrow'),
                h('span', { class: 'ag-cpl__to', title: incLabel(a.incidentId) }, incLabel(a.incidentId)),
              ),
              h('p', { class: 'ag-cpl__task' }, a.task),
            ),
            h('span', { class: `ag-cpl__eta ${eta.cls}`, title: eta.title }, eta.text),
          );
        }),
      );
    });

    // Route clearing
    const clearing = plan.routeClearing.map((c) =>
      h(
        'div',
        { class: 'ag-cpl__clear' },
        icon('roadBlock', 'ag-cpl__cico'),
        h('div', { class: 'ag-cpl__abody' }, h('div', { class: 'ag-cpl__road' }, h('b', {}, c.roadName), unitChip(c.unitType, 'ag-unit--xs')), h('p', { class: 'ag-cpl__task' }, c.reason)),
      ),
    );

    const showBtn = h(
      'button',
      { class: `ag-btn ag-btn--ghost ag-cpl__show ${st !== 'none' ? 'is-armed' : ''}`, type: 'button', title: 'Draw routes and priorities on the 3D map' },
      icon(st !== 'none' ? 'check' : 'route'),
      st !== 'none' ? 'On map' : 'Show on map',
    );
    showBtn.addEventListener('click', () => {
      shownLocal.add(msg.id);
      handlers.onCopilotShowPlan?.(msg.id);
      const r = rendered.get(msg.id);
      if (r) syncPlan(r);
    });
    const dispatched = st === 'dispatched';
    const dispatchBtn = h(
      'button',
      { class: `ag-btn ag-btn--primary ag-cpl__dispatch ${dispatched ? 'is-done' : ''}`, type: 'button', disabled: dispatched },
      icon(dispatched ? 'check' : 'arrowRight'),
      dispatched ? 'Dispatched ✓' : `Dispatch ${totalUnits} unit${totalUnits === 1 ? '' : 's'}`,
    );
    dispatchBtn.addEventListener('click', () => {
      if (dispatchedLocal.has(msg.id)) return;
      dispatchedLocal.add(msg.id);
      shownLocal.add(msg.id);
      handlers.onCopilotDispatch?.(msg.id);
      const r = rendered.get(msg.id);
      if (r) syncPlan(r);
    });

    const section = (label: string, aside: string | null, ...kids: (HTMLElement | null)[]) =>
      h('div', { class: 'ag-cpl__sec' }, h('div', { class: 'ag-cpl__shead' }, h('span', { class: 'ag-label' }, label), aside ? h('span', { class: 'ag-cpl__aside' }, aside) : null), ...kids);

    return h(
      'div',
      { class: 'ag-cpl', dataset: { state: st } },
      h(
        'div',
        { class: 'ag-cpl__head' },
        h('span', { class: 'ag-cpl__hico' }, icon('route')),
        h('span', { class: 'ag-label ag-cpl__title' }, 'Rescue plan'),
        h('span', { class: 'ag-cpl__meta' }, `${totalUnits} units · ${sites} site${sites === 1 ? '' : 's'}`),
      ),
      prios.length ? section('Priorities', null, h('div', { class: 'ag-cpl__prios', role: 'list' }, ...prios)) : null,
      assign.length ? section('Assignments', 'road ETA', ...assign) : null,
      clearing.length ? section('Route clearing', null, ...clearing) : null,
      plan.assumptions?.length ? h('ul', { class: 'ag-cpl__assume' }, ...plan.assumptions.map((a) => h('li', {}, a))) : null,
      h(
        'div',
        { class: 'ag-cpl__actions' },
        showBtn,
        dispatchBtn,
      ),
      h(
        'p',
        { class: 'ag-cpl__note' },
        dispatched ? `Units en route · reassess in ${plan.reassessInMinutes} min` : `Nothing moves until you Dispatch · reassess in ${plan.reassessInMinutes} min`,
      ),
    );
  }

  function etaFor(sit: CopilotSituation | null, unit: UnitType, from: string, inc: string): { text: string; cls: string; title: string } {
    const tt = sit?.travelTimes.find((t) => t.fromFacilityId === from && t.incidentId === inc);
    if (!tt) return { text: '—', cls: 'is-na', title: 'No travel time computed' };
    if (unit === 'helicopter') return { text: `✈ ${fmtMin(tt.airMin)}`, cls: 'is-air', title: 'Direct flight time' };
    if (tt.roadMin === null) return { text: '⚠ blocked route', cls: 'is-blocked', title: 'No open road route: needs route clearing first' };
    if (tt.passesLikelyBlocked) return { text: `⚠ ${fmtMin(tt.roadMin)}`, cls: 'is-risk', title: 'Route passes a likely-blocked road (model, unverified)' };
    return { text: fmtMin(tt.roadMin), cls: '', title: 'Road-network ETA avoiding verified blockages' };
  }

  // ── Situation strip ──
  function renderSituation(s: CopilotSituation | null) {
    const sm = s?.summary;
    setText(sCollapse.v, sm ? fmtInt(sm.collapsesVerified) : '—');
    setText(sPeople.v, sm ? fmtInt(sm.peopleSeen) : '—');
    setText(sFire.v, sm ? fmtInt(sm.fires) : '—');
    setText(sArea.v, sm ? `${Math.round(sm.areaScannedPct)}%` : '—');
    sitStrip.classList.toggle('is-empty', !s);
    setText(subTime, s ? ` · ${s.localTime} · T+${Math.round(s.minutesSinceQuake)} min` : '');
  }

  function thinkingText() {
    const s = situation;
    const secs = isThinking ? Math.max(0, (performance.now() - thinkT0) / 1000) : 0;
    const what = s
      ? `${s.incidents.length} incidents · ${s.roads.length} road reports · ${s.facilities.length} facilities`
      : 'verified incidents · roads · facilities';
    setText(thinkSub, `${what} · ${secs.toFixed(0)} s`);
  }

  // ── Public ──
  function setMessages(messages: ChatMessage[], sit: CopilotSituation | null) {
    situation = sit;
    renderSituation(sit);
    pendingEcho?.remove();
    pendingEcho = null;
    const before = rendered.size;
    let added = 0;
    const seen = new Set<string>();
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    for (const msg of messages) {
      seen.add(msg.id);
      let r = rendered.get(msg.id);
      if (!r) {
        if (msg.role === 'user') {
          r = { msg, row: userRow(msg.text, msg), body: null as unknown as HTMLElement, foot: null, planSlot: null, planKey: '', planSit: null, typing: null };
        } else {
          r = assistantRow(msg, primed && msg.id === lastId);
        }
        rendered.set(msg.id, r);
        added++;
      } else if (r.msg.text !== msg.text && msg.role === 'assistant') {
        r.typing?.finish();
        r.body.replaceChildren(renderMarkdown(msg.text, mdOpts()));
      }
      if (msg.role === 'assistant' && r.foot && (r.msg.mode !== msg.mode || r.msg.latencyMs !== msg.latencyMs)) {
        const f = assistantFoot(msg);
        if (r.foot.classList.contains('is-wait')) f.classList.add('is-wait');
        r.foot.replaceWith(f);
        r.foot = f;
      }
      r.msg = msg;
      log.insertBefore(r.row, thinking); // keeps DOM order = message order
      if (msg.role === 'assistant') syncPlan(r);
    }
    for (const [id, r] of rendered) {
      if (seen.has(id)) continue;
      r.typing?.finish();
      r.row.remove();
      rendered.delete(id);
      dispatchedLocal.delete(id);
      shownLocal.delete(id);
    }
    empty.hidden = messages.length > 0;
    chips.hidden = messages.length === 0;
    const lastAi = [...messages].reverse().find((m) => m.role === 'assistant');
    const m = lastAi?.mode ?? null;
    mode.hidden = !m;
    if (m) {
      mode.dataset.mode = m;
      setText(mode, MODE_LABEL[m]);
      mode.title = MODE_TITLE[m];
    }
    legend.hidden = !messages.some((x) => x.plan);
    primed = true;
    if (added || rendered.size !== before) scrollToEnd(true);
  }

  function setThinking(t: boolean) {
    if (isThinking === t) return;
    isThinking = t;
    thinking.hidden = !t;
    el.classList.toggle('is-thinking', t);
    window.clearInterval(thinkTimer);
    if (t) {
      thinkT0 = performance.now();
      thinkingText();
      thinkTimer = window.setInterval(thinkingText, 500);
      empty.hidden = true;
    } else if (open) {
      window.setTimeout(() => input.focus({ preventScroll: true }), 30);
    }
    refreshSend();
    for (const c of el.querySelectorAll<HTMLButtonElement>('.ag-cop__chip, .ag-cop__sugg')) c.disabled = t;
    scrollToEnd(true);
  }

  renderSituation(null);

  return {
    el,
    launcher,
    get open() {
      return open;
    },
    setOpen,
    toggle: () => setOpen(!open, true),
    setMessages,
    setThinking,
  };
}
