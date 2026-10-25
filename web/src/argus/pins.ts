/**
 * Recon pins: small HTML labels anchored to world points, projected every frame. DOM (not WebGL) so the type
 * matches the HUD, post-processing never touches them and the helicopter's off-screen camera never films them.
 * Pins behind terrain (hills) or behind the camera are hidden; overlapping pins are decluttered by priority.
 */
import { focusBuilding, focusPoint } from '../ui/focus';
import * as THREE from 'three';
import type { AppContext } from '../contracts';
import { icon, type IconName } from '../ui/icons';

export interface PinSpec {
  key: string;
  kind: 'collapse' | 'trapped' | 'fire' | 'people' | 'crowd';
  text: string;
  x: number;
  y: number;
  z: number;
  priority: number;
  buildingId?: string;
}

interface Pin {
  spec: PinSpec;
  el: HTMLElement;
  w: number;
  h: number;
  shown: boolean;
  tx: string;
}

const ICON: Record<PinSpec['kind'], IconName> = {
  collapse: 'collapse',
  trapped: 'trapped',
  fire: 'flame',
  people: 'people',
  crowd: 'people',
};

const MAX_SHOWN = 36;

export function createPins(ctx: AppContext) {
  const root = document.createElement('div');
  root.className = 'ag-root ag-rpins';
  const uiRoot = document.getElementById('ui-root');
  if (uiRoot?.parentElement) uiRoot.parentElement.insertBefore(root, uiRoot);
  else document.body.append(root);

  let pins: Pin[] = [];
  const byKey = new Map<string, Pin>();
  let suspended = false;
  const v = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  function make(spec: PinSpec): Pin {
    const el = document.createElement('div');
    el.className = `ag-rpin ag-rpin--${spec.kind}${spec.text ? '' : ' ag-rpin--icon'}`;
    el.append(icon(ICON[spec.kind]));
    if (spec.text) {
      const txt = document.createElement('span');
      txt.className = 'ag-rpin__txt';
      txt.textContent = spec.text;
      el.append(txt);
    } else el.title = 'Collapsed (Argon)';
    el.hidden = true;
    root.append(el);
    const pin: Pin = { spec, el, w: 0, h: 0, shown: false, tx: '' };
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-label', `${spec.text || 'Collapsed building'}: show on map`);
    const go = () => (pin.spec.buildingId ? focusBuilding(pin.spec.buildingId) : focusPoint(pin.spec.x, pin.spec.y, pin.spec.z));
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    return pin;
  }

  function occludedByTerrain(x: number, y: number, z: number): boolean {
    const dx = x - camPos.x;
    const dy = y - camPos.y;
    const dz = z - camPos.z;
    for (let k = 1; k < 12; k++) {
      const t = k / 12;
      const px = camPos.x + dx * t;
      const pz = camPos.z + dz * t;
      if (ctx.terrain.heightAt(px, pz) > camPos.y + dy * t + 1.5) return true;
    }
    return false;
  }

  function frame() {
    if (!pins.length) return;
    const cam = ctx.camera;
    const W = window.innerWidth;
    const H = window.innerHeight;
    cam.getWorldPosition(camPos);
    const placed: [number, number, number, number][] = [];
    let shownCount = 0;
    for (const p of pins) {
      let show = !suspended && shownCount < MAX_SHOWN;
      let sx = 0;
      let sy = 0;
      if (show) {
        v.set(p.spec.x, p.spec.y, p.spec.z).project(cam);
        if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) show = false;
        else {
          sx = (v.x * 0.5 + 0.5) * W;
          sy = (-v.y * 0.5 + 0.5) * H;
          if (occludedByTerrain(p.spec.x, p.spec.y, p.spec.z)) show = false;
        }
      }
      if (show) {
        if (!p.w) {
          p.el.hidden = false;
          p.shown = true; // so the overlap test below re-hides it if needed
          p.w = p.el.offsetWidth || 90;
          p.h = p.el.offsetHeight || 22;
        }
        const r: [number, number, number, number] = [sx - p.w / 2 - 3, sy - p.h - 10, sx + p.w / 2 + 3, sy + 1];
        for (const q of placed) {
          if (r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]) {
            show = false;
            break;
          }
        }
        if (show) {
          placed.push(r);
          shownCount++;
          const tx = `translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
          if (tx !== p.tx) {
            p.el.style.transform = tx;
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
  ctx.onUpdate(frame);
  // Widths measured before the HUD fonts load are wrong: re-measure once they are ready.
  document.fonts?.ready.then(() => pins.forEach((p) => (p.w = 0)));

  return {
    root,
    /** Replace the pin set (keeps DOM for unchanged keys). */
    set(specs: PinSpec[]) {
      const next: Pin[] = [];
      const keep = new Set<string>();
      for (const s of specs) {
        keep.add(s.key);
        let p = byKey.get(s.key);
        if (p && (p.spec.text !== s.text || p.spec.kind !== s.kind)) {
          p.el.remove();
          byKey.delete(s.key);
          p = undefined;
        }
        if (!p) {
          p = make(s);
          byKey.set(s.key, p);
        }
        p.spec = s;
        next.push(p);
      }
      for (const [k, p] of byKey)
        if (!keep.has(k)) {
          p.el.remove();
          byKey.delete(k);
        }
      next.sort((a, b) => b.spec.priority - a.spec.priority);
      next.forEach((p, k) => (p.el.style.zIndex = String(next.length - k)));
      pins = next;
      frame();
    },
    setSuspended(on: boolean) {
      suspended = on;
      frame();
    },
    get count() {
      return pins.length;
    },
  };
}
