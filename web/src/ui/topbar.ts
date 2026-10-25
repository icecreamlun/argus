/** Slim top bar: brand, study area, scene clock + sim time, status pill. Three floating islands. */
import { h, setText } from './dom';
import { icon } from './icons';
import { fmtHoursSec, fmtSimTime } from './format';
import type { Phase } from './state';

const STATUS: Record<Phase, { label: string; cls: string }> = {
  monitoring: { label: 'Monitoring', cls: 'is-ok' },
  alert: { label: 'Earthquake', cls: 'is-alert' },
  shaking: { label: 'Earthquake', cls: 'is-alert' },
  aftermath: { label: 'Aftermath', cls: 'is-warn' },
};

export function createTopBar() {
  const brand = h(
    'div',
    { class: 'ag-island ag-brand' },
    h('span', { class: 'ag-brand__mark', html: '' }),
    h('span', { class: 'ag-brand__word' }, 'Argus'),
    h('span', { class: 'ag-brand__rule', 'aria-hidden': 'true' }),
    h('span', { class: 'ag-brand__tag' }, 'Seismic Situational Awareness'),
  );
  brand.querySelector('.ag-brand__mark')!.append(icon('logo'));

  const area = h(
    'div',
    { class: 'ag-island ag-area', title: 'Study area: Ferry Building (east) to Chinatown (west)' },
    icon('pin', 'ag-area__pin'),
    h('span', { class: 'ag-area__city' }, 'San Francisco'),
    h('span', { class: 'ag-area__sep', 'aria-hidden': 'true' }, '·'),
    h('span', { class: 'ag-area__span' }, 'Ferry Building', icon('arrowRight', 'ag-area__arrow'), 'Chinatown'),
  );

  const time = h('span', { class: 'ag-clock__time' }, '00:00:00');
  const tz = h('span', { class: 'ag-clock__tz' }, 'PDT');
  const tplus = h('span', { class: 'ag-clock__tplus', hidden: true }, 'T+0.0 s');
  const statusLabel = h('span', {}, 'Monitoring');
  const status = h('span', { class: 'ag-status is-ok', role: 'status' }, h('span', { class: 'ag-status__dot' }), statusLabel);
  const clock = h('div', { class: 'ag-island ag-clock' }, h('span', { class: 'ag-clock__group', title: 'Local time in the scene (Pacific)' }, time, tz), tplus, status);

  const el = h('header', { class: 'ag-top' }, brand, area, clock);

  return {
    el,
    setClock(hours: number) {
      setText(time, fmtHoursSec(hours));
    },
    setSimTime(s: number | null) {
      tplus.hidden = s === null;
      if (s !== null) setText(tplus, fmtSimTime(s));
    },
    setPhase(p: Phase) {
      const s = STATUS[p];
      status.className = `ag-status ${s.cls}`;
      setText(statusLabel, s.label);
    },
  };
}
