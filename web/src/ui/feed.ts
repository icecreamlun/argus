/**
 * Left panel "Seismic feed": monitoring status + live trace, USGS-style event card,
 * scenario cards, custom-event form and reset.
 */
import type { QuakeScenario, UiHandlers, UsgsEvent } from '../contracts';
import { CITY_ORIGIN, haversineKm } from '../geo';
import { h, replayClass, setText } from './dom';
import { icon } from './icons';
import { createPanel } from './panel';
import { createSeismogram, estimateMmi } from './seismogram';
import {
  ALERT_COLORS,
  alertLevelFor,
  eventDistance,
  fmtKm,
  fmtLatLon,
  fmtMagType,
  fmtOriginTime,
  type AlertLevel,
} from './format';
import type { Phase } from './state';

function magBadge(mag: number, magType: string, level: AlertLevel, size: 'lg' | 'md' = 'md'): HTMLElement {
  const c = ALERT_COLORS[level];
  return h(
    'div',
    { class: `ag-mag ag-mag--${size}`, style: { background: c.bg, color: c.ink }, title: `PAGER alert level: ${level}` },
    h('span', { class: 'ag-mag__num' }, mag.toFixed(1)),
    h('span', { class: 'ag-mag__type' }, fmtMagType(magType)),
  );
}

/** Same field layout as a USGS event page summary. */
function eventCard(e: UsgsEvent): HTMLElement {
  const p = e.properties;
  const [lon, lat, depth] = e.geometry.coordinates;
  const d = eventDistance(e);
  const level = alertLevelFor(e);
  return h(
    'article',
    { class: 'ag-event', 'aria-label': `Event ${p.title}` },
    h(
      'div',
      { class: 'ag-event__head' },
      magBadge(p.mag, p.magType, level, 'lg'),
      h(
        'div',
        { class: 'ag-event__titles' },
        h('div', { class: 'ag-event__title', title: `${p.title} (${e.id})` }, p.title),
        h('div', { class: 'ag-event__time' }, fmtOriginTime(p.time)),
      ),
    ),
    h(
      'div',
      { class: 'ag-event__chips' },
      h('span', { class: `ag-chip ${p.status === 'reviewed' ? 'ag-chip--ok' : ''}` }, icon(p.status === 'reviewed' ? 'check' : 'clock'), p.status === 'reviewed' ? 'Reviewed' : 'Automatic'),
      h('span', { class: 'ag-chip ag-chip--alert', style: { '--chip-c': ALERT_COLORS[level].bg } as Partial<CSSStyleDeclaration> }, h('span', { class: 'ag-chip__dot' }), `PAGER ${level}`),
      p.tsunami ? h('span', { class: 'ag-chip ag-chip--warn' }, 'Tsunami') : null,
    ),
    h(
      'dl',
      { class: 'ag-event__facts' },
      h('div', {}, h('dt', {}, 'Depth'), h('dd', {}, `${depth.toFixed(1)} km`)),
      h('div', {}, h('dt', {}, 'Distance'), h('dd', {}, `${fmtKm(d.km)} km `, h('span', { class: 'ag-dim' }, d.dir))),
      h('div', { class: 'ag-event__loc' }, h('dt', {}, 'Epicentre'), h('dd', { class: 'ag-mono' }, fmtLatLon(lat, lon))),
    ),
  );
}

export function createFeedPanel(handlers: UiHandlers) {
  const panel = createPanel({ id: 'feed', title: 'Seismic feed', icon: 'wave', className: 'ag-feed' });

  // ── Status + trace ──
  const stateWord = h('span', { class: 'ag-feed__state' }, 'Monitoring');
  const stateNet = h('span', { class: 'ag-feed__net' }, 'USGS NC network');
  const dot = h('span', { class: 'ag-live' });
  const status = h('div', { class: 'ag-feed__status' }, dot, stateWord, stateNet);
  const seis = createSeismogram();
  const seisCaption = h('span', {}, 'Ferry Building site');
  const seisReadout = h('span', { class: 'ag-seis__readout' }, 'synthetic');
  const seisWrap = h('div', { class: 'ag-feed__seis' }, seis.el, h('div', { class: 'ag-seis__caption' }, seisCaption, seisReadout));

  // ── Event slot ──
  const eventSlot = h('div', { class: 'ag-feed__event' });

  // ── Scenarios ──
  const scenarioList = h('div', { class: 'ag-scenarios', role: 'list' });
  const scenarioCount = h('span', { class: 'ag-count' }, '0');
  const scenarioToggle = h(
    'button',
    { class: 'ag-disclosure', type: 'button', 'aria-expanded': 'true' },
    h('span', { class: 'ag-label' }, 'Scenarios'),
    scenarioCount,
    icon('chevron', 'ag-disclosure__chev'),
  );
  const scenarioSection = h('div', { class: 'ag-section ag-section--scenarios', dataset: { open: 'true' } }, scenarioToggle, h('div', { class: 'ag-collapse' }, h('div', { class: 'ag-collapse__inner' }, scenarioList)));
  const setScenariosOpen = (open: boolean) => {
    scenarioSection.dataset.open = String(open);
    scenarioToggle.setAttribute('aria-expanded', String(open));
  };
  scenarioToggle.addEventListener('click', () => setScenariosOpen(scenarioSection.dataset.open !== 'true'));

  // ── Custom event form ──
  const field = (label: string, name: string, value: number, attrs: Record<string, string>, unit?: string) =>
    h(
      'label',
      { class: 'ag-field' },
      h('span', { class: 'ag-field__label' }, label),
      h('span', { class: 'ag-field__box' }, h('input', { class: 'ag-input', name, type: 'number', value: String(value), inputmode: 'decimal', ...attrs }), unit ? h('span', { class: 'ag-field__unit' }, unit) : null),
    );
  const magOut = h('output', { class: 'ag-range__out' }, '6.8');
  const magInput = h('input', { class: 'ag-range', type: 'range', name: 'mag', min: '4', max: '8.5', step: '0.1', value: '6.8', 'aria-label': 'Magnitude' });
  magInput.addEventListener('input', () => setText(magOut, Number(magInput.value).toFixed(1)));
  const formError = h('p', { class: 'ag-form__error', role: 'alert' });
  const form = h(
    'form',
    { class: 'ag-form', novalidate: true },
    h(
      'div',
      { class: 'ag-form__grid' },
      field('Latitude', 'lat', 37.7, { step: '0.01', min: '32', max: '42' }, '°'),
      field('Longitude', 'lon', -122.47, { step: '0.01', min: '-126', max: '-114' }, '°'),
      field('Depth', 'depth', 10, { step: '1', min: '0', max: '60' }, 'km'),
      h('label', { class: 'ag-field ag-field--range' }, h('span', { class: 'ag-field__label' }, 'Magnitude'), h('span', { class: 'ag-range__row' }, magInput, magOut)),
    ),
    formError,
    h('button', { class: 'ag-btn ag-btn--primary ag-btn--block', type: 'submit' }, icon('play'), 'Simulate custom event'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const lat = Number(fd.get('lat'));
    const lon = Number(fd.get('lon'));
    const depth = Number(fd.get('depth'));
    const mag = Number(fd.get('mag'));
    let err = '';
    if (!Number.isFinite(lat) || lat < 32 || lat > 42) err = 'Latitude must be between 32° and 42° N.';
    else if (!Number.isFinite(lon) || lon < -126 || lon > -114) err = 'Longitude must be between −126° and −114°.';
    else if (!Number.isFinite(depth) || depth < 0 || depth > 60) err = 'Depth must be between 0 and 60 km.';
    setText(formError, err);
    formError.hidden = !err;
    if (!err) handlers.onTriggerCustom(lat, lon, depth, mag);
  });
  formError.hidden = true;
  const customToggle = h('button', { class: 'ag-disclosure', type: 'button', 'aria-expanded': 'false' }, h('span', { class: 'ag-label' }, 'Custom event'), icon('chevron', 'ag-disclosure__chev'));
  const customSection = h('div', { class: 'ag-section ag-section--custom', dataset: { open: 'false' } }, customToggle, h('div', { class: 'ag-collapse' }, h('div', { class: 'ag-collapse__inner' }, form)));
  function setCustomOpen(open: boolean) {
    customSection.dataset.open = String(open);
    customToggle.setAttribute('aria-expanded', String(open));
  }
  customToggle.addEventListener('click', () => {
    const open = customSection.dataset.open !== 'true';
    setCustomOpen(open);
    // Bring the form into view once the disclosure has expanded.
    if (open) window.setTimeout(() => customSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 400);
  });

  // ── Footer ──
  const resetBtn = h('button', { class: 'ag-btn ag-btn--ghost', type: 'button', title: 'Reset the city (R)' }, icon('reset'), 'Reset city', h('kbd', { class: 'ag-kbd' }, 'R'));
  resetBtn.addEventListener('click', () => handlers.onReset());
  const footer = h('div', { class: 'ag-feed__foot' }, resetBtn);

  panel.body.append(h('div', { class: 'ag-feed__top' }, status, seisWrap), eventSlot, scenarioSection, customSection, footer);

  let runningId: string | null = null;
  const cards = new Map<string, HTMLElement>();

  function setScenarios(list: QuakeScenario[]) {
    scenarioList.replaceChildren();
    cards.clear();
    setText(scenarioCount, String(list.length));
    if (!list.length) {
      scenarioList.append(h('p', { class: 'ag-empty' }, 'No preset scenarios yet. Simulate a custom event below.'));
      setCustomOpen(true);
      return;
    }
    for (const s of list) {
      const e = s.event;
      const d = eventDistance(e);
      const depth = e.geometry.coordinates[2];
      const btn = h('button', { class: 'ag-btn ag-btn--sm', type: 'button', 'aria-label': `Simulate ${s.name}` }, icon('play'), 'Simulate');
      btn.addEventListener('click', () => handlers.onTriggerScenario(s.id));
      // Footer row spans the full card width so the action never squeezes the name.
      const card = h(
        'div',
        { class: 'ag-scn', role: 'listitem', dataset: { id: s.id } },
        magBadge(e.properties.mag, e.properties.magType, alertLevelFor(e)),
        h(
          'div',
          { class: 'ag-scn__main' },
          h('div', { class: 'ag-scn__name', title: s.name }, s.name),
          h('p', { class: 'ag-scn__desc', title: s.description }, s.description),
        ),
        h(
          'div',
          { class: 'ag-scn__foot' },
          h(
            'div',
            { class: 'ag-scn__meta' },
            h('span', { title: 'Epicentral distance from the study area' }, icon('ruler'), `${fmtKm(d.km)} km `, h('span', { class: 'ag-dim' }, d.dir)),
            h('span', { title: 'Hypocentre depth' }, icon('depth'), `${depth.toFixed(0)} km deep`),
          ),
          btn,
        ),
      );
      cards.set(s.id, card);
      scenarioList.append(card);
    }
    markRunning(runningId);
  }

  function markRunning(id: string | null) {
    runningId = id;
    cards.forEach((c, cid) => c.classList.toggle('is-running', cid === id));
  }

  return {
    panel,
    el: panel.el,
    seismogram: seis,
    setScenarios,
    showEvent(e: UsgsEvent, scenario: QuakeScenario) {
      const card = eventCard(e);
      eventSlot.replaceChildren(card);
      replayClass(card, 'is-entering');
      markRunning(scenario.id);
      setScenariosOpen(false);
      if (panel.collapsed) panel.setCollapsed(false, false);
      const [lon, lat, depth] = e.geometry.coordinates;
      const epi = haversineKm(CITY_ORIGIN.lat, CITY_ORIGIN.lon, lat, lon);
      seis.setQuake({ distanceKm: Math.hypot(epi, depth), mag: e.properties.mag, mmi: e.properties.mmi ?? estimateMmi(e.properties.mag, epi) });
      const a = seis.arrivals!;
      setText(seisReadout, `P ${a.p.toFixed(1)} s   S ${a.s.toFixed(1)} s`);
    },
    clearEvent() {
      eventSlot.replaceChildren();
      markRunning(null);
      setScenariosOpen(true);
      seis.setQuake(null);
      setText(seisReadout, 'synthetic');
    },
    setPhase(p: Phase) {
      const words: Record<Phase, [string, string]> = {
        monitoring: ['Monitoring', 'USGS NC network'],
        alert: ['Event detected', 'ShakeAlert issued'],
        shaking: ['Strong shaking', 'at Ferry Building site'],
        aftermath: ['Event over', 'Assessing impact'],
      };
      setText(stateWord, words[p][0]);
      setText(stateNet, words[p][1]);
      status.dataset.phase = p;
      resetBtn.classList.toggle('is-armed', p !== 'monitoring');
    },
  };
}
