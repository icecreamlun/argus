/**
 * Right panel "AIR 1 · SFPD — Aerial reconstruction" (M3): helicopter flight status, area coverage, Argon
 * (gemini-4-argon) progress, and the headline comparison: model prediction vs Argon reconstruction, both
 * scored against the simulation's ground truth. Plus the inspector's Predicted / Argon / Truth block.
 */
import { focusBuilding } from './focus';
import type { AirUiState, BuildingComparison, CityData, DamageState, ObservedDamage } from '../contracts';
import { h, setText } from './dom';
import { icon } from './icons';
import { createPanel } from './panel';
import { DAMAGE_STATES, buildingTitle, fmtInt } from './format';
import { createTimeline, type WaveMark } from './timeline';

const OBS_INDEX: Record<ObservedDamage, DamageState> = { none: 0, slight: 1, moderate: 2, extensive: 3, collapsed: 4 };
const STATE_SHORT = ['None', 'Slight', 'Moderate', 'Extensive', 'Collapsed'];

const pct = (f: number) => `${Math.round(f * 100)}%`;
const mmss = (s: number) => {
  const a = Math.max(0, Math.round(s));
  return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};

/** Small damage-state badge (reuses the inspector's ag-dsbadge look). */
function dsBadge(state: DamageState, label?: string, sm = false): HTMLElement {
  return h(
    'span',
    { class: `ag-dsbadge ${sm ? 'ag-dsbadge--sm' : ''}`, style: { '--ds': DAMAGE_STATES[state].color } as Partial<CSSStyleDeclaration> },
    h('span', { class: 'ag-swatch' }),
    label ?? STATE_SHORT[state],
  );
}

function meter(label: string) {
  const fill = h('span', { class: 'ag-air__fill' });
  const value = h('span', { class: 'ag-air__mval' }, '');
  const el = h('div', { class: 'ag-air__meter' }, h('div', { class: 'ag-air__mhead' }, h('span', { class: 'ag-air__mlabel' }, label), value), h('div', { class: 'ag-air__bar' }, fill));
  return {
    el,
    set(f: number, text: string) {
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, f)).toFixed(4)})`;
      setText(value, text);
    },
  };
}

function trio(label: string, ico: Parameters<typeof icon>[0]) {
  const a = h('b', {}, '–');
  const b = h('b', {}, '–');
  const c = h('b', {}, '–');
  const el = h(
    'div',
    { class: 'ag-air__trio' },
    h('span', { class: 'ag-air__trioLabel' }, icon(ico), label),
    h('span', { class: 'ag-air__trioCell' }, a),
    h('span', { class: 'ag-air__trioCell ag-air__trioCell--argon' }, b),
    h('span', { class: 'ag-air__trioCell' }, c),
  );
  return { el, a, b, c };
}

export function createAirPanel(city: CityData) {
  const panel = createPanel({ id: 'air', title: 'AIR 1 · SFPD', icon: 'camera', className: 'ag-air' });
  const recByIdx = new Map(city.buildings.map((b) => [b.id, b]));

  // Header: status pill (+ collapsed summary: Argon accuracy).
  const statusDot = h('span', { class: 'ag-air__dot' });
  const statusWord = h('span', {}, 'Standby');
  const statusPill = h('span', { class: 'ag-air__status', dataset: { status: 'standby' } }, statusDot, statusWord);
  panel.meta.append(statusPill);
  const sumAcc = h('span', { class: 'ag-sum' }, icon('target'), h('b', {}, '–'));
  panel.summary.append(sumAcc);

  // ── Idle ──
  const idle = h(
    'p',
    { class: 'ag-air__idle' },
    'Aerial reconstruction. After an event, police helicopter AIR 1 flies a survey route over the area; ',
    h('b', {}, 'gemini-4-argon'),
    ' reconstructs damage, people and blocked streets from its camera footage.',
  );

  // ── Flight ──
  const sub = h('div', { class: 'ag-air__sub' }, h('span', { class: 'ag-label' }, 'Aerial reconstruction'), h('span', { class: 'ag-air__route', title: 'Argon only sees the helicopter footage: no model prediction is sent' }, 'Blind · no prediction sent'));
  const mFlight = meter('Flight');
  const mArea = meter('Area scanned');
  const flight = h('div', { class: 'ag-air__flight' }, mFlight.el, mArea.el);

  // ── Argon status ──
  const modeBadge = h('span', { class: 'ag-air__mode', dataset: { mode: 'none' } }, '–');
  const argonLine = h('span', { class: 'ag-air__argonText' }, 'gemini-4-argon · waiting for footage');
  const pending = h('span', { class: 'ag-air__pending' }, '');
  const argon = h('div', { class: 'ag-air__argon' }, modeBadge, argonLine, pending);

  // ── Comparison card ──
  const footLabel = h(
    'span',
    { title: 'xBD aerial damage scale: no damage / minor / major (moderate–extensive) / destroyed. Macro-F1 = mean per-class F1 (the xBD challenge damage score). Both figures are scored on the same buildings.' },
    'xBD macro-F1 · buildings Argon assessed · vs ground truth (sim)',
  );
  const predNum = h('span', { class: 'ag-air__bignum' }, '–');
  const reconNum = h('span', { class: 'ag-air__bignum ag-air__bignum--argon' }, '–');
  const within = h('span', { class: 'ag-air__within' }, '');
  const basis = h('span', { class: 'ag-air__basis' }, '');
  const collapses = trio('Collapses', 'collapse');
  collapses.el.title = 'HAZUS complete damage (DS4), incl. collapse. Model = expected count';
  const peopleRow = trio('People seen', 'trapped');
  // M4 drones: accuracy timeline under the headline figures.
  const timeline = createTimeline();
  let waveMarks: WaveMark[] = [];
  let lastHistory: AirUiState['stats']['history'];
  const compare = h(
    'div',
    { class: 'ag-air__cmp' },
    h('div', { class: 'ag-air__cmpHead' }, h('span', { class: 'ag-label' }, 'Quake model, corrected by Argon footage')),
    h(
      'div',
      { class: 'ag-air__figs' },
      h('div', { class: 'ag-air__fig' }, predNum, h('span', { class: 'ag-air__figLabel' }, 'Model alone')),
      h('span', { class: 'ag-air__arrow' }, icon('arrowRight')),
      h('div', { class: 'ag-air__fig' }, reconNum, h('span', { class: 'ag-air__figLabel ag-air__figLabel--argon' }, 'Model + Argon')),
    ),
    h('div', { class: 'ag-air__foot' }, footLabel, within),
    timeline.el,
    h(
      'div',
      { class: 'ag-air__table' },
      h('div', { class: 'ag-air__trio ag-air__trio--head' }, h('span', {}, ''), h('span', {}, 'Model'), h('span', {}, 'Argon'), h('span', {}, 'Truth')),
      collapses.el,
      peopleRow.el,
    ),
    basis,
  );

  // ── Summary + surprises ──
  const summary = h('p', { class: 'ag-air__summary' }, '');
  const summarySec = h('div', { class: 'ag-section ag-air__sumSec' }, h('div', { class: 'ag-section__head' }, h('span', { class: 'ag-label' }, 'Latest Argon summary'), h('span', { class: 'ag-section__aside ag-air__crowds' }, '')), summary);
  const surpriseCount = h('span', { class: 'ag-count' }, '0');
  const surpriseList = h('div', { class: 'ag-air__surprises', role: 'list' });
  const surpriseSec = h(
    'div',
    { class: 'ag-section' },
    h('div', { class: 'ag-section__head' }, h('span', { class: 'ag-air__shead' }, h('span', { class: 'ag-label' }, 'Surprises'), surpriseCount), h('span', { class: 'ag-section__aside' }, 'model missed, Argon caught')),
    surpriseList,
  );

  const live = h('div', { class: 'ag-air__live' }, sub, flight, argon, compare, summarySec, surpriseSec);
  panel.body.append(idle, live);

  let lastSurpriseKey = '';
  let active: boolean | null = null;
  const setActive = (a: boolean) => {
    if (active === a) return;
    active = a;
    panel.el.dataset.active = String(a);
  };
  setActive(false);

  return {
    panel,
    el: panel.el,
    /** True once a flight has started (used by index.ts to make room on first launch). */
    get active() {
      return !!active;
    },
    /** M4: approved drone waves (vertical markers on the accuracy timeline). [] = infer from history. */
    setWaveMarks(marks: WaveMark[]) {
      waveMarks = marks.slice();
      timeline.set(lastHistory, waveMarks);
    },
    set(s: AirUiState | null) {
      if (!s) {
        setActive(false);
        statusPill.dataset.status = 'standby';
        setText(statusWord, 'Standby');
        return;
      }
      setActive(true);
      const st = s.stats;
      statusPill.dataset.status = s.status.replace(' ', '-');
      setText(statusWord, s.status[0].toUpperCase() + s.status.slice(1));
      mFlight.set(s.durationS > 0 ? s.flightS / s.durationS : 0, `${mmss(s.flightS)} / ${mmss(s.durationS)}`);
      mArea.set(s.scannedFraction, pct(s.scannedFraction));

      const mode = s.mode ?? st.mode;
      modeBadge.dataset.mode = mode ?? 'none';
      setText(modeBadge, mode === 'gemini' ? 'Live' : mode === 'replay' ? 'Replay' : mode === 'mock' ? 'Mock' : 'Idle');
      modeBadge.title = mode === 'mock' ? 'Argon unavailable: showing a simulated reconstruction (truth + noise)' : mode === 'replay' ? 'Cached Argon responses' : 'Live gemini-4-argon responses';
      const total = Math.max(st.chunksSent, st.chunksDone);
      const lat = s.avgLatencyS ?? st.avgLatencyS;
      setText(
        argonLine,
        total ? `${st.model || 'gemini-4-argon'} · ${st.chunksDone}/${total} chunks${lat ? ` · ${lat.toFixed(1)} s avg` : ''}` : `${st.model || 'gemini-4-argon'} · waiting for footage`,
      );
      setText(pending, s.pending > 0 ? `${s.pending} pending` : '');
      pending.classList.toggle('is-on', s.pending > 0);

      const has = st.buildingsObserved > 0;
      compare.classList.toggle('is-empty', !has);
      // Headline: whole-core-area xBD macro-F1 (fixed denominator: every core building) — model alone vs the
      // model corrected by Argon. Hidden until ≥ HEAD_MIN buildings are seen on video (tiny samples are noise).
      // The video-assessed figure (same buildings for both) is the secondary line.
      const HEAD_MIN = 50;
      const ready = st.buildingsObserved >= HEAD_MIN;
      const headP = st.cityPredictionF1 ?? st.predictionF1 ?? st.predictionAccuracy;
      const headR = st.cityFusedF1 ?? st.fusedF1 ?? st.reconAccuracy;
      setText(predNum, has && ready ? pct(headP) : '–');
      setText(reconNum, has && ready ? pct(headR) : '–');
      setText(sumAcc.querySelector('b')!, has && ready ? pct(headR) : '–');
      setText(footLabel, ready ? `xBD macro-F1 · whole core area (${fmtInt(st.cityBuildings ?? 0)} bldgs) · vs ground truth (sim)` : `Collecting evidence… ${fmtInt(st.buildingsObserved)}/${HEAD_MIN} buildings seen`);
      setText(within, has && ready ? `Buildings seen on video (${fmtInt(st.buildingsObserved)}): ${pct(st.predictionF1 ?? 0)} → ${pct(st.fusedF1 ?? 0)}` : '');
      within.title = has
        ? `xBD 4-class. Balanced accuracy: model ${pct(st.predictionBal ?? 0)}, Argon ${pct(st.reconBal ?? 0)}, model+Argon ${pct(st.fusedBal ?? 0)}. Exact HAZUS state: ${pct(st.predictionAccuracy)} → Argon ${pct(st.reconAccuracy)}.`
        : '';
      setText(basis, has ? `${fmtInt(st.buildingsObserved)} buildings reconstructed${st.buildingsCovered ? ` of ${fmtInt(st.buildingsCovered)} in view` : ''}${st.droneObserved ? ` (${fmtInt(st.droneObserved)} by drone close-up)` : ''}. Model = HAZUS most likely state; model complete = expected count.` : 'Comparison appears when the first chunk comes back.');
      lastHistory = st.history;
      timeline.set(has ? st.history : [], waveMarks);
      setText(collapses.a, has ? fmtInt(st.collapsesPredicted) : '–');
      setText(collapses.b, has ? fmtInt(st.collapsesObserved) : '–');
      setText(collapses.c, has ? fmtInt(st.collapsesTruth) : '–');
      setText(peopleRow.a, has ? '–' : '–');
      setText(peopleRow.b, has ? fmtInt(st.peopleObserved) : '–');
      setText(peopleRow.c, has ? fmtInt(st.peopleTruthVisible) : '–');
      peopleRow.a.title = 'The model estimates trapped people, not people visible from the air';

      setText(summary, st.lastSummary || (s.status === 'standby' ? '' : 'Footage is being analysed…'));
      summary.classList.toggle('is-wait', !st.lastSummary);
      setText(summarySec.querySelector('.ag-air__crowds')!, st.crowdsObserved ? `${st.crowdsObserved} crowd${st.crowdsObserved === 1 ? '' : 's'} spotted` : '');

      const key = st.surprises.map((x) => `${x.id}:${x.observed}`).join('|');
      if (key !== lastSurpriseKey) {
        lastSurpriseKey = key;
        setText(surpriseCount, String(st.surprises.length));
        surpriseList.replaceChildren(
          ...(st.surprises.length
            ? st.surprises.map((x) => {
                const rec = recByIdx.get(x.id);
                const name = rec ? buildingTitle(rec).replace(/;[^ ]*/g, '') : x.id;
                const row = h(
                  'button',
                  { class: 'ag-air__srow', type: 'button', role: 'listitem', title: `${name}: model predicted ${STATE_SHORT[x.predicted].toLowerCase()}, Argon saw ${x.observed} (truth: ${STATE_SHORT[x.truth].toLowerCase()})` },
                  h('span', { class: 'ag-air__sname' }, name),
                  dsBadge(x.predicted, undefined, true),
                  h('span', { class: 'ag-air__sarrow' }, '→'),
                  dsBadge(OBS_INDEX[x.observed], undefined, true),
                );
                row.addEventListener('click', () => focusBuilding(x.id));
                return row;
              })
            : [h('p', { class: 'ag-empty ag-air__none' }, has ? 'None yet. Argon agrees with the model so far.' : 'Buildings where Argon saw something the model did not predict will appear here.')]),
        );
      }
    },
  };
}

/** Inspector block: Predicted / Argon observed / Truth. */
export function comparisonBlock(c: BuildingComparison): HTMLElement {
  const obs = OBS_INDEX[c.observed.damage];
  const t = c.truth.collapsed ? 4 : c.truth.state;
  const ok = (s: DamageState) => (s === t ? h('span', { class: 'ag-cmp__ok', title: 'Matches ground truth' }, icon('check')) : h('span', { class: 'ag-cmp__miss', title: 'Differs from ground truth' }, '≠'));
  const col = (label: string, cls: string, ...rows: (Node | string | null)[]) =>
    h('div', { class: `ag-cmp__col ${cls}` }, h('span', { class: 'ag-cmp__label' }, label), ...rows.filter(Boolean).map((r) => h('div', { class: 'ag-cmp__row' }, r as Node)));
  const people = c.observed.peopleVisible;
  return h(
    'div',
    { class: 'ag-cmp' },
    h('div', { class: 'ag-cmp__head' }, h('span', { class: 'ag-label' }, 'Model vs Argon vs truth'), h('span', { class: 'ag-cmp__ev', title: 'Seconds into AIR 1 flight where the evidence is clearest' }, icon('camera'), `AIR 1 +${mmss(c.observed.flightS)}`)),
    h(
      'div',
      { class: 'ag-cmp__grid' },
      col(
        'Model',
        '',
        h('span', { class: 'ag-cmp__state' }, dsBadge(c.predicted.mostLikely, undefined, true), ok(c.predicted.mostLikely)),
        h('span', {}, `P(collapse) `, h('b', {}, pct(c.predicted.pCollapse))),
        h('span', { class: 'ag-dim' }, `P(${STATE_SHORT[c.predicted.mostLikely].toLowerCase()}) ${pct(c.predicted.probs[c.predicted.mostLikely])}`),
      ),
      col(
        'Argon',
        'ag-cmp__col--argon',
        h('span', { class: 'ag-cmp__state' }, dsBadge(obs, undefined, true), ok(obs)),
        h('span', {}, 'Confidence ', h('b', {}, pct(c.observed.confidence))),
        people > 0 || c.observed.trappedSigns
          ? h('span', { class: c.observed.trappedSigns ? 'ag-cmp__hot' : '' }, icon('trapped'), `${people} ${people === 1 ? 'person' : 'people'}${c.observed.trappedSigns ? ' · trapped' : ''}`)
          : h('span', { class: 'ag-dim' }, 'No people seen'),
        c.observed.fire ? h('span', { class: 'ag-cmp__fire' }, icon('flame'), 'Fire') : null,
      ),
      col(
        'Truth',
        '',
        h('span', { class: 'ag-cmp__state' }, dsBadge(t, undefined, true)),
        h('span', {}, c.truth.collapsed ? h('b', { class: 'ag-cmp__hot' }, 'Collapsed') : 'Standing'),
        h('span', {}, h('b', {}, fmtInt(c.truth.trappedVisible)), '\u00a0visible'),
        h('span', {}, h('b', {}, fmtInt(c.truth.trappedHidden)), '\u00a0buried'),
      ),
    ),
    c.observed.notes ? h('p', { class: 'ag-cmp__notes' }, `“${c.observed.notes}”`) : null,
  );
}
