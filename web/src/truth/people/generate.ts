/**
 * Ground-truth people for a quake result (pure, deterministic, no three.js).
 *
 *   trapped: on/in buildings with damage state >= 3. Collapsed → clamp(round(trappedEstimate), 1..12), ~50 % standing
 *            on the rubble top (visible from the air); extensive/complete → fewer, ~30 % on the roof. The rest are
 *            buried (hidden: data only, never rendered). They appear a few seconds after their building fails.
 *   crowds:  evacuees gathering in open spaces of the core (named parks/plazas + a few wide intersections), sized
 *            from the nearby occupants at the scenario's hour and the shaking felt there; they assemble 40-125 s.
 * This is the hidden truth Argon is scored against — it is never sent to the model.
 */
import type { AreaRecord, CityData, CrowdTruth, Heightfield, PeopleTruth, PersonTruth, QuakeResult, XZ } from '../../contracts';
import { CORE_BBOX, project } from '../../geo';
import { hashStr, mulberry32, type Rng } from '../../quake/fx/rng';
import { ruinShape } from '../../quake/fx/rules';
import { collapseDuration } from '../../quake/fx/timeline';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Most people rendered at once (instanced) — crowds are scaled down to fit. */
export const MAX_RENDERED = 3600;

// ───────────── 2D helpers ─────────────

function pointInRing(ring: XZ[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

/** Area centroid (falls back to the vertex mean for degenerate rings). */
function ringCentroid(ring: XZ[]): XZ {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let x = 0;
    let z = 0;
    for (const p of ring) {
      x += p[0];
      z += p[1];
    }
    return [x / ring.length, z / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

function ringBBox(ring: XZ[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/** Random point inside `ring`, pulled toward its centroid by `inset` (1 = anywhere, 0.5 = inner half). */
function pointInFootprint(r: Rng, ring: XZ[], c: XZ, inset: number): XZ {
  const [x0, z0, x1, z1] = ringBBox(ring);
  for (let k = 0; k < 24; k++) {
    const x = x0 + (x1 - x0) * r();
    const z = z0 + (z1 - z0) * r();
    if (!pointInRing(ring, x, z)) continue;
    const px = c[0] + (x - c[0]) * inset;
    const pz = c[1] + (z - c[1]) * inset;
    if (pointInRing(ring, px, pz)) return [px, pz];
  }
  return [c[0] + (r() - 0.5) * 1.5, c[1] + (r() - 0.5) * 1.5];
}

/** Uniform grid of building footprints so crowd members never stand inside a building. */
class FootprintGrid {
  private cells = new Map<number, number[]>();
  private readonly cs = 40;
  constructor(private city: CityData) {
    city.buildings.forEach((b, i) => {
      const [x0, z0, x1, z1] = ringBBox(b.footprint);
      for (let gz = Math.floor(z0 / this.cs); gz <= Math.floor(z1 / this.cs); gz++)
        for (let gx = Math.floor(x0 / this.cs); gx <= Math.floor(x1 / this.cs); gx++) {
          const k = gx * 100003 + gz;
          let a = this.cells.get(k);
          if (!a) this.cells.set(k, (a = []));
          a.push(i);
        }
    });
  }
  inside(x: number, z: number): boolean {
    const a = this.cells.get(Math.floor(x / this.cs) * 100003 + Math.floor(z / this.cs));
    if (!a) return false;
    for (const i of a) {
      const b = this.city.buildings[i];
      if (b.minHeight && b.minHeight > 3) continue; // overhangs / skybridges
      if (pointInRing(b.footprint, x, z)) return true;
    }
    return false;
  }
}

/** Rotate (a = offset along the lean direction, h = height above base) so the roof moves toward the lean. */
function leanOffset(dx: number, h: number, dz: number, dir: number, angle: number): [number, number, number] {
  if (angle <= 0) return [dx, h, dz];
  const ux = Math.cos(dir);
  const uz = Math.sin(dir);
  const a = dx * ux + dz * uz;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const a2 = a * c + h * s;
  const h2 = -a * s + h * c;
  return [dx + (a2 - a) * ux, h2, dz + (a2 - a) * uz];
}

// ───────────── crowd sites ─────────────

interface Site {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Open area (m²) used for radius & capacity. */
  area: number;
  polys: XZ[][] | null; // null = intersection (disc)
  deckY?: number;
}

const EXCLUDE = /rooftop|salesforce|playground|school|garden|learning|terrace|gallery/i;

function coreRect() {
  const [x0, z1] = project(CORE_BBOX.south, CORE_BBOX.west);
  const [x1, z0] = project(CORE_BBOX.north, CORE_BBOX.east);
  return { x0, x1, z0, z1 };
}

function findSites(city: CityData, terrain: Heightfield): Site[] {
  const R = coreRect();
  const inCore = (x: number, z: number) => x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1;
  // Named parks & plazas, polygons with the same name merged (Sue Bierman Park is two).
  const byName = new Map<string, AreaRecord[]>();
  for (const a of city.areas) {
    if ((a.kind !== 'park' && a.kind !== 'plaza') || !a.name || EXCLUDE.test(a.name)) continue;
    const c = ringCentroid(a.polygon);
    if (!inCore(c[0], c[1])) continue;
    let l = byName.get(a.name);
    if (!l) byName.set(a.name, (l = []));
    l.push(a);
  }
  const sites: Site[] = [];
  for (const [name, list] of byName) {
    const area = list.reduce((s, a) => s + ringArea(a.polygon), 0);
    if (area < 1800) continue;
    const main = list.reduce((m, a) => (ringArea(a.polygon) > ringArea(m.polygon) ? a : m), list[0]);
    let [x, z] = ringCentroid(main.polygon);
    if (!pointInRing(main.polygon, x, z)) [x, z] = pointInFootprint(mulberry32(hashStr(name)), main.polygon, [x, z], 1);
    const site: Site = { id: `crowd_${main.id}`, name, x, z, area, polys: list.map((a) => a.polygon) };
    if (name === 'Portsmouth Square') {
      // Level deck on the garage roof (streets/plaza/portsmouth.ts): median terrain inside + 0.15 m.
      const hs: number[] = [];
      const [bx0, bz0, bx1, bz1] = ringBBox(main.polygon);
      for (let qz = bz0; qz <= bz1; qz += 3) for (let qx = bx0; qx <= bx1; qx += 3) if (pointInRing(main.polygon, qx, qz)) hs.push(terrain.heightAt(qx, qz));
      hs.sort((p, q) => p - q);
      if (hs.length) site.deckY = hs[hs.length >> 1] + 0.15;
    }
    sites.push(site);
  }

  // A few wide intersections (two differently-named arterials sharing a node).
  const nodes = new Map<string, { x: number; z: number; names: Set<string>; w: number }>();
  for (const r of city.roads) {
    if (!r.name || (r.kind !== 'primary' && r.kind !== 'secondary' && r.kind !== 'tertiary') || r.width < 9 || r.bridge || r.tunnel) continue;
    for (const [x, z] of r.points) {
      if (!inCore(x, z)) continue;
      const k = `${x.toFixed(1)},${z.toFixed(1)}`;
      let n = nodes.get(k);
      if (!n) nodes.set(k, (n = { x, z, names: new Set(), w: 0 }));
      if (!n.names.has(r.name)) {
        n.names.add(r.name);
        n.w += r.width;
      }
    }
  }
  const cands = [...nodes.values()].filter((n) => n.names.size >= 2).sort((a, b) => b.w - a.w || a.x - b.x);
  const picked: Site[] = [];
  for (const n of cands) {
    if (picked.length >= 4) break;
    if (picked.some((p) => Math.hypot(p.x - n.x, p.z - n.z) < 220)) continue;
    if (sites.some((p) => Math.hypot(p.x - n.x, p.z - n.z) < 120)) continue;
    const names = [...n.names].slice(0, 2);
    picked.push({ id: `crowd_x${picked.length}`, name: `${names[0]} & ${names[1]}`, x: n.x, z: n.z, area: 500, polys: null });
  }
  return sites.concat(picked);
}

// ───────────── main ─────────────

export function generatePeople(city: CityData, terrain: Heightfield, result: QuakeResult, seed = 1906): PeopleTruth {
  const B = city.buildings;
  const salt = (hashStr(result.scenario.id) ^ seed) >>> 0;
  const persons: PersonTruth[] = [];
  const byBuilding: PeopleTruth['byBuilding'] = {};

  // ── trapped ──
  for (let i = 0; i < B.length; i++) {
    const d = result.damage[i];
    if (!d || d.state < 3) continue;
    const b = B[i];
    if (b.isPart || b.footprint.length < 3) continue; // anchors carry all the occupants
    const r = mulberry32((hashStr(b.id) ^ salt) >>> 0);
    const T = d.trappedEstimate;
    let n: number;
    let vfrac: number;
    if (d.collapsed) {
      n = clamp(Math.round(T), 1, 12);
      vfrac = 0.5;
    } else if (d.state === 4) {
      n = clamp(Math.round(T), 1, 6);
      vfrac = 0.3;
    } else {
      n = clamp(Math.round(T * 0.6), 0, 3);
      if (n === 0 && b.occupantsDay + b.occupantsNight > 0 && r() < 0.3) n = 1;
      vfrac = 0.3;
    }
    if (n === 0) continue;
    const nVis = Math.min(n, Math.floor(n * vfrac + r()));
    const c = ringCentroid(b.footprint);
    const H = Math.max(b.height, 2);
    // Standing surface above the base, lean of that surface, and how far in from the edge people stand.
    let surf: number;
    let lean = 0;
    let inset = 0.7;
    if (d.collapsed) {
      const s = ruinShape(H, d.collapseFraction, d.leanAngle);
      if (s.shell) {
        surf = s.hin; // rubble-filled interior of the broken shell
        inset = 0.55;
      } else {
        surf = s.top; // roof of the dropped, leaning upper block
        lean = Math.max(d.leanAngle, s.lean);
      }
    } else {
      surf = H * (1 - (d.collapseFraction > 0 ? d.collapseFraction : 0)); // liquefaction settlement crushes a bit
      lean = d.leanAngle;
    }
    const tFail = d.failTimeS + (d.collapsed ? collapseDuration(H, d.collapseFraction) : 0);
    for (let k = 0; k < n; k++) {
      const visible = k < nVis;
      const [px, pz] = pointInFootprint(r, b.footprint, c, visible ? inset : 0.8);
      const h = visible ? surf + 0.12 : 0.5 + r() * Math.max(0.5, surf - 1.5);
      const [ox, oy, oz] = leanOffset(px - c[0], h, pz - c[1], d.leanDirection, lean);
      persons.push({
        id: `T-${b.id}-${k}`,
        kind: 'trapped',
        buildingId: b.id,
        x: c[0] + ox,
        y: b.baseElevation + oy,
        z: c[1] + oz,
        visible,
        waving: visible,
        appearS: Math.max(d.failTimeS + 3, tFail + 0.8) + r() * 5,
      });
    }
    byBuilding[b.id] = { visible: nVis, hidden: n - nVis };
  }
  const visibleTrapped = persons.filter((p) => p.visible).length;

  // ── crowds ──
  const sites = findSites(city, terrain);
  const h = result.scenario.localHour;
  const dayW = clamp(Math.min((h - 6) / 3, (21 - h) / 4), 0, 1);
  const cents = B.map((b) => (b.isPart ? null : ringCentroid(b.footprint)));
  const raw = sites.map((s) => {
    let occ = 0;
    let mmiSum = 0;
    let mmiN = 0;
    for (let i = 0; i < B.length; i++) {
      const c = cents[i];
      if (!c) continue;
      const dd = Math.hypot(c[0] - s.x, c[1] - s.z);
      if (dd > 170) continue;
      occ += B[i].occupantsDay * dayW + B[i].occupantsNight * (1 - dayW);
      mmiSum += result.shaking[i]?.mmi ?? 6;
      mmiN++;
    }
    const mmi = mmiN ? mmiSum / mmiN : 6;
    // Share of nearby occupants who end up in this open space: grows with the shaking felt there.
    const frac = clamp(0.002 + 0.012 * (mmi - 6.3), 0.003, 0.05);
    const cap = s.polys ? Math.max(30, s.area * 0.5) : 90;
    const lo = s.polys ? 25 : 18;
    return clamp(Math.round(occ * frac), lo, Math.min(360, cap));
  });
  const budget = Math.max(200, MAX_RENDERED - visibleTrapped);
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > budget ? budget / total : 1;

  const grid = new FootprintGrid(city);
  const crowds: CrowdTruth[] = [];
  sites.forEach((s, si) => {
    const r = mulberry32((hashStr(s.id) ^ salt) >>> 0);
    const count = Math.max(8, Math.floor(raw[si] * scale));
    const radius = s.polys ? clamp(Math.sqrt(s.area / Math.PI) * 0.7, 8, 50) : clamp(8 + count / 12, 8, 16);
    const appearS = 40 + r() * 60;
    crowds.push({ id: s.id, name: s.name, x: s.x, z: s.z, radius, count, appearS });
    for (let k = 0; k < count; k++) {
      let x = s.x;
      let z = s.z;
      for (let tries = 0; tries < 14; tries++) {
        // Denser toward the gathering point (sqrt(u)^1.3 radius profile).
        const rr = radius * Math.pow(r(), 0.65);
        const a = r() * Math.PI * 2;
        const qx = s.x + Math.cos(a) * rr;
        const qz = s.z + Math.sin(a) * rr;
        if (s.polys && !s.polys.some((p) => pointInRing(p, qx, qz))) continue;
        if (grid.inside(qx, qz)) continue;
        x = qx;
        z = qz;
        break;
      }
      persons.push({
        id: `C-${s.id}-${k}`,
        kind: 'crowd',
        crowdId: s.id,
        x,
        y: s.deckY ?? terrain.heightAt(x, z) + 0.03,
        z,
        visible: true,
        waving: false,
        appearS: appearS + 25 * Math.pow(r(), 0.7),
      });
    }
  });

  return { persons, crowds, byBuilding };
}
