/** Building inspector card: identity, structure, occupancy, provenance and (after a quake) shaking & damage. */
import type { BuildingInfo, BuildingRecord, XZ } from '../contracts';
import { h, replayClass, setText } from './dom';
import { icon, type IconName } from './icons';
import {
  CODE_LEVEL_LABELS,
  DAMAGE_STATES,
  DISTRICT_LABELS,
  PROVENANCE_LABELS,
  STRUCTURE_LABELS,
  USE_LABELS,
  buildingTitle,
  fmtInt,
  hazusCode,
  mmiLevel,
  siteClass,
} from './format';

/** Footprint silhouette, north up, fitted to a square. */
function footprintSvg(ring: XZ[]): Element {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'ag-insp__fp');
  svg.setAttribute('aria-hidden', 'true');
  if (ring.length < 3) return svg;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const s = 30 / span;
  const ox = 20 - ((minX + maxX) / 2) * s;
  const oz = 20 - ((minZ + maxZ) / 2) * s;
  const d = ring.map(([x, z], i) => `${i ? 'L' : 'M'}${(x * s + ox).toFixed(2)} ${(z * s + oz).toFixed(2)}`).join('') + 'Z';
  svg.innerHTML = `<path d="M20 2v3" class="ag-insp__north"/><path d="${d}" class="ag-insp__fpPath"/>`;
  return svg;
}

const badge = (label: string, ico: IconName, cls = '') => h('span', { class: `ag-badge ${cls}` }, icon(ico), label);

function fact(label: string, ...value: (Node | string)[]) {
  return h('div', { class: 'ag-fact' }, h('dt', {}, label), h('dd', {}, ...value));
}

function provenance(b: BuildingRecord) {
  const p = b.provenance;
  const chip = (what: string, src: string, measured: boolean) =>
    h('span', { class: `ag-prov ${measured ? 'is-measured' : ''}`, title: `${what} source: ${src}` }, h('span', { class: 'ag-prov__k' }, what), src);
  return h(
    'div',
    { class: 'ag-insp__prov' },
    h('span', { class: 'ag-label' }, 'Data sources'),
    h(
      'div',
      { class: 'ag-insp__provChips' },
      chip('Height', PROVENANCE_LABELS.height[p.height], p.height !== 'estimated'),
      chip('Year', PROVENANCE_LABELS.year[p.year], p.year !== 'estimated'),
      chip('Structure', PROVENANCE_LABELS.structure[p.structure], p.structure !== 'estimated'),
    ),
    h('div', { class: 'ag-insp__ids' }, h('span', {}, b.id), h('span', {}, `OSM ${b.osmId}`), b.material ? h('span', { class: 'ag-insp__mat' }, b.material) : null),
  );
}

/** Live line shown until damage is reported for this building. */
function pendingText(sArrivalS: number, simSeconds: number): string {
  const dt = sArrivalS - simSeconds;
  return dt > 0 ? `S-wave arrives in ${dt.toFixed(1)} s` : 'Shaking — assessing damage';
}

function quakeSection(info: BuildingInfo, simSeconds: number): HTMLElement | null {
  const s = info.shaking;
  if (!s) return null;
  const lvl = mmiLevel(s.mmi);
  const d = info.damage;
  const ds = d ? DAMAGE_STATES[d.state] : null;
  const damageRow = d
    ? h(
        'div',
        { class: 'ag-insp__damage' },
        h('span', { class: 'ag-dsbadge', style: { '--ds': ds!.color } as Partial<CSSStyleDeclaration> }, h('span', { class: 'ag-swatch' }), `${ds!.label} damage`),
        d.collapsed ? h('span', { class: 'ag-badge ag-badge--crit' }, icon('collapse'), 'Collapsed') : null,
        d.fire ? h('span', { class: 'ag-badge ag-badge--fire' }, icon('flame'), 'Fire') : null,
        h('span', { class: 'ag-insp__trapped' }, icon('trapped'), h('b', {}, fmtInt(d.trappedEstimate)), ' trapped est.'),
      )
    : h(
        'div',
        { class: 'ag-insp__damage ag-insp__damage--pending' },
        icon('clock'),
        h('span', { class: 'ag-insp__pendingText', dataset: { s: String(s.sArrivalS) } }, pendingText(s.sArrivalS, simSeconds)),
      );
  const exceed = d
    ? h(
        'div',
        { class: 'ag-exceed', title: 'Probability of reaching or exceeding each damage state (HAZUS fragility)' },
        h('span', { class: 'ag-exceed__label' }, 'P(≥ state)'),
        ...d.exceedance.map((p, i) =>
          h(
            'span',
            { class: 'ag-exceed__item' },
            h('span', { class: 'ag-exceed__bar' }, h('span', { style: { height: `${Math.round(p * 100)}%`, background: DAMAGE_STATES[i + 1].color } })),
            h('span', { class: 'ag-exceed__k' }, DAMAGE_STATES[i + 1].label[0]),
            h('span', { class: 'ag-exceed__v' }, `${Math.round(p * 100)}`),
          ),
        ),
      )
    : null;
  return h(
    'div',
    { class: 'ag-insp__quake' },
    h(
      'div',
      { class: 'ag-insp__shake' },
      h('span', { class: 'ag-mmichip ag-mmichip--md', style: { background: lvl.color, color: lvl.ink } }, lvl.roman),
      h(
        'dl',
        { class: 'ag-kpis' },
        h('div', {}, h('dt', {}, 'MMI'), h('dd', {}, s.mmi.toFixed(1))),
        h('div', {}, h('dt', {}, 'PGA'), h('dd', {}, s.pgaG.toFixed(2), h('small', {}, ' g'))),
        h('div', {}, h('dt', {}, 'PGV'), h('dd', {}, fmtInt(s.pgvCms), h('small', {}, ' cm/s'))),
      ),
    ),
    damageRow,
    exceed,
  );
}

export function createInspector(onClose: () => void) {
  const closeBtn = h('button', { class: 'ag-iconbtn ag-insp__close', type: 'button', 'aria-label': 'Close building details (Esc)' }, icon('close'));
  closeBtn.addEventListener('click', onClose);
  const el = h('section', { class: 'ag-panel ag-insp', 'aria-label': 'Building details', hidden: true });
  let open = false;
  let hideTimer = 0;

  return {
    el,
    get open() {
      return open;
    },
    /** Advance live text (S-wave countdown) without rebuilding the card. */
    tick(simSeconds: number) {
      if (!open) return;
      const p = el.querySelector<HTMLElement>('.ag-insp__pendingText');
      if (p) setText(p, pendingText(Number(p.dataset.s), simSeconds));
    },
    show(info: BuildingInfo | null, simSeconds = 0) {
      window.clearTimeout(hideTimer);
      if (!info) {
        if (!open) return;
        open = false;
        el.classList.add('is-leaving');
        hideTimer = window.setTimeout(() => {
          el.hidden = true;
          el.classList.remove('is-leaving');
        }, 260);
        return;
      }
      const b = info.record;
      const sub = [b.name && b.address ? b.address : null, DISTRICT_LABELS[b.district]].filter(Boolean).join(', ');
      const badges = [
        b.landmark ? badge('Landmark', 'landmark', 'ag-badge--accent') : null,
        b.softStory || b.structure === 'W1_SOFT' ? badge('Soft story', 'softStory', 'ag-badge--warn') : null,
        b.onFill ? badge('Bay fill', 'liquefaction', 'ag-badge--warn') : null,
        b.structure === 'URM' ? badge('URM', 'alert', 'ag-badge--warn') : null,
      ].filter(Boolean) as HTMLElement[];
      const storeys = b.levels > 0 ? `${b.levels} storey${b.levels === 1 ? '' : 's'}` : '';

      el.replaceChildren(
        h(
          'header',
          { class: 'ag-insp__head' },
          footprintSvg(b.footprint),
          h('div', { class: 'ag-insp__titles' }, h('h3', { class: 'ag-insp__title', title: buildingTitle(b) }, buildingTitle(b)), h('div', { class: 'ag-insp__sub' }, sub)),
          closeBtn,
        ),
        badges.length ? h('div', { class: 'ag-insp__badges' }, ...badges) : '',
        quakeSection(info, simSeconds) ?? '',
        h(
          'dl',
          { class: 'ag-facts' },
          fact('Use', USE_LABELS[b.use]),
          fact('Year built', String(b.yearBuilt), h('span', { class: 'ag-dim' }, ` ${CODE_LEVEL_LABELS[b.codeLevel].toLowerCase()}`)),
          fact('Structure', h('span', { class: 'ag-facts__struct' }, STRUCTURE_LABELS[b.structure]), h('span', { class: 'ag-code', title: 'HAZUS model building type' }, hazusCode(b.structure))),
          fact('Height', `${b.height.toFixed(1)} m`, storeys ? h('span', { class: 'ag-dim' }, `  ${storeys}`) : ''),
          fact('Occupants', h('span', { class: 'ag-occ' }, icon('sun'), fmtInt(b.occupantsDay)), h('span', { class: 'ag-occ' }, icon('moon'), fmtInt(b.occupantsNight))),
          fact('Site', `Vs30 ${fmtInt(b.vs30)} m/s`, h('span', { class: 'ag-dim' }, `  class ${siteClass(b.vs30)}`)),
        ),
        provenance(b),
      );
      el.hidden = false;
      el.classList.remove('is-leaving');
      if (!open) replayClass(el, 'is-entering');
      open = true;
    },
  };
}
