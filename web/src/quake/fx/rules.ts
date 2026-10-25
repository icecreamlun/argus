/** Shared visual rules used by several FX subsystems (kept dependency-free to avoid import cycles). */
import type { QuakeResult } from '../../contracts';

/** Collapsed groups that lost at least this share of their height become a broken shell; below it, a dropped block. */
export const HIDE_CF = 0.45;

/** Lean exaggeration for dropped-block ruins (a 3° real lean is invisible from the air). */
export const RUIN_LEAN_EXAG = 2.4;

/** The member whose damage drives the whole group: collapsed first, then highest state, then tallest. */
export function leaderOf(result: QuakeResult, members: number[], B: { height: number }[]): number {
  let best = members[0];
  let bk = -1;
  for (const i of members) {
    const d = result.damage[i];
    const k = (d.collapsed ? 10 : 0) + d.state + B[i].height * 1e-4;
    if (k > bk) {
      bk = k;
      best = i;
    }
  }
  return best;
}

/**
 * Final shape of a collapsed building (heights in metres above its base):
 *   shell  (cf ≥ HIDE_CF): the upper storeys pancaked into the lower ones. Jagged wall remnants stand around a
 *          rubble-filled interior (rubble top `hin`), corners surviving higher than the mean remnant `hS`.
 *   block  (cf < HIDE_CF): the lower storeys crushed into a `band` of slabs and rubble; the intact upper block
 *          dropped onto it (roof at `top`) and leans by `lean` toward the failure direction.
 */
export interface RuinShape {
  shell: boolean;
  hS: number;
  hin: number;
  band: number;
  top: number;
  lean: number;
}

export function ruinShape(H: number, cf: number, leanAngle: number): RuinShape {
  const hS = Math.max(1.2, H * (1 - cf));
  if (cf >= HIDE_CF) {
    // Rubble bulks to ~30 % of the lost storeys' height (slabs + voids), on top of the crushed remnant.
    const hin = Math.min(12, Math.max(1.6, 0.3 * cf * H + 0.45 * hS));
    return { shell: true, hS, hin, band: 0, top: Math.max(hS, hin + 1.2), lean: 0 };
  }
  const band = Math.min(4.5, Math.max(0.9, 0.3 * cf * H));
  return { shell: false, hS, hin: band + 0.4, band, top: hS, lean: Math.min(0.24, leanAngle * RUIN_LEAN_EXAG + 0.035) };
}

/** When a collapsed building's own extrusion is swapped for its ruin: the end of the fall, under the dust burst. */
export function ruinSwapTime(failTimeS: number, collapseDurS: number): number {
  return failTimeS + collapseDurS + 0.1;
}
