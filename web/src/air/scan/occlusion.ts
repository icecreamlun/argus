/**
 * Cheap line-of-sight test for AR tags: a 2.5D "roof height" raster of every building footprint
 * (tallest record per 4 m cell). A ray from the helicopter camera to a point is occluded when it passes
 * below a roof that belongs to another building. Collapsed buildings are lowered by their live crush.
 */
import type { BuildingRecord, BuildingsHandle } from '../../contracts';
import { cellAt, fillPolygon, type GridRect } from './grid';

export class RoofGrid {
  readonly top: Float32Array;
  readonly owner: Int32Array;
  /** Group (anchor) index per record. */
  readonly group: Int32Array;
  /** Live crush per record (refreshed per capture). */
  private readonly crush: Float32Array;
  private readonly hidden: Uint8Array;
  /** Live visual damage per record (0..4, HAZUS state ramped in at failure; refreshed per capture). */
  private readonly dmg: Float32Array;

  constructor(
    readonly g: GridRect,
    private readonly records: BuildingRecord[],
    indexOf: (id: string) => number,
  ) {
    const cells = g.w * g.h;
    this.top = new Float32Array(cells).fill(-1e9);
    this.owner = new Int32Array(cells).fill(-1);
    this.group = new Int32Array(records.length);
    this.crush = new Float32Array(records.length);
    this.hidden = new Uint8Array(records.length);
    this.dmg = new Float32Array(records.length);
    records.forEach((r, i) => {
      const gi = r.parentId ? indexOf(r.parentId) : i;
      this.group[i] = gi >= 0 ? gi : i;
      const t = r.baseElevation + r.height;
      fillPolygon(g, r.footprint, (k) => {
        if (t > this.top[k]) {
          this.top[k] = t;
          this.owner[k] = i;
        }
      });
    });
  }

  refresh(buildings: BuildingsHandle): void {
    const n = this.records.length;
    for (let i = 0; i < n; i++) {
      const s = buildings.getState(i);
      this.crush[i] = s.crush;
      this.dmg[i] = s.damage;
      // Hidden non-landmark records are rubble (FX swapped them out); landmark ones are replaced by a model.
      this.hidden[i] = s.hidden > 0.5 && !this.records[i].landmark ? 1 : 0;
    }
  }

  /** Live roof top (m) of record i. Shell ruins (swapped-out records) top out at ≤ 40 % of H (fx ruinShape cap). */
  roofTop(i: number): number {
    const r = this.records[i];
    if (this.hidden[i]) return r.baseElevation + Math.max(3, Math.min(0.4 * r.height, r.height * (1 - this.crush[i])));
    return r.baseElevation + r.height * (1 - this.crush[i]);
  }

  /** Tag priority from the live visual state: 2 = collapsed / complete, 1 = extensive, 0 = other. */
  damageTier(i: number): number {
    if (this.hidden[i] || this.crush[i] > 0.05 || this.dmg[i] >= 3.5) return 2;
    return this.dmg[i] >= 2.5 ? 1 : 0;
  }

  /** Effective occluder height at cell k. */
  private cellTop(k: number): number {
    const o = this.owner[k];
    if (o < 0) return -1e9;
    const r = this.records[o];
    if (this.hidden[o]) return r.baseElevation + Math.max(3, Math.min(0.4 * r.height, r.height * (1 - this.crush[o])));
    const t = this.top[k];
    return t - (t - r.baseElevation) * this.crush[o];
  }

  /**
   * True when the segment camera → target passes below a roof of a building other than `targetGroup`
   * (-1 = any building). Stops `stopShort` metres (horizontal) before the target.
   */
  occluded(cx: number, cy: number, cz: number, tx: number, ty: number, tz: number, targetGroup: number, stopShort = 2): boolean {
    const dx = tx - cx;
    const dz = tz - cz;
    const d = Math.hypot(dx, dz);
    if (d < 1) return false;
    const step = this.g.cell * 0.75;
    const end = d - stopShort;
    let lastK = -2;
    for (let s = step; s < end; s += step) {
      const f = s / d;
      const k = cellAt(this.g, cx + dx * f, cz + dz * f);
      if (k < 0 || k === lastK) continue;
      lastK = k;
      const o = this.owner[k];
      if (o < 0 || this.group[o] === targetGroup) continue;
      const y = cy + (ty - cy) * f;
      if (this.cellTop(k) > y + 0.5) return true;
    }
    return false;
  }
}
