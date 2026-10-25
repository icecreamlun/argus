/**
 * Rescue layer labels: crisp DOM chips projected every frame (incident priority chips, facility icons,
 * unit count / ETA badges). DOM so type matches the HUD and post-processing never blurs it; hidden behind
 * hills / behind the camera; decluttered by priority. Own root + injected stylesheet (no shared CSS edits).
 */
import * as THREE from 'three';
import type { AppContext, FacilityKind } from '../../contracts';

export type LabelKind = 'incident' | 'facility' | 'badge';

export interface LabelSpec {
  key: string;
  kind: LabelKind;
  x: number;
  y: number;
  z: number;
  /** Declutter priority (higher wins). */
  priority: number;
  /** Incident index for highlight dimming (-1 none). */
  incIdx: number;
  el: HTMLElement;
}

interface Label extends LabelSpec {
  w: number;
  h: number;
  shown: boolean;
  tx: string;
}

const CSS = /* css */ `
.rsq-root { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 9; }
.rsq-l { position: absolute; left: 0; top: 0; will-change: transform; white-space: nowrap; transition: opacity .25s ease; }
.rsq-l[hidden] { display: none; }
.rsq-l.rsq-dim { opacity: .28; }
.rsq-l.rsq-hi { z-index: 999 !important; }

.rsq-inc {
  display: inline-flex; align-items: stretch; translate: -50% calc(-100% - 22px);
  border-radius: 7px; overflow: visible;
  background: rgba(12, 15, 20, .86); color: #f4f6f8;
  font-family: var(--ag-font-cond, 'Barlow Semi Condensed', system-ui, sans-serif);
  font-size: 12px; font-weight: 600; letter-spacing: .015em; line-height: 1;
  box-shadow: 0 6px 18px -6px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.14) inset;
  backdrop-filter: blur(6px);
}
.rsq-inc::after { content: ''; position: absolute; left: 50%; top: 100%; width: 1.5px; height: var(--stem, 22px); margin-left: -.75px;
  background: linear-gradient(var(--c), transparent); }
.rsq-inc .rsq-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 7px 0 0 7px;
  background: var(--c); color: #160604; font-weight: 800; letter-spacing: .04em; }
.rsq-inc .rsq-txt { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px 5px 7px; }
.rsq-inc .rsq-main { color: #fff; }
.rsq-inc .rsq-sub { color: rgba(236,240,244,.66); font-weight: 500; }
.rsq-inc .rsq-sep { width: 3px; height: 3px; border-radius: 50%; background: rgba(255,255,255,.4); }
.rsq-inc.rsq-p1 { font-size: 13.5px; box-shadow: 0 0 0 1.5px var(--c), 0 0 22px -2px var(--c), 0 8px 22px -6px rgba(0,0,0,.7); }
.rsq-inc.rsq-p1 .rsq-tag { padding: 0 8px; }
.rsq-inc.rsq-p1 .rsq-txt { padding: 6px 10px 6px 8px; }
.rsq-inc.rsq-p2 { font-size: 12.5px; box-shadow: 0 0 0 1px var(--c), 0 6px 18px -6px rgba(0,0,0,.6); }
.rsq-inc.rsq-p3 { font-size: 11.5px; }
.rsq-inc.rsq-p0 { font-size: 11px; opacity: .92; }
.rsq-inc.rsq-unv { background: rgba(12,15,20,.72); box-shadow: 0 0 0 1px rgba(255,255,255,.08) inset; outline: 1.5px dashed var(--c); outline-offset: 1px; }
.rsq-inc.rsq-unv .rsq-tag { background: transparent; color: var(--c); border-right: 1.5px dashed var(--c); }
.rsq-inc .rsq-unvtxt { color: var(--c); font-weight: 600; font-size: .86em; text-transform: uppercase; letter-spacing: .06em; }

.rsq-fac { display: inline-flex; align-items: center; gap: 5px; translate: -50% -50%;
  font-family: var(--ag-font-cond, 'Barlow Semi Condensed', system-ui, sans-serif); font-size: 11px; font-weight: 700; letter-spacing: .03em; color: #fff; }
.rsq-fac .rsq-ico { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  background: var(--c); color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,.92), 0 4px 10px -2px rgba(0,0,0,.55); }
.rsq-fac .rsq-ico svg { width: 15px; height: 15px; }
.rsq-fac .rsq-name { padding: 3px 6px; border-radius: 5px; background: rgba(12,15,20,.78); box-shadow: 0 3px 10px -4px rgba(0,0,0,.6); }

.rsq-badge { display: inline-flex; align-items: center; gap: 5px; translate: -50% calc(-100% - 8px);
  padding: 3px 7px 3px 4px; border-radius: 999px; background: rgba(12,15,20,.84); color: #fff;
  font-family: var(--ag-font-mono, 'IBM Plex Mono', ui-monospace, monospace); font-size: 10.5px; font-weight: 600; letter-spacing: -.01em;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 70%, transparent), 0 4px 12px -4px rgba(0,0,0,.6); }
.rsq-badge .rsq-n { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 999px;
  background: var(--c); color: #0b0d10; font-weight: 800; }
.rsq-badge .rsq-eta { color: rgba(255,255,255,.72); font-weight: 500; }
.rsq-badge.rsq-done .rsq-eta { color: #7dffa8; }
.rsq-badge.rsq-moving { box-shadow: 0 0 0 1.5px var(--c), 0 0 14px -2px var(--c), 0 4px 12px -4px rgba(0,0,0,.6); }
`;

const SVG = (inner: string) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const FACILITY_ICON: Record<FacilityKind, string> = {
  fire_station: SVG('<path d="M10 17.2c3 0 5-2 5-4.8 0-3.2-2.7-4.8-3.3-8.4-1.9 1.2-2.9 3.2-2.7 5.1-.9-.4-1.6-1.3-1.8-2.4C5.9 8 5 9.8 5 12.4c0 2.8 2 4.8 5 4.8Z" fill="currentColor" stroke="none"/>'),
  police_station: SVG('<path d="M10 2.8 16 5v4.6c0 3.7-2.6 6.4-6 7.6-3.4-1.2-6-3.9-6-7.6V5l6-2.2Z"/><path d="m10 6.6.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3.9-1.9Z" fill="currentColor" stroke="none"/>'),
  hospital: SVG('<path d="M8 3.5h4v4.5h4.5v4H12v4.5H8V12H3.5V8H8z" fill="currentColor" stroke="none"/>'),
  staging: SVG('<path d="M5 17.5V3"/><path d="M5 3.8h9.5l-2.2 3.1 2.2 3.1H5" fill="currentColor"/>'),
  helipad: SVG('<path d="M6.5 5v10M13.5 5v10M6.5 10h7"/>'),
};

export const FACILITY_HEX: Record<FacilityKind, string> = {
  fire_station: '#d8352a',
  police_station: '#2f6fe0',
  hospital: '#16a36a',
  staging: '#6b7785',
  helipad: '#c9a215',
};

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const st = document.createElement('style');
  st.id = 'rsq-style';
  st.textContent = CSS;
  document.head.append(st);
}

export function el(tag: string, cls: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function createLabels(ctx: AppContext) {
  injectCss();
  const root = el('div', 'ag-root rsq-root');
  root.setAttribute('aria-hidden', 'true');
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot?.parentElement) uiRoot.parentElement.insertBefore(root, uiRoot);
  else document.body.append(root);

  let labels: Label[] = [];
  const byKey = new Map<string, Label>();
  let highlight = -1;
  const v = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  function occluded(x: number, y: number, z: number): boolean {
    const dx = x - camPos.x;
    const dy = y - camPos.y;
    const dz = z - camPos.z;
    for (let k = 1; k < 10; k++) {
      const t = k / 10;
      if (ctx.terrain.heightAt(camPos.x + dx * t, camPos.z + dz * t) > camPos.y + dy * t + 2) return true;
    }
    return false;
  }

  function frame() {
    if (!labels.length) return;
    const cam = ctx.camera;
    const W = window.innerWidth;
    const H = window.innerHeight;
    cam.getWorldPosition(camPos);
    const placed: [number, number, number, number][] = [];
    for (const p of labels) {
      let show = true;
      let sx = 0;
      let sy = 0;
      v.set(p.x, p.y, p.z).project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.08 || Math.abs(v.y) > 1.08) show = false;
      else {
        sx = (v.x * 0.5 + 0.5) * W;
        sy = (-v.y * 0.5 + 0.5) * H;
        if (occluded(p.x, p.y, p.z)) show = false;
      }
      if (show) {
        if (!p.w) {
          p.el.hidden = false;
          p.shown = true;
          p.w = p.el.offsetWidth || 80;
          p.h = p.el.offsetHeight || 20;
        }
        // Box in screen space according to each kind's CSS translate. Incident chips that collide are
        // stacked upward (longer leader stem) instead of being hidden.
        const hi = highlight >= 0 && p.incIdx === highlight;
        const tries = p.kind === 'incident' ? 4 : 1;
        let lift = 0;
        let ok = false;
        let r: [number, number, number, number] = [0, 0, 0, 0];
        for (let k = 0; k < tries && !ok; k++) {
          lift = k * (p.h + 5);
          if (p.kind === 'incident') r = [sx - p.w / 2, sy - p.h - 22 - lift, sx + p.w / 2, sy - 22 - lift];
          else if (p.kind === 'badge') r = [sx - p.w / 2, sy - p.h - 8, sx + p.w / 2, sy - 8];
          else r = [sx - p.w / 2, sy - p.h / 2, sx + p.w / 2, sy + p.h / 2];
          ok = true;
          if (hi && k === 0) break;
          for (const q of placed) {
            if (r[0] < q[2] + 2 && r[2] > q[0] - 2 && r[1] < q[3] + 2 && r[3] > q[1] - 2) {
              ok = false;
              break;
            }
          }
        }
        show = ok;
        if (show) {
          placed.push(r);
          const tx = `translate(${Math.round(sx)}px, ${Math.round(sy - lift)}px)`;
          if (tx !== p.tx) {
            p.el.style.transform = tx;
            if (p.kind === 'incident') p.el.style.setProperty('--stem', `${22 + lift}px`);
            p.tx = tx;
          }
        }
      }
      if (show !== p.shown) {
        p.el.hidden = !show;
        p.shown = show;
      }
    }
  }
  document.fonts?.ready.then(() => labels.forEach((p) => (p.w = 0)));

  function sortLabels() {
    // Highlighted incident first, then by priority.
    labels.sort((a, b) => {
      const ha = highlight >= 0 && a.incIdx === highlight ? 1 : 0;
      const hb = highlight >= 0 && b.incIdx === highlight ? 1 : 0;
      return hb - ha || b.priority - a.priority;
    });
    labels.forEach((p, k) => (p.el.style.zIndex = String(labels.length - k)));
  }

  return {
    root,
    set(specs: LabelSpec[]) {
      for (const l of labels) l.el.remove();
      byKey.clear();
      labels = specs.map((s) => {
        s.el.classList.add('rsq-l');
        s.el.hidden = true;
        root.append(s.el);
        const l: Label = { ...s, w: 0, h: 0, shown: false, tx: '' };
        byKey.set(s.key, l);
        return l;
      });
      sortLabels();
      frame();
    },
    get(key: string) {
      return byKey.get(key);
    },
    /** Moving anchors (badges following the lead unit). */
    move(key: string, x: number, y: number, z: number) {
      const l = byKey.get(key);
      if (!l) return;
      l.x = x;
      l.y = y;
      l.z = z;
    },
    /** Text changed → re-measure. */
    remeasure(key: string) {
      const l = byKey.get(key);
      if (l) l.w = 0;
    },
    setHighlight(incIdx: number) {
      highlight = incIdx;
      for (const l of labels) {
        const related = l.kind === 'facility' ? (l.el.dataset.incs ?? '').split(',').includes(String(incIdx)) : l.incIdx === incIdx;
        l.el.classList.toggle('rsq-dim', incIdx >= 0 && !related);
        l.el.classList.toggle('rsq-hi', incIdx >= 0 && l.incIdx === incIdx);
      }
      sortLabels();
    },
    frame,
    setVisible(on: boolean) {
      root.style.display = on ? '' : 'none';
    },
    clear() {
      for (const l of labels) l.el.remove();
      labels = [];
      byKey.clear();
    },
  };
}
