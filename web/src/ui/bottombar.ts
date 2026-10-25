/** Bottom row: time-of-day island, quake playback island, camera-view island. */
import type { CameraPreset, CameraPresetId, UiHandlers } from '../contracts';
import { h, frag, setText } from './dom';
import { ICONS, icon } from './icons';
import { fmtHours, fmtSimTime } from './format';
import { createSegmented } from './segmented';

/** Night sits at 02:00, the HAZUS night-occupancy bookend (day = 14:00). */
const MARKERS = [
  { h: 2, label: 'Night' },
  { h: 6.5, label: 'Dawn' },
  { h: 12, label: 'Day' },
  { h: 18.75, label: 'Dusk' },
];

/** Short chip labels; the engine's full label is used for the tooltip. */
const SHORT: Partial<Record<CameraPresetId, string>> = {
  overview: 'Overview',
  ferry: 'Ferry',
  chinatown: 'Chinatown',
  street: 'Street',
  transamerica: 'Pyramid',
  embarcadero: 'Embarcadero',
  aerial_east: 'Bay',
};

function glyphFor(h: number): keyof typeof ICONS {
  const t = ((h % 24) + 24) % 24;
  if ((t >= 5.6 && t < 7.4) || (t >= 18 && t < 19.8)) return 'twilight';
  if (t >= 7.4 && t < 18) return 'sun';
  return 'moon';
}

export function createTimeIsland(handlers: UiHandlers) {
  const glyph = h('span', { class: 'ag-tod__glyph' }, icon('sun'));
  const readout = h('span', { class: 'ag-tod__time' }, '16:30');
  const input = h('input', { class: 'ag-tod__range', type: 'range', min: '0', max: '24', step: '0.05', value: '16.5', 'aria-label': 'Time of day (hours)' });
  const marks = h(
    'div',
    { class: 'ag-tod__marks' },
    ...MARKERS.map((m) => {
      const b = h('button', { class: 'ag-tod__mark', type: 'button', style: { left: `${(m.h / 24) * 100}%` }, title: `Jump to ${fmtHours(m.h)}` }, m.label);
      b.addEventListener('click', () => {
        set(m.h);
        handlers.onTimeOfDay(m.h);
      });
      return b;
    }),
  );
  const el = h(
    'div',
    { class: 'ag-island ag-tod' },
    h('div', { class: 'ag-tod__read' }, glyph, readout),
    h('div', { class: 'ag-tod__track' }, input, marks),
  );

  let currentGlyph = 'sun';
  function set(hours: number) {
    input.value = String(hours);
    input.style.setProperty('--p', String(hours / 24));
    setText(readout, fmtHours(hours));
    const g = glyphFor(hours);
    if (g !== currentGlyph) {
      currentGlyph = g;
      glyph.replaceChildren(frag(ICONS[g]));
    }
  }

  // Coalesce slider drags to one engine update per frame (sky/env-map updates are not free).
  let pending: number | null = null;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    if (pending === null) {
      requestAnimationFrame(() => {
        if (pending !== null) handlers.onTimeOfDay(pending);
        pending = null;
      });
    }
    pending = v;
  });

  return { el, set };
}

export function createPlaybackIsland(handlers: UiHandlers, initialScale: number) {
  const playBtn = h('button', { class: 'ag-play', type: 'button', 'aria-label': 'Resume (Space)', title: 'Pause / resume (Space)' }, icon('play'));
  playBtn.addEventListener('click', () => handlers.onPauseToggle());
  const clock = h('span', { class: 'ag-pb__clock' }, 'T+0.0 s');
  const caption = h('span', { class: 'ag-pb__caption' }, 'No event');
  const speed = createSegmented<number>(
    [0.5, 1, 2, 4].map((v) => ({ value: v, label: `${v === 0.5 ? '½' : v}×`, title: `Playback speed ${v}×` })),
    [0.5, 1, 2, 4].includes(initialScale) ? initialScale : 1,
    (v) => handlers.onTimeScale(v),
    'Playback speed',
  );
  const el = h('div', { class: 'ag-island ag-pb', dataset: { active: 'false' } }, playBtn, h('div', { class: 'ag-pb__read' }, clock, caption), speed.el);
  let playing = false;

  return {
    el,
    speed,
    setActive(active: boolean) {
      el.dataset.active = String(active);
      playBtn.disabled = !active;
      if (!active) {
        setText(clock, 'T+0.0 s');
        setText(caption, 'No event');
      }
    },
    setCaption(text: string) {
      setText(caption, text);
    },
    setSimTime(s: number) {
      setText(clock, fmtSimTime(s));
    },
    setPlaying(p: boolean) {
      if (p === playing) return;
      playing = p;
      playBtn.replaceChildren(icon(p ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', p ? 'Pause (Space)' : 'Resume (Space)');
      el.dataset.playing = String(p);
    },
  };
}

export function createViewsIsland(handlers: UiHandlers, initial: CameraPresetId) {
  const list = h('div', { class: 'ag-views__list', role: 'toolbar', 'aria-label': 'Camera views' });
  const el = h('div', { class: 'ag-island ag-views' }, h('span', { class: 'ag-views__ico', title: 'Camera views' }, icon('camera')), list);
  let presets: CameraPreset[] = [];
  let active: CameraPresetId = initial;
  const buttons = new Map<CameraPresetId, HTMLButtonElement>();

  function select(id: CameraPresetId) {
    active = id;
    buttons.forEach((b, bid) => {
      b.classList.toggle('is-on', bid === id);
      b.setAttribute('aria-pressed', String(bid === id));
    });
  }

  return {
    el,
    get presets() {
      return presets;
    },
    setPresets(p: CameraPreset[]) {
      presets = p;
      list.replaceChildren();
      buttons.clear();
      p.forEach((preset, i) => {
        const b = h(
          'button',
          { class: 'ag-view', type: 'button', title: `${preset.label}${i < 9 ? ` (${i + 1})` : ''}`, 'aria-pressed': 'false' },
          i < 9 ? h('kbd', { class: 'ag-view__key' }, String(i + 1)) : null,
          h('span', { class: 'ag-view__label' }, SHORT[preset.id] ?? preset.label),
        );
        b.addEventListener('click', () => go(preset.id));
        buttons.set(preset.id, b);
        list.append(b);
      });
      select(active);
    },
    /** Trigger by index (keyboard 1–7). */
    goIndex(i: number) {
      const p = presets[i];
      if (p) go(p.id);
    },
  };

  function go(id: CameraPresetId) {
    select(id);
    handlers.onCameraPreset(id);
  }
}

export function createFooter() {
  const stats = h('span', { class: 'ag-foot__stats' }, '');
  const el = h(
    'footer',
    { class: 'ag-foot' },
    h('div', { class: 'ag-foot__chip ag-foot__chip--stats', title: 'Modelled buildings and occupants (HAZUS-style day/night occupancy)' }, icon('building'), stats),
    h('div', { class: 'ag-foot__chip ag-foot__chip--attr' }, '© OpenStreetMap contributors · DataSF · USGS · AWS Terrain Tiles'),
  );
  return {
    el,
    setStats(text: string) {
      setText(stats, text);
    },
  };
}
