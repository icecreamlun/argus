/**
 * M4 accuracy timeline (AIR panel): xBD macro-F1 of the model alone vs the model corrected by Argon, one point per
 * applied reconstruction result (ReconStats.history). Dots are coloured by footage source (helicopter / drone);
 * a vertical marker shows when a drone wave was approved (explicit marks from showPlan, else inferred from the
 * history's switch to drone footage). Audience-only: truth-based scores are never sent to Argon.
 */
import type { ReconHistoryPoint } from '../contracts';
import { h } from './dom';

export interface WaveMark {
  simS: number;
  wave: number;
}

const H = 74;
const PAD = { l: 27, r: 6, t: 9, b: 15 };
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Infer wave starts: first drone point, or a drone point > 45 s after the previous drone point. */
function inferMarks(history: ReconHistoryPoint[]): WaveMark[] {
  const out: WaveMark[] = [];
  let lastDrone = -Infinity;
  for (const p of history) {
    if (p.source !== 'drone') continue;
    if (p.simS - lastDrone > 45) out.push({ simS: p.simS, wave: out.length + 1 });
    lastDrone = p.simS;
  }
  return out;
}

export function createTimeline() {
  const svgHost = h('div', { class: 'ag-tl__plot' });
  const tip = h('div', { class: 'ag-tl__tip', role: 'status' });
  const legend = h(
    'div',
    { class: 'ag-tl__legend' },
    h('span', { class: 'ag-tl__key ag-tl__key--model' }, h('i', {}), 'Model alone'),
    h('span', { class: 'ag-tl__key ag-tl__key--fused' }, h('i', {}), 'Model + Argon'),
    h('span', { class: 'ag-tl__key ag-tl__key--heli' }, h('i', {}), 'Heli'),
    h('span', { class: 'ag-tl__key ag-tl__key--drone' }, h('i', {}), 'Drone'),
  );
  const el = h(
    'div',
    { class: 'ag-tl', hidden: true },
    h('div', { class: 'ag-tl__head' }, h('span', { class: 'ag-label' }, 'Accuracy over time'), h('span', { class: 'ag-tl__unit' }, 'xBD macro-F1 · whole core area')),
    h('div', { class: 'ag-tl__wrap' }, svgHost, tip),
    legend,
  );

  let pts: ReconHistoryPoint[] = [];
  let key = '';
  let geo: { x(s: number): number; y(v: number): number; w: number } | null = null;

  function render(history: ReconHistoryPoint[], marks: WaveMark[]) {
    const w = Math.max(180, Math.round(svgHost.clientWidth || 248));
    const s0 = history[0].simS;
    const s1raw = history[history.length - 1].simS;
    const xs = [s0, s1raw, ...marks.map((m) => m.simS)];
    let a = Math.min(...xs);
    let b = Math.max(...xs);
    if (b - a < 20) {
      a -= 10;
      b += 10;
    }
    const vals = history.flatMap((p) => [p.predictionF1, p.fusedF1]);
    let lo = Math.max(0, Math.floor((Math.min(...vals) - 0.04) * 10) / 10);
    let hi = Math.min(1, Math.ceil((Math.max(...vals) + 0.04) * 10) / 10);
    // At least 40 points of range, grown in 10% steps.
    while (hi - lo < 0.395) {
      if (hi < 0.999) hi += 0.1;
      if (hi - lo < 0.395 && lo > 0.001) lo -= 0.1;
    }
    // Even number of 10% steps so the midline is a round value too.
    lo = Math.round(lo * 10) / 10;
    hi = Math.round(hi * 10) / 10;
    if (Math.round((hi - lo) * 10) % 2) {
      if (hi < 1) hi = Math.round(hi * 10 + 1) / 10;
      else lo = Math.round(lo * 10 - 1) / 10;
    }
    const x = (s: number) => PAD.l + ((s - a) / (b - a)) * (w - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    geo = { x, y, w };

    // Step lines: a metric holds its value until the next applied result.
    const step = (f: (p: ReconHistoryPoint) => number) =>
      history.map((p, i) => (i ? `H${x(p.simS).toFixed(1)}V${y(f(p)).toFixed(1)}` : `M${x(p.simS).toFixed(1)},${y(f(p)).toFixed(1)}`)).join('');
    const model = step((p) => p.predictionF1);
    const fused = step((p) => p.fusedF1);
    const last = history[history.length - 1];
    const area = `${fused}V${(H - PAD.b).toFixed(1)}H${x(history[0].simS).toFixed(1)}Z`;
    const mid = (lo + hi) / 2;
    const grid = [hi, mid, lo]
      .map((v) => `<line class="ag-tl__grid" x1="${PAD.l}" x2="${w - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ag-tl__axis" x="${PAD.l - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${pct(v)}</text>`)
      .join('');
    const markSvg = marks
      .map((m) => {
        const mx = x(m.simS).toFixed(1);
        return `<line class="ag-tl__mark" x1="${mx}" x2="${mx}" y1="${PAD.t - 2}" y2="${H - PAD.b}"/><text class="ag-tl__markLabel" x="${(+mx + 3).toFixed(1)}" y="${PAD.t + 1}">W${m.wave}</text>`;
      })
      .join('');
    const dots = history
      .map((p) => `<circle class="ag-tl__dot ag-tl__dot--${p.source}" cx="${x(p.simS).toFixed(1)}" cy="${y(p.fusedF1).toFixed(1)}" r="3"/>`)
      .join('');
    svgHost.innerHTML = `<svg class="ag-tl__svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Accuracy over time: model alone ${pct(last.predictionF1)}, model plus Argon ${pct(last.fusedF1)}">
      ${grid}
      <path class="ag-tl__area" d="${area}"/>
      ${markSvg}
      <path class="ag-tl__model" d="${model}"/>
      <path class="ag-tl__fused" d="${fused}"/>
      ${dots}
      <line class="ag-tl__cross" x1="0" x2="0" y1="${PAD.t - 2}" y2="${H - PAD.b}" visibility="hidden"/>
      <text class="ag-tl__axis" x="${PAD.l}" y="${H - 3}">T+${Math.round(a)} s</text>
      <text class="ag-tl__axis" x="${w - PAD.r}" y="${H - 3}" text-anchor="end">T+${Math.round(b)} s</text>
    </svg>`;
  }

  // Hover: crosshair + tooltip on the nearest result.
  svgHost.addEventListener('pointermove', (e) => {
    if (!geo || !pts.length) return;
    const r = svgHost.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(geo.x(p.simS) - mx) < Math.abs(geo.x(best.simS) - mx)) best = p;
    const cx = geo.x(best.simS);
    const cross = svgHost.querySelector('.ag-tl__cross');
    cross?.setAttribute('x1', cx.toFixed(1));
    cross?.setAttribute('x2', cx.toFixed(1));
    cross?.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('b', {}, `T+${Math.round(best.simS)} s · ${best.source === 'drone' ? 'drone' : 'heli'}`),
      h('span', {}, `Model ${pct(best.predictionF1)} → `, h('em', {}, pct(best.fusedF1))),
      h('span', {}, `${best.observed} observed · ${best.collapsesConfirmed} collapses`),
    );
    tip.classList.add('is-on');
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(geo.w - tw, cx - tw / 2))}px`;
  });
  svgHost.addEventListener('pointerleave', () => {
    tip.classList.remove('is-on');
    svgHost.querySelector('.ag-tl__cross')?.setAttribute('visibility', 'hidden');
  });

  return {
    el,
    /** Live update. marks = approved waves (optional; inferred from drone points when empty). */
    set(history: ReconHistoryPoint[] | undefined, marks: WaveMark[] = []) {
      // Plot the fixed-set (whole core area) metrics when present: the denominator never changes, so the
      // model line is flat and the corrected line only moves as observations correct the model.
      const raw = (history ?? []).slice().sort((p, q) => p.simS - q.simS);
      const hist = raw.map((p) => ({ ...p, predictionF1: p.cityPredictionF1 ?? p.predictionF1, fusedF1: p.cityFusedF1 ?? p.fusedF1 }));
      // Start the corrected line on the model baseline (before the first result nothing is corrected yet).
      if (hist.length && hist[0].cityPredictionF1 !== undefined) hist.unshift({ ...hist[0], simS: Math.max(0, hist[0].simS - 12), fusedF1: hist[0].predictionF1, observed: 0, collapsesConfirmed: 0, peopleSeen: 0 });
      el.hidden = hist.length === 0;
      if (!hist.length) {
        pts = [];
        key = '';
        return;
      }
      const m = marks.length ? marks : inferMarks(hist);
      const lastP = hist[hist.length - 1];
      const k = `${hist.length}|${lastP.simS}|${lastP.fusedF1}|${lastP.predictionF1}|${m.map((x) => `${x.wave}@${x.simS}`).join(',')}|${svgHost.clientWidth}`;
      pts = hist;
      if (k === key) return;
      key = k;
      render(hist, m);
    },
  };
}
