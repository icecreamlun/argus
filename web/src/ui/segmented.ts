/** Segmented control with a sliding selection indicator. */
import { h } from './dom';

export interface Segmented<T extends string | number> {
  el: HTMLElement;
  value: T;
  set(v: T): void;
}

export function createSegmented<T extends string | number>(
  options: { value: T; label: string; title?: string }[],
  initial: T,
  onChange: (v: T) => void,
  ariaLabel: string,
): Segmented<T> {
  const thumb = h('span', { class: 'ag-seg__thumb', 'aria-hidden': 'true' });
  const buttons = options.map((o) =>
    h('button', { class: 'ag-seg__btn', type: 'button', role: 'radio', 'aria-checked': 'false', title: o.title, dataset: { v: String(o.value) } }, o.label),
  );
  const el = h('div', { class: 'ag-seg', role: 'radiogroup', 'aria-label': ariaLabel, style: { '--n': String(options.length) } as Partial<CSSStyleDeclaration> }, thumb, ...buttons);

  const seg: Segmented<T> = {
    el,
    value: initial,
    set(v) {
      seg.value = v;
      const i = Math.max(0, options.findIndex((o) => o.value === v));
      el.style.setProperty('--i', String(i));
      buttons.forEach((b, j) => {
        b.setAttribute('aria-checked', String(j === i));
        b.classList.toggle('is-on', j === i);
      });
    },
  };
  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      const v = options[i].value;
      if (v === seg.value) return;
      seg.set(v);
      onChange(v);
    }),
  );
  seg.set(initial);
  return seg;
}
