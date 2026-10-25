/** Floating glass panel with a collapsible body. Collapse state is remembered per viewer. */
import { h } from './dom';
import { icon, type IconName } from './icons';

export interface Panel {
  el: HTMLElement;
  head: HTMLElement;
  /** Right side of the header, before the toggle (meta text, summary chips…). */
  meta: HTMLElement;
  /** Shown in the header only while collapsed. */
  summary: HTMLElement;
  body: HTMLElement;
  readonly collapsed: boolean;
  setCollapsed(c: boolean, remember?: boolean): void;
}

const STORE_KEY = 'argus.ui.collapsed';

function readStore(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function writeStore(id: string, v: boolean): void {
  try {
    const s = readStore();
    s[id] = v;
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — collapse just won't persist */
  }
}

export function createPanel(opts: { id: string; title: string; icon: IconName; className?: string }): Panel {
  const meta = h('div', { class: 'ag-panel__meta' });
  const summary = h('div', { class: 'ag-panel__summary' });
  const toggle = h('button', { class: 'ag-iconbtn ag-panel__toggle', type: 'button', 'aria-expanded': 'true', 'aria-label': `Collapse ${opts.title}` }, icon('chevron'));
  const titleEl = h('h2', { class: 'ag-panel__title' }, h('span', { class: 'ag-panel__icon' }, icon(opts.icon)), h('span', { class: 'ag-label' }, opts.title));
  const head = h('header', { class: 'ag-panel__head' }, titleEl, summary, meta, toggle);
  const inner = h('div', { class: 'ag-panel__inner' });
  const bodyWrap = h('div', { class: 'ag-panel__body' }, inner);
  const el = h('section', { class: `ag-panel ${opts.className ?? ''}`, 'aria-label': opts.title }, head, bodyWrap);

  let collapsed = false;
  const panel: Panel = {
    el,
    head,
    meta,
    summary,
    body: inner,
    get collapsed() {
      return collapsed;
    },
    setCollapsed(c, remember = true) {
      collapsed = c;
      el.dataset.collapsed = String(c);
      toggle.setAttribute('aria-expanded', String(!c));
      toggle.setAttribute('aria-label', `${c ? 'Expand' : 'Collapse'} ${opts.title}`);
      if (remember) writeStore(opts.id, c);
    },
  };
  toggle.addEventListener('click', () => panel.setCollapsed(!collapsed));
  // Clicking the title row also toggles (bigger target), but not when clicking controls inside the header.
  head.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button, a, input')) return;
    panel.setCollapsed(!collapsed);
  });
  panel.setCollapsed(readStore()[opts.id] ?? false, false);
  return panel;
}
