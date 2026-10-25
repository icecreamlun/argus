/**
 * M5: turn Argon's RescuePlan into drawable RoutedAssignment[] using the road router.
 * One route per (facility, incident, mode) is computed and shared by every unit of that assignment.
 * Unknown facility ids fall back to the nearest facility that normally fields the unit type (else nearest);
 * unknown incident ids are skipped.
 */
import type { CopilotSituation, Facility, RescuePlan, RoutedAssignment, RouterHandle, RouteResult } from '../contracts';
import { facilitiesFor } from './facilities';

export function routePlan(plan: RescuePlan, situation: CopilotSituation, router: RouterHandle, opts?: { maxUnitsPerAssignment?: number }): RoutedAssignment[] {
  const maxUnits = opts?.maxUnitsPerAssignment ?? 12;
  const facById = new Map(situation.facilities.map((f) => [f.id, f]));
  const incById = new Map(situation.incidents.map((i) => [i.id, i]));
  const cache = new Map<string, RouteResult>();
  const out: RoutedAssignment[] = [];
  plan.assignments.forEach((a, ai) => {
    const inc = incById.get(a.incidentId) ?? incById.get(`I-${a.incidentId}`);
    if (!inc) return;
    let fac: Facility | undefined = facById.get(a.fromFacilityId);
    if (!fac) {
      const pool = facilitiesFor(a.unitType, situation.facilities);
      const list = pool.length ? pool : situation.facilities;
      fac = list.reduce<Facility | undefined>((best, f) => (!best || Math.hypot(f.x - inc.x, f.z - inc.z) < Math.hypot(best.x - inc.x, best.z - inc.z) ? f : best), undefined);
    }
    if (!fac) return;
    const air = a.unitType === 'helicopter';
    const key = `${fac.id}|${inc.id}|${air ? 'air' : 'road'}`;
    let route = cache.get(key);
    if (!route) {
      route = router.route([fac.x, fac.z], [inc.x, inc.z], { unitType: a.unitType });
      cache.set(key, route);
    }
    const n = Math.max(1, Math.min(maxUnits, Math.round(a.count) || 1));
    for (let k = 0; k < n; k++) out.push({ key: `a${ai}-${k}`, unitType: a.unitType, fromFacilityId: fac.id, incidentId: inc.id, task: a.task, route });
  });
  return out;
}
