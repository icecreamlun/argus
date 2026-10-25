/**
 * Per-result playback bookkeeping for the composition root.
 *
 * Everything the HUD needs on every quake-tick is precomputed once per QuakeResult so a tick costs
 * O(log n) instead of rescanning ~5.7k buildings and ~1.1k road blockages (the old per-tick
 * `city.buildings.findIndex` loop cost ~24 ms per frame in the 1906 scenario).
 */
import type { QuakeResult } from '../contracts';

export type QuakeStats = QuakeResult['stats'];

export interface QuakeSession {
  result: QuakeResult;
  /** Stats with only the damage that has manifested by `simSeconds` (failTimeS <= t). */
  statsAt(simSeconds: number): QuakeStats;
  /** Sim time at which strong shaking reaches the city centre (S arrival there). */
  sArrivalAtCentre: number;
  /** Sim time after which the ShakeAlert "shaking now" banner is retired. */
  alertEndsAt: number;
}

/** Number of entries in the ascending array `a` that are <= v. */
function countLE(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createQuakeSession(result: QuakeResult, indexOf: (id: string) => number): QuakeSession {
  const n = result.damage.length;

  // Buildings ordered by the moment their damage manifests, with prefix sums of everything the HUD shows.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => result.damage[a].failTimeS - result.damage[b].failTimeS);
  const failT = new Float64Array(n);
  const cumState = new Int32Array((n + 1) * 5);
  const cumCollapsed = new Int32Array(n + 1);
  const cumFires = new Int32Array(n + 1);
  const cumTrapped = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const d = result.damage[order[k]];
    failT[k] = d.failTimeS;
    for (let s = 0; s < 5; s++) cumState[(k + 1) * 5 + s] = cumState[k * 5 + s];
    cumState[(k + 1) * 5 + d.state]++;
    cumCollapsed[k + 1] = cumCollapsed[k] + (d.collapsed ? 1 : 0);
    cumFires[k + 1] = cumFires[k] + (d.fire ? 1 : 0);
    cumTrapped[k + 1] = cumTrapped[k] + d.trappedEstimate;
  }

  // Road blockages appear when their cause building fails; unknown causes never count.
  const roadT: number[] = [];
  for (const r of result.roads) {
    const i = indexOf(r.causeBuildingId);
    if (i >= 0) roadT.push(result.damage[i].failTimeS);
  }
  const roadFail = Float64Array.from(roadT.sort((a, b) => a - b));

  // City-centre S arrival = ShakeAlert issue time + warning (warning may be negative: blind zone).
  const sArrivalAtCentre = result.shakeAlert.issuedAtS + result.shakeAlert.warningSecondsAtCentre;
  // "Shaking now" lasts as long as strong motion does in the city (median site duration: 1906 ≈ 54 s,
  // HayWired ≈ 19 s, Loma Prieta ≈ 14 s); retiring it flips the HUD to the aftermath phase.
  const durations = result.shaking.map((s) => s.durationS).sort((a, b) => a - b);
  const medianDur = durations.length ? durations[durations.length >> 1] : 15;
  const alertEndsAt = Math.min(result.durationS, sArrivalAtCentre + Math.max(10, medianDur));

  return {
    result,
    sArrivalAtCentre,
    alertEndsAt,
    statsAt(t) {
      const k = countLE(failT, t);
      const b = k * 5;
      return {
        ...result.stats,
        byState: [cumState[b] + (n - k), cumState[b + 1], cumState[b + 2], cumState[b + 3], cumState[b + 4]],
        collapsed: cumCollapsed[k],
        fires: cumFires[k],
        trappedEstimate: Math.round(cumTrapped[k]),
        blockedSegments: countLE(roadFail, t),
      };
    },
  };
}
