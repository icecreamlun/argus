/**
 * Live synthetic seismogram for the study-area site (helicorder-style strip).
 * Idle: microseismic noise scrolling in real time. During a quake: P and S arrivals computed from the
 * hypocentral distance, amplitude scaled by the expected intensity, coda decay; scrolls with sim time
 * (so it freezes when playback is paused). Purely illustrative — labelled "synthetic" in the UI.
 */
import { h } from './dom';

export interface SeismoQuake {
  /** Hypocentral distance to the site (km). */
  distanceKm: number;
  mag: number;
  /** Expected MMI at the site (drives amplitude). */
  mmi: number;
}

const VP = 6.1; // km/s, crustal P velocity
const VS = 3.5; // km/s, crustal S velocity
const WINDOW_S = 24; // seconds of trace visible

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smooth 1D value noise in [-1, 1]. */
function vn(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

export function arrivals(q: SeismoQuake): { p: number; s: number; dur: number } {
  // Strong-motion duration grows ~exponentially with magnitude (rough Trifunac–Brady-like scaling).
  const dur = Math.max(3, Math.min(45, 2.2 * Math.pow(2, q.mag - 5)));
  return { p: q.distanceKm / VP, s: q.distanceKm / VS, dur };
}

/** Atkinson & Wald (2007) California intensity prediction — a rough, UI-only estimate before the model reports. */
export function estimateMmi(mag: number, epicentralKm: number): number {
  const R = Math.sqrt(epicentralKm * epicentralKm + 14 * 14);
  const lr = Math.log10(R);
  const B = Math.max(0, Math.log10(R / 50));
  const dm = mag - 6;
  const mmi = 12.27 + 2.27 * dm + 0.1304 * dm * dm - 1.3 * lr - 0.000707 * R + 1.95 * B - 0.577 * mag * lr;
  return Math.max(1, Math.min(10, mmi));
}

export function createSeismogram() {
  const canvas = h('canvas', { class: 'ag-seis__canvas', 'aria-hidden': 'true' });
  const el = h('div', { class: 'ag-seis' }, canvas);
  const ctx2d = canvas.getContext('2d')!;

  let quake: (SeismoQuake & ReturnType<typeof arrivals>) | null = null;
  let simT = 0;
  let idleT = 0;
  let lastNow = performance.now();
  let lastDraw = 0;
  let colors = { trace: '#555', grid: 'rgba(0,0,0,.1)', hot: '#e33', label: '#888' };
  let colorAge = 1e9;
  let raf = 0;

  /** Ground motion in half-height units (clipped later). */
  function signal(t: number): number {
    let y = 0.05 * vn(t * 23) + 0.03 * vn(t * 6.5 + 91);
    if (!quake) return y;
    const A = Math.max(0.14, Math.min(1.35, (quake.mmi - 2.4) / 6.2));
    const { p, s, dur } = quake;
    if (t >= p) {
      const dt = t - p;
      const pEnv = 0.22 * A * Math.min(1, dt / 0.25) * Math.exp(-Math.max(0, dt - 0.6) / 3.5);
      y += pEnv * (0.7 * vn(t * 21 + 17) + 0.3 * vn(t * 37 + 5));
    }
    if (t >= s) {
      const dt = t - s;
      const rise = Math.min(1, dt / 0.9);
      const body = dt < dur ? 1 : Math.exp(-(dt - dur) / (0.45 * dur + 2));
      const wobble = 0.75 + 0.25 * vn(t * 0.9 + 33);
      y += A * rise * body * wobble * (0.62 * vn(t * 8.5 + 300) + 0.38 * vn(t * 16 + 500));
    }
    return y;
  }

  function refreshColors() {
    const cs = getComputedStyle(el);
    colors = {
      trace: cs.getPropertyValue('--seis-trace').trim() || '#555',
      grid: cs.getPropertyValue('--seis-grid').trim() || 'rgba(0,0,0,.1)',
      hot: cs.getPropertyValue('--seis-hot').trim() || '#e33',
      label: cs.getPropertyValue('--seis-label').trim() || '#888',
    };
    colorAge = 0;
  }

  function draw() {
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (w === 0 || hgt === 0) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    if (colorAge++ > 30) refreshColors();
    const c = ctx2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);

    const tNow = quake ? simT : idleT;
    const t0 = tNow - WINDOW_S;
    const mid = hgt / 2;
    const amp = hgt * 0.46;

    // Baseline + 5 s ticks (scroll with time).
    c.strokeStyle = colors.grid;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, Math.round(mid) + 0.5);
    c.lineTo(w, Math.round(mid) + 0.5);
    for (let k = Math.ceil(t0 / 5) * 5; k <= tNow; k += 5) {
      const x = Math.round(((k - t0) / WINDOW_S) * w) + 0.5;
      c.moveTo(x, mid - 3);
      c.lineTo(x, mid + 3);
    }
    c.stroke();

    // Arrival markers.
    if (quake) {
      c.font = '600 9px "Barlow Semi Condensed", "Barlow", system-ui, sans-serif';
      c.textBaseline = 'top';
      for (const [label, at] of [['P', quake.p], ['S', quake.s]] as const) {
        if (at < t0 || at > tNow) continue;
        const x = Math.round(((at - t0) / WINDOW_S) * w) + 0.5;
        c.strokeStyle = colors.label;
        c.setLineDash([2, 2]);
        c.beginPath();
        c.moveTo(x, 10);
        c.lineTo(x, hgt);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = colors.label;
        c.fillText(label, x + 2.5, 0.5);
      }
    }

    // Trace: one sample per CSS pixel, clipped like a saturated strong-motion record.
    const strong = quake !== null && tNow >= quake.s && tNow < quake.s + quake.dur * 1.6;
    c.strokeStyle = strong ? colors.hot : colors.trace;
    c.lineWidth = 1.15;
    c.lineJoin = 'round';
    c.beginPath();
    let lastY = mid;
    for (let x = 0; x <= w; x += 1) {
      const t = t0 + (x / w) * WINDOW_S;
      const y = mid - Math.max(-0.98, Math.min(0.98, signal(t))) * amp;
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
      lastY = y;
    }
    c.stroke();

    // Pen head.
    c.fillStyle = strong ? colors.hot : colors.trace;
    c.beginPath();
    c.arc(w - 1.5, lastY, 1.8, 0, Math.PI * 2);
    c.fill();
  }

  function loop(now: number) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    idleT += dt;
    if (document.hidden || now - lastDraw < 33) return; // ~30 fps is plenty for a strip chart
    lastDraw = now;
    draw();
  }
  raf = requestAnimationFrame(loop);

  return {
    el,
    setQuake(q: SeismoQuake | null) {
      quake = q ? { ...q, ...arrivals(q) } : null;
      if (!q) simT = 0;
      refreshColors();
    },
    /** Update the expected intensity once the model reports it. */
    setMmi(mmi: number) {
      if (quake) quake.mmi = mmi;
    },
    setSimTime(s: number) {
      simT = s;
    },
    get arrivals() {
      return quake ? { p: quake.p, s: quake.s, dur: quake.dur } : null;
    },
    refreshColors,
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
}
