/**
 * M4 drone camera thumbnails: one 16:9 tile per drone (D1–D3) with the latest captured frame, a drone-colour
 * border, an OSD label, REC while orbiting and a STANDBY static card while idle. Click → live lightbox.
 */
import type { DroneFeed, DroneId, DronePhase } from '../contracts';
import { h, setText } from './dom';
import { icon } from './icons';

/** Drone identity colours (validated categorical set; shared with plan card + timeline). */
export const DRONE_COLORS: Record<DroneId, string> = { D1: '#13a9cc', D2: '#e0961a', D3: '#d23ab4' };
export const DRONE_IDS: DroneId[] = ['D1', 'D2', 'D3'];

const PHASE_WORD: Record<DronePhase, string> = { idle: 'Standby', transit: 'En route', orbit: 'Orbit', return: 'Returning', done: 'Mission complete' };

const src = (b64: string) => (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`);

interface Tile {
  el: HTMLButtonElement;
  img: HTMLImageElement;
  word: HTMLElement;
  label: HTMLElement;
  b64: string | null;
}

export function createDroneFeeds() {
  const tiles = new Map<DroneId, Tile>();
  const el = h('div', { class: 'ag-dfeeds', hidden: true, role: 'group', 'aria-label': 'Drone camera feeds' });
  const latest = new Map<DroneId, DroneFeed>();

  // ── Lightbox ──
  const lbImg = h('img', { class: 'ag-lb__img', alt: '' });
  const lbStatic = h('div', { class: 'ag-lb__static' }, h('span', {}, 'No signal'));
  const lbChip = h('span', { class: 'ag-dchip' }, 'D1');
  const lbLabel = h('span', { class: 'ag-lb__label' }, '');
  const lbRec = h('span', { class: 'ag-dfeed__rec ag-lb__rec' }, h('i', {}), 'REC');
  const lbClose = h('button', { class: 'ag-iconbtn ag-lb__close', type: 'button', 'aria-label': 'Close drone feed' }, icon('close'));
  const lbFig = h(
    'figure',
    { class: 'ag-lb__fig' },
    h('div', { class: 'ag-lb__screen' }, lbImg, lbStatic, lbRec),
    h('figcaption', { class: 'ag-lb__cap' }, lbChip, lbLabel, h('span', { class: 'ag-lb__hint' }, 'Esc to close'), lbClose),
  );
  const lightbox = h('div', { class: 'ag-lb', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Drone camera' }, lbFig);
  let lbId: DroneId | null = null;

  function closeLb() {
    if (!lbId) return false;
    lbId = null;
    lightbox.hidden = true;
    return true;
  }
  function openLb(id: DroneId) {
    lbId = id;
    lightbox.hidden = false;
    syncLb();
    lbClose.focus({ preventScroll: true });
  }
  function syncLb() {
    if (!lbId) return;
    const f = latest.get(lbId);
    lbFig.style.setProperty('--dc', DRONE_COLORS[lbId]);
    setText(lbChip, lbId);
    lbChip.style.setProperty('--dc', DRONE_COLORS[lbId]);
    setText(lbLabel, f ? f.label : `${lbId} · standby`);
    const b64 = f?.jpegBase64 ?? null;
    if (b64) {
      const s = src(b64);
      if (lbImg.getAttribute('src') !== s) lbImg.src = s;
    }
    lbImg.hidden = !b64;
    lbStatic.hidden = !!b64;
    lbRec.hidden = f?.phase !== 'orbit';
  }
  lightbox.addEventListener('click', () => closeLb());
  // Capture phase so Esc closes the lightbox before the global handler closes the inspector.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && lbId) {
        e.preventDefault();
        e.stopPropagation();
        closeLb();
      }
    },
    true,
  );

  function tile(id: DroneId): Tile {
    let t = tiles.get(id);
    if (t) return t;
    const img = h('img', { class: 'ag-dfeed__img', alt: '', hidden: true, draggable: 'false' });
    const word = h('span', { class: 'ag-dfeed__word' }, 'Standby');
    const label = h('span', { class: 'ag-dfeed__label' }, `${id} · standby`);
    const btn = h(
      'button',
      { class: 'ag-dfeed', type: 'button', dataset: { drone: id, phase: 'idle' }, style: { '--dc': DRONE_COLORS[id] } as Partial<CSSStyleDeclaration>, title: `Enlarge ${id} camera` },
      h(
        'div',
        { class: 'ag-dfeed__screen' },
        img,
        h('div', { class: 'ag-dfeed__static' }, h('span', { class: 'ag-dfeed__sid' }, id), word),
        h('span', { class: 'ag-dfeed__rec' }, h('i', {}), 'REC'),
        h('span', { class: 'ag-dfeed__zoom' }, icon('expand')),
        h('span', { class: 'ag-dfeed__osd' }, label),
      ),
    );
    btn.addEventListener('click', () => openLb(id));
    btn.hidden = true;
    t = { el: btn, img, word, label, b64: null };
    tiles.set(id, t);
    el.append(btn);
    return t;
  }
  for (const id of DRONE_IDS) tile(id); // fixed DOM order D1, D2, D3

  return {
    el,
    lightbox,
    closeLightbox: closeLb,
    /** Latest frame per drone; [] hides the strip. */
    set(feeds: DroneFeed[]) {
      el.hidden = feeds.length === 0;
      if (!feeds.length) {
        closeLb();
        return;
      }
      const sorted = feeds.slice().sort((a, b) => a.droneId.localeCompare(b.droneId));
      for (const f of sorted) {
        latest.set(f.droneId, f);
        const t = tile(f.droneId);
        t.el.dataset.phase = f.phase;
        setText(t.label, f.label);
        setText(t.word, PHASE_WORD[f.phase]);
        const live = !!f.jpegBase64 && f.phase !== 'idle';
        t.el.dataset.live = String(live);
        if (live && f.jpegBase64 !== t.b64) {
          t.b64 = f.jpegBase64;
          t.img.src = src(f.jpegBase64!);
        }
        t.img.hidden = !live;
      }
      for (const id of DRONE_IDS) tiles.get(id)!.el.hidden = !sorted.some((f) => f.droneId === id);
      syncLb();
    },
  };
}
