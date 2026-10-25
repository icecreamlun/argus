/**
 * Static per-building data the FX needs, computed once per city: centroids, areas, building groups
 * (building:part pieces share one `parentId` → they must move as ONE structure), and debris palettes taken
 * from the buildings module's own facade style so rubble matches the walls it came from.
 */
import * as THREE from 'three';
import type { BuildingRecord, CityData, XZ } from '../../contracts';
import { computeStyle, hashString, Mat } from '../../city/buildings/styles';
import { ringArea, ringCentroid, ringPerimeter } from './geom2d';

export const enum Family {
  Brick = 0,
  Stucco = 1,
  Concrete = 2,
  Glass = 3,
  Stone = 4,
  Wood = 5,
  Metal = 6,
}

export interface GroupInfo {
  /** Group key (parentId ?? id). */
  key: string;
  /** Member building indices. */
  members: number[];
  /** Largest-footprint member: its ring/centroid stand for the whole building in debris and fire placement. */
  rep: number;
  /** Tallest member index and the group's roof height above base (m). */
  tallest: number;
  height: number;
  base: number;
  storeys: number;
  family: Family;
  /** Linear-space colours: wall, trim, roof. */
  wall: THREE.Color;
  trim: THREE.Color;
  roof: THREE.Color;
  glassy: boolean;
}

export interface CityPrep {
  n: number;
  cx: Float32Array;
  cz: Float32Array;
  area: Float32Array;
  perimeter: Float32Array;
  /** Group index for each building. */
  groupOf: Int32Array;
  groups: GroupInfo[];
  /** Spatial hash of building centroids (cell = 100 m) for neighbourhood queries. */
  near(x: number, z: number, r: number, out: number[]): number[];
}

const familyOf = (m: Mat): Family => {
  switch (m) {
    case Mat.PaintedBrick:
    case Mat.RedBrick:
    case Mat.Terracotta:
      return Family.Brick;
    case Mat.Stucco:
      return Family.Stucco;
    case Mat.Limestone:
      return Family.Stone;
    case Mat.Concrete:
      return Family.Concrete;
    case Mat.Glass:
      return Family.Glass;
    case Mat.MetalPanel:
    case Mat.Corrugated:
      return Family.Metal;
    case Mat.WoodSiding:
      return Family.Wood;
    default:
      return Family.Concrete;
  }
};

export function prepareCity(city: CityData): CityPrep {
  const B = city.buildings;
  const n = B.length;
  const cx = new Float32Array(n);
  const cz = new Float32Array(n);
  const area = new Float32Array(n);
  const perimeter = new Float32Array(n);
  const groupOf = new Int32Array(n);
  const groups: GroupInfo[] = [];
  const byKey = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const b = B[i];
    const ring = b.footprint as XZ[];
    const c = ringCentroid(ring);
    cx[i] = c[0];
    cz[i] = c[1];
    area[i] = Math.abs(ringArea(ring));
    perimeter[i] = ringPerimeter(ring);
    const key = b.parentId ?? b.id;
    let g = byKey.get(key);
    if (g === undefined) {
      g = groups.length;
      byKey.set(key, g);
      groups.push({
        key,
        members: [],
        rep: i,
        tallest: i,
        height: 0,
        base: b.baseElevation,
        storeys: 1,
        family: Family.Concrete,
        wall: new THREE.Color(),
        trim: new THREE.Color(),
        roof: new THREE.Color(),
        glassy: false,
      });
    }
    groupOf[i] = g;
    groups[g].members.push(i);
  }

  for (const g of groups) {
    let bestA = -1;
    for (const i of g.members) {
      const b = B[i];
      if (area[i] > bestA) {
        bestA = area[i];
        g.rep = i;
      }
      if (b.height > g.height) {
        g.height = b.height;
        g.tallest = i;
      }
      g.base = Math.min(g.base, b.baseElevation);
    }
    const t = B[g.tallest];
    g.height = Math.max(g.height, 3);
    g.storeys = Math.max(1, Math.round(t.levels || g.height / 3.6));
    applyPalette(g, t);
  }

  // Spatial hash of centroids.
  const CELL = 100;
  const cells = new Map<number, number[]>();
  const key = (ix: number, iz: number) => (ix + 1000) * 4000 + (iz + 1000);
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(cx[i] / CELL), Math.floor(cz[i] / CELL));
    let c = cells.get(k);
    if (!c) cells.set(k, (c = []));
    c.push(i);
  }
  const near = (x: number, z: number, r: number, out: number[]) => {
    out.length = 0;
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL);
    const z1 = Math.floor((z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const c = cells.get(key(ix, iz));
        if (!c) continue;
        for (const i of c) if ((cx[i] - x) ** 2 + (cz[i] - z) ** 2 <= r * r) out.push(i);
      }
    return out;
  };

  return { n, cx, cz, area, perimeter, groupOf, groups, near };
}

/** Fill the group's debris palette from the facade style (same call the buildings module makes). */
function applyPalette(g: GroupInfo, tallest: BuildingRecord): void {
  try {
    const s = computeStyle(tallest, hashString(g.key));
    g.family = familyOf(s.material);
    g.wall.copy(s.base);
    g.trim.copy(s.trim);
    g.roof.copy(s.roof);
    g.glassy = s.material === Mat.Glass || s.material === Mat.MetalPanel || (tallest.height > 45 && tallest.yearBuilt > 1960);
  } catch {
    // Style module unavailable or changed — fall back to structure-based guesses.
    const st = tallest.structure;
    g.family = st === 'URM' || st === 'RM' ? Family.Brick : st.startsWith('W') ? Family.Wood : st.startsWith('S') ? Family.Glass : Family.Concrete;
    const c = g.family === Family.Brick ? 0x8a4a36 : g.family === Family.Wood ? 0xd8cfb8 : 0x9a9790;
    g.wall.setHex(c);
    g.trim.setHex(0xcfc8b8);
    g.roof.setHex(0x55524e);
    g.glassy = g.family === Family.Glass;
  }
}
