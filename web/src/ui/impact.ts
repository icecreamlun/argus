/**
 * Right panel "Impact": peak intensity, rescue-relevant counts, HAZUS damage-state distribution,
 * ShakeMap MMI legend and the map overlay switch.
 */
import type { OverlayMode, QuakeResult, UiHandlers } from '../contracts';
import { h, setText } from './dom';
import { icon, type IconName } from './icons';
import { createPanel } from './panel';
import { DAMAGE_STATES, MMI_SCALE, fmtCompact, fmtInt, fmtSimTime, mmiLevel } from './format';
import { createSegmented } from './segmented';

type Stats = QuakeResult['stats'];

/** One row of the rescue list beside the trapped count. */
function stat(label: string, ico: IconName, cls: string) {
  const value = h('span', { class: 'ag-stat__value' }, '0');
  const el = h('div', { class: `ag-stat ${cls}` }, icon(ico), h('span', { class: 'ag-stat__label' }, label), value);
  return { el, value };
}

export function createImpactPanel(handlers: UiHandlers) {
  const panel = createPanel({ id: 'impact', title: 'Impact', icon: 'target', className: 'ag-impact' });
  const simTime = h('span', { class: 'ag-panel__time' }, '');
  panel.meta.append(simTime);

  // Collapsed summary (header): MMI chip + trapped.
  const sumMmi = h('span', { class: 'ag-mmichip ag-mmichip--sm' }, '–');
  const sumTrapped = h('span', { class: 'ag-sum' }, icon('trapped'), h('b', {}, '0'));
  panel.summary.append(sumMmi, sumTrapped);

  // ── Idle summary ──
  const IDLE_TEXT = 'No active event. Run a scenario to estimate damage and people trapped.';
  const idleLead = h('p', { class: 'ag-impact__idleLead' }, IDLE_TEXT);
  const idlePeople = h('b', {}, '0');
  const idleBldgs = h('b', {}, '0');
  const idle = h(
    'div',
    { class: 'ag-impact__idle' },
    idleLead,
    h('div', { class: 'ag-impact__idleStats' }, h('span', {}, icon('people'), idlePeople, ' people in the area now'), h('span', {}, icon('building'), idleBldgs, ' buildings modelled')),
  );

  // ── Peak intensity ──
  const peakChip = h('span', { class: 'ag-mmichip ag-mmichip--lg' }, '–');
  const peakWord = h('span', { class: 'ag-peak__word' }, '');
  const peakDamage = h('span', { class: 'ag-peak__damage' }, '');
  const peak = h('div', { class: 'ag-peak' }, peakChip, h('div', { class: 'ag-peak__text' }, h('span', { class: 'ag-label' }, 'Peak intensity'), peakWord, peakDamage));

  // ── Rescue block: trapped (lead number) + collapse / fire / road counts ──
  const trappedNum = h('span', { class: 'ag-hero__num' }, '0');
  const exposedNum = h('b', {}, '0');
  const tCollapsed = stat('Collapsed', 'collapse', 'is-crit');
  const tFires = stat('Fires', 'flame', 'is-fire');
  const tRoads = stat('Roads blocked', 'roadBlock', 'is-road');
  const hero = h(
    'div',
    { class: 'ag-hero' },
    h(
      'div',
      { class: 'ag-hero__main' },
      trappedNum,
      h('span', { class: 'ag-hero__label' }, icon('trapped'), 'Trapped', h('span', { class: 'ag-dim' }, ' est.')),
      h('span', { class: 'ag-hero__sub' }, 'of ', exposedNum, ' exposed'),
    ),
    h('div', { class: 'ag-hero__list' }, tCollapsed.el, tFires.el, tRoads.el),
  );

  // ── Damage distribution ──
  const totalEl = h('span', { class: 'ag-section__aside' }, '');
  const segs = DAMAGE_STATES.map((d) => h('span', { class: 'ag-stack__seg', style: { background: d.color }, title: d.label }));
  const stack = h('div', { class: 'ag-stack', role: 'img', 'aria-label': 'Damage state distribution' }, ...segs);
  const rows = DAMAGE_STATES.map((d) => {
    const count = h('span', { class: 'ag-ds__count' }, '0');
    const pct = h('span', { class: 'ag-ds__pct' }, '0%');
    const row = h('div', { class: 'ag-ds' }, h('span', { class: 'ag-swatch', style: { background: d.color } }), h('span', { class: 'ag-ds__name' }, d.label), count, pct);
    return { row, count, pct };
  });
  const damage = h(
    'div',
    { class: 'ag-section ag-damage' },
    h('div', { class: 'ag-section__head' }, h('span', { class: 'ag-label' }, 'Damage state'), totalEl),
    stack,
    h('div', { class: 'ag-ds-list' }, ...rows.map((r) => r.row)),
  );

  const live = h('div', { class: 'ag-impact__live' }, peak, hero, damage);

  // ── ShakeMap legend ──
  const cells = MMI_SCALE.map((l) =>
    h(
      'span',
      { class: 'ag-mmi__cell', style: { background: l.color, color: l.ink }, title: `${l.roman} · ${l.shaking} shaking · ${l.damage} damage · PGA ≈ ${l.pga} %g · PGV ≈ ${l.pgv} cm/s` },
      l.roman,
    ),
  );
  const legend = h(
    'div',
    { class: 'ag-section ag-mmi' },
    h('div', { class: 'ag-section__head' }, h('span', { class: 'ag-label' }, 'ShakeMap intensity'), h('span', { class: 'ag-section__aside' }, 'MMI')),
    h('div', { class: 'ag-mmi__scale' }, h('div', { class: 'ag-mmi__cells' }, ...cells)),
    h('div', { class: 'ag-mmi__words' }, h('span', {}, 'Weak'), h('span', {}, 'Strong'), h('span', {}, 'Extreme')),
  );

  // ── Overlay switch ──
  const overlay = createSegmented<OverlayMode>(
    [
      { value: 'none', label: 'None' },
      { value: 'shakemap', label: 'ShakeMap' },
      { value: 'damage', label: 'Damage' },
    ],
    'none',
    (m) => handlers.onOverlay(m),
    'Map overlay',
  );
  const overlayRow = h('div', { class: 'ag-section ag-overlay' }, h('span', { class: 'ag-label ag-overlay__label' }, icon('layers'), 'Overlay'), overlay.el);

  panel.body.append(idle, live, legend, overlayRow);

  let active = false;
  const setActive = (a: boolean) => {
    active = a;
    panel.el.dataset.active = String(a);
  };
  setActive(false);

  function setMmi(chip: HTMLElement, mmi: number) {
    const l = mmiLevel(mmi);
    if (chip.textContent === l.roman) return; // called every frame during playback
    setText(chip, l.roman);
    chip.style.background = l.color;
    chip.style.color = l.ink;
  }
  const lastGrow: string[] = [];

  return {
    panel,
    el: panel.el,
    overlay,
    /** An event is running but no estimates have arrived yet. */
    setAwaiting(awaiting: boolean) {
      setText(idleLead, awaiting ? 'Event in progress. Damage estimates appear as the waves reach the city.' : IDLE_TEXT);
      idleLead.classList.toggle('is-awaiting', awaiting);
    },
    setIdleExposure(people: number, buildings: number) {
      setText(idlePeople, fmtInt(people));
      setText(idleBldgs, fmtInt(buildings));
    },
    update(stats: Stats | null, simSeconds: number) {
      if (!stats) {
        setActive(false);
        setText(simTime, '');
        cells.forEach((c) => c.classList.remove('is-peak'));
        lastGrow.length = 0;
        return;
      }
      if (!active) setActive(true);
      setText(simTime, fmtSimTime(simSeconds));

      // Peak intensity (from the model's precomputed field).
      const lvl = mmiLevel(stats.maxMmi);
      setMmi(peakChip, stats.maxMmi);
      setMmi(sumMmi, stats.maxMmi);
      setText(peakWord, `${lvl.shaking} shaking`);
      setText(peakDamage, `${lvl.damage} damage potential`);
      cells.forEach((c, i) => c.classList.toggle('is-peak', i === lvl.value - 1));

      setText(trappedNum, fmtInt(stats.trappedEstimate));
      setText(sumTrapped.querySelector('b')!, fmtCompact(stats.trappedEstimate));
      setText(exposedNum, fmtCompact(stats.occupantsAtTime));
      hero.classList.toggle('is-hot', stats.trappedEstimate > 0);
      setText(tCollapsed.value, fmtInt(stats.collapsed));
      setText(tFires.value, fmtInt(stats.fires));
      setText(tRoads.value, fmtInt(stats.blockedSegments));
      tCollapsed.el.classList.toggle('is-hot', stats.collapsed > 0);
      tFires.el.classList.toggle('is-hot', stats.fires > 0);
      tRoads.el.classList.toggle('is-hot', stats.blockedSegments > 0);

      const total = Math.max(1, stats.byState.reduce((a, b) => a + b, 0));
      setText(totalEl, `${fmtInt(total)} buildings`);
      stats.byState.forEach((n, i) => {
        const f = n / total;
        const grow = f.toFixed(4);
        if (lastGrow[i] !== grow) {
          lastGrow[i] = grow;
          segs[i].style.flexGrow = grow;
          segs[i].hidden = n === 0;
        }
        setText(rows[i].count, fmtInt(n));
        setText(rows[i].pct, n === 0 ? '–' : f < 0.001 ? '<0.1%' : `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`);
        rows[i].row.classList.toggle('is-zero', n === 0);
      });
    },
  };
}
