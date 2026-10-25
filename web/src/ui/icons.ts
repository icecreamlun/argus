/**
 * Inline SVG icon set. 20×20 grid, 1.5 px strokes, round caps/joins, currentColor.
 * Keep every glyph on the same grid so they read as one family.
 */
import { frag } from './dom';

const S = (body: string, vb = '0 0 20 20') =>
  `<svg class="ag-ico" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  /** Argus mark: an eye whose pupil line is a seismogram. */
  logo: `<svg class="ag-logo" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M2.5 14c3.2-5.6 7-8.4 11.5-8.4S22.3 8.4 25.5 14c-3.2 5.6-7 8.4-11.5 8.4S5.7 19.6 2.5 14Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M5.5 14h4.2l1.6-3.4 2.1 7.6 2.2-10.4 1.9 8.2 1.3-2h3.7" stroke="var(--ag-accent)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  chevron: S('<path d="M6 8l4 4 4-4"/>'),
  close: S('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
  play: `<svg class="ag-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 4.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L7.4 4.1a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>`,
  pause: `<svg class="ag-ico" viewBox="0 0 20 20" aria-hidden="true"><rect x="5.2" y="4.5" width="3.4" height="11" rx="1" fill="currentColor"/><rect x="11.4" y="4.5" width="3.4" height="11" rx="1" fill="currentColor"/></svg>`,
  reset: S('<path d="M4.5 10a5.5 5.5 0 1 0 1.7-4"/><path d="M4.2 3.6v3.2h3.2"/>'),
  sun: S('<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v1.7M10 15.8v1.7M2.5 10h1.7M15.8 10h1.7M4.7 4.7l1.2 1.2M14.1 14.1l1.2 1.2M4.7 15.3l1.2-1.2M14.1 5.9l1.2-1.2"/>'),
  moon: S('<path d="M15.6 12.4A6.2 6.2 0 0 1 7.6 4.4a6.2 6.2 0 1 0 8 8Z"/>'),
  twilight: S('<path d="M3 13.5h14M5.5 16.5h9"/><path d="M6.4 13.5a3.6 3.6 0 0 1 7.2 0"/><path d="M10 4.5v2M4.6 7.4l1.3 1.2M15.4 7.4l-1.3 1.2"/>'),
  camera: S('<path d="M3 6.8h2.7l1.4-2h5.8l1.4 2H17v8.7H3z"/><circle cx="10" cy="11" r="2.7"/>'),
  layers: S('<path d="M10 3.5 2.8 7.3 10 11.1l7.2-3.8L10 3.5Z"/><path d="m2.8 10.6 7.2 3.8 7.2-3.8"/><path d="m2.8 13.8 7.2 3.8 7.2-3.8" opacity=".55"/>'),
  alert: S('<path d="M10 3.2 2.6 16.2h14.8L10 3.2Z"/><path d="M10 8.2v3.6"/><circle cx="10" cy="14" r=".4" fill="currentColor"/>'),
  flame: S('<path d="M10 17.2c3 0 5-2 5-4.8 0-3.2-2.7-4.8-3.3-8.4-1.9 1.2-2.9 3.2-2.7 5.1-.9-.4-1.6-1.3-1.8-2.4C5.9 8 5 9.8 5 12.4c0 2.8 2 4.8 5 4.8Z"/>'),
  building: S('<path d="M4.5 17V4.5h7V17M11.5 8.5h4V17M3 17h14"/><path d="M7 7.5h2M7 10.5h2M7 13.5h2M13.5 11.5h0M13.5 14h0"/>'),
  collapse: S('<path d="M3 17h14"/><path d="M4.5 17l1.6-5.4 3 1.4 1.2-4.6 2.6 2.9 2.6-1.7L15.5 17"/><path d="M6 6.5l1.4-2M11 4.5l.8-1.6M14.5 6.4l1.6-1.3"/>'),
  people: S('<circle cx="7.4" cy="7" r="2.4"/><path d="M2.8 16.2c.4-2.8 2.2-4.3 4.6-4.3s4.2 1.5 4.6 4.3"/><circle cx="13.6" cy="7.6" r="2"/><path d="M13 11.9c2.2 0 3.7 1.3 4.1 3.8"/>'),
  trapped: S('<path d="M2.8 9.5 10 4l7.2 5.5"/><path d="M4.5 8.3V16h11V8.3"/><circle cx="10" cy="10.6" r="1.5"/><path d="M7.6 16c.3-1.8 1.2-2.8 2.4-2.8s2.1 1 2.4 2.8"/>'),
  road: S('<path d="M6 3.5 3.5 16.5M14 3.5l2.5 13M10 4v2M10 9v2M10 14v2"/>'),
  roadBlock: S('<path d="M3 9h14v4H3z"/><path d="m5.5 9-2 4M9.5 9l-2 4M13.5 9l-2 4M17 9.6 15.2 13"/><path d="M5 13v3.5M15 13v3.5"/>'),
  wave: S('<path d="M2 10h2.2l1.4-3.2 2 7.4 2.2-10.4 2 9 1.4-4.6 1.2 1.8H18"/>'),
  pin: S('<path d="M10 17.2s5.2-4.8 5.2-9a5.2 5.2 0 1 0-10.4 0c0 4.2 5.2 9 5.2 9Z"/><circle cx="10" cy="8.2" r="1.8"/>'),
  depth: S('<path d="M3 5.5h14"/><path d="M10 8v8.5M7 13.6l3 3 3-3"/>'),
  ruler: S('<path d="M3.2 13.6 13.6 3.2l3.2 3.2L6.4 16.8z"/><path d="m6.2 10.6 1.6 1.6M8.6 8.2l1.2 1.2M11 5.8l1.6 1.6"/>'),
  clock: S('<circle cx="10" cy="10" r="6.8"/><path d="M10 6.2V10l2.6 1.6"/>'),
  check: S('<path d="m5 10.4 3.1 3 6.9-7"/>'),
  plus: S('<path d="M10 4.5v11M4.5 10h11"/>'),
  target: S('<circle cx="10" cy="10" r="6.2"/><circle cx="10" cy="10" r="2.2"/><path d="M10 1.8v3M10 15.2v3M1.8 10h3M15.2 10h3"/>'),
  info: S('<circle cx="10" cy="10" r="6.8"/><path d="M10 9.2v4.4"/><circle cx="10" cy="6.6" r=".4" fill="currentColor"/>'),
  liquefaction: S('<path d="M3 8.5c1.2-1 2.3-1 3.5 0s2.3 1 3.5 0 2.3-1 3.5 0 2.3 1 3.5 0"/><path d="M3 12.5c1.2-1 2.3-1 3.5 0s2.3 1 3.5 0 2.3-1 3.5 0 2.3 1 3.5 0"/><path d="M3 16.2h14" opacity=".55"/>'),
  softStory: S('<path d="M4.5 3.5h11v7h-11z"/><path d="M4.5 10.5 3.8 16.5M15.5 10.5l.7 6M3 16.5h14"/><path d="M7.5 6.2h1.5M11 6.2h1.5"/>'),
  landmark: S('<path d="M10 2.8 11.9 7l4.5.4-3.4 3 1 4.4L10 12.5l-4 2.3 1-4.4-3.4-3L8.1 7 10 2.8Z"/>'),
  keyboard: S('<rect x="2.5" y="5.5" width="15" height="9" rx="1.6"/><path d="M5.5 8.5h0M8.5 8.5h0M11.5 8.5h0M14.5 8.5h0M6.5 11.5h7"/>'),
  sliders: S('<path d="M4 6h12M4 14h12"/><circle cx="8" cy="6" r="1.8" fill="var(--ag-ico-fill, transparent)"/><circle cx="12.5" cy="14" r="1.8" fill="var(--ag-ico-fill, transparent)"/>'),
  arrowRight: S('<path d="M3.5 10h12M11.5 6l4 4-4 4"/>'),
  /* M4 drones */
  drone: S('<circle cx="5" cy="5" r="2.4"/><circle cx="15" cy="5" r="2.4"/><circle cx="5" cy="15" r="2.4"/><circle cx="15" cy="15" r="2.4"/><path d="m6.9 6.9 1.5 1.5M13.1 6.9l-1.5 1.5M6.9 13.1l1.5-1.5M13.1 13.1l-1.5-1.5"/><rect x="8.1" y="8.1" width="3.8" height="3.8" rx="1"/>'),
  orbit: S('<path d="M7.6 14.2V7.2h4.8v7"/><path d="M5.2 10.6C3.4 11.3 2.5 12 2.5 12.8c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9c0-.8-.9-1.5-2.7-2.2"/><path d="m14.2 9.4 1.3 1-1.1 1.2"/>'),
  survey: S('<path d="M3.5 7V3.5H7M13 3.5h3.5V7M16.5 13v3.5H13M7 16.5H3.5V13"/><circle cx="10" cy="10" r="2.3"/>'),
  expand: S('<path d="M11.5 3.5h5v5M8.5 16.5h-5v-5M16.5 3.5l-5 5M3.5 16.5l5-5"/>'),
  /* M5 copilot */
  spark: `<svg class="ag-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2c.55 4.05 3.05 6.95 7.6 7.8-4.55.85-7.05 3.75-7.6 7.8-.55-4.05-3.05-6.95-7.6-7.8 4.55-.85 7.05-3.75 7.6-7.8Z" fill="currentColor"/><path d="M15.6 2.4c.2 1.3.9 2 2.1 2.2-1.2.2-1.9.9-2.1 2.2-.2-1.3-.9-2-2.1-2.2 1.2-.2 1.9-.9 2.1-2.2Z" fill="currentColor" opacity=".6"/></svg>`,
  send: S('<path d="M10 16V4.5M5 9.2l5-5 5 5"/>'),
  route: S('<circle cx="5" cy="15" r="1.8"/><circle cx="15" cy="5" r="1.8"/><path d="M6.8 15h5.4a2.6 2.6 0 0 0 0-5.2H7.8a2.6 2.6 0 0 1 0-5.2h5.4"/>'),
  chat: S('<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 16 14H9l-3.8 2.8V14H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5Z"/>'),
  uEngine: S('<path d="M2.5 13.5V8.2h8.2v5.3M10.7 9.6h3.4l2.4 2.4v1.5"/><path d="M2.5 13.5h14"/><circle cx="5.6" cy="14.2" r="1.5" fill="currentColor"/><circle cx="13.6" cy="14.2" r="1.5" fill="currentColor"/><path d="M3.5 6.2 10 4.4"/>'),
  uTruck: S('<path d="M2.5 13.5V9.5h9.5v4M12 10.5h2.6l1.9 1.9v1.1M2.5 13.5h14"/><circle cx="5.6" cy="14.2" r="1.5" fill="currentColor"/><circle cx="13.6" cy="14.2" r="1.5" fill="currentColor"/><path d="M3 7.6 14.5 3.5M5.4 6.8l-.5-1.4M8.4 5.7l-.5-1.4M11.4 4.6l-.5-1.4"/>'),
  uUsar: S('<path d="M3.5 12.5a6.5 6.5 0 0 1 13 0"/><path d="M2.5 12.5h15v1.8h-15z"/><path d="M10 6v3.2M7.4 6.7l.7 2.6M12.6 6.7l-.7 2.6"/>'),
  uAmbulance: `<svg class="ag-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3.2h4v4.8h4.8v4H12v4.8H8V12H3.2V8H8z" fill="currentColor"/></svg>`,
  uPolice: S('<path d="M10 2.6 16 5v4.4c0 3.7-2.5 6.6-6 8-3.5-1.4-6-4.3-6-8V5l6-2.4Z"/><path d="m10 6.6.95 1.95 2.15.3-1.55 1.5.37 2.13L10 11.48l-1.92 1 .37-2.13-1.55-1.5 2.15-.3L10 6.6Z" fill="currentColor" stroke-width="1"/>'),
  uHeli: S('<path d="M2.5 4.5h15M10 4.5v2.4"/><path d="M6.4 9.6c0-1.5 1.3-2.7 3.4-2.7h1.4c2.3 0 3.6 1.6 3.6 3.6 0 1.9-1.4 3.2-3.4 3.2H9.6c-1.9 0-3.2-1.6-3.2-4.1Z"/><path d="M6.6 10H2.8M2.8 8.6v2.8M9 13.7l-.8 2.3M13 13.7l.8 2.3M7 16h8.6"/>'),
  /* ShakeAlert protective-action pictograms (24 grid, filled figures, after the Earthquake Country Alliance art). */
  drop: `<svg class="ag-picto" viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
      <circle cx="9" cy="10.2" r="2.7"/>
      <path d="M11.6 13.4c1.5-.4 3 .1 4 1.1l3.1 3.1 4.6.2c1 .1 1.7.9 1.7 1.9v4.4a1.6 1.6 0 0 1-3.2 0v-3l-4.2-.2-2.7 3.4h4a1.6 1.6 0 0 1 0 3.2H11a1.6 1.6 0 0 1-1.3-2.6l2.7-3.4-1.8-1.8-2.4 3.7a1.6 1.6 0 1 1-2.7-1.7l3.2-5c.6-.9 1.6-1.4 2.9-1.3Z"/>
      <path d="M3 27.6h26" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
    </svg>`,
  cover: `<svg class="ag-picto" viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
      <path d="M3.5 9.4h25" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M6 9.6v18M26 9.6v18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="12" cy="15.4" r="2.3"/>
      <path d="M14.2 17.6c1.1-.2 2.2.2 2.9 1l2.2 2.4 2.7.1c.8 0 1.4.7 1.4 1.5v3.2a1.3 1.3 0 0 1-2.6 0v-2.2l-3-.1-1.8 2.3h2.6a1.3 1.3 0 0 1 0 2.6h-5.2a1.3 1.3 0 0 1-1-2.1l2-2.6-1.2-1.3-1.6 2.5a1.3 1.3 0 0 1-2.2-1.4l2.2-3.5c.5-.8 1.4-1.2 2.6-1.3Z"/>
      <path d="M10.4 12.8l-1.8-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`,
  hold: `<svg class="ag-picto" viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
      <path d="M3.5 9.4h25" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M6 9.6v18M26 9.6v18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="13.2" cy="16" r="2.3"/>
      <path d="M15.4 18.2c1.1-.2 2.2.2 2.9 1l2.2 2.4 2.1.1c.8 0 1.4.7 1.4 1.5v3a1.3 1.3 0 0 1-2.6 0v-2l-2.4-.1-1.8 2.3h2.6a1.3 1.3 0 0 1 0 2.6h-5.2a1.3 1.3 0 0 1-1-2.1l2-2.6-1.2-1.3-1.6 2.5a1.3 1.3 0 0 1-2.2-1.4l2.2-3.5c.5-.8 1.4-1.2 2.6-1.3Z"/>
      <path d="M17.6 19.6l4.1-4.4 3.4-1.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`,
} as const;

export type IconName = keyof typeof ICONS;

/** New icon element (each call returns a fresh node). */
export function icon(name: IconName, cls?: string): Element {
  const el = frag(ICONS[name]);
  if (cls) el.classList.add(...cls.split(' '));
  return el;
}
