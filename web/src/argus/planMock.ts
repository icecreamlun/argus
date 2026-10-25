/**
 * M4 mock planner: deterministic heuristic DronePlan from a PlanRequest (used when /api/plan fails and for
 * deterministic screenshots). Clearly labelled mode 'mock'. Same inputs as Argon (no truth).
 *
 * Wave 1 flies min(2, available − 1) drones (one held in reserve when ≥ 2 are free); wave 2 flies every
 * available drone. Each drone takes the best unassigned candidate as its seed, then adds the nearest
 * candidates within 350 m of the seed while the sortie (transit + orbitS per target + return) fits the
 * endurance and the mission has ≤ 4 buildings.
 */
import type { DroneMission, DronePlan, PlanCandidate, PlanRequest } from '../contracts';
import { expandCandidateTargets } from './planner';

const NEAR_M = 350;

export function createMockPlan(req: PlanRequest): DronePlan {
  const wave = req.wave;
  const base = req.drone.base;
  const free = [...req.dronesAvailable];
  const nDrones = wave === 1 ? Math.min(2, Math.max(1, free.length - 1)) : free.length;
  const pool = [...req.candidates].sort((a, b) => b.score - a.score);
  const taken = new Set<string>();
  const missions: DroneMission[] = [];

  const sortieS = (pts: [number, number][], nTargets: number) => {
    let d = 0;
    let p = base;
    for (const q of pts) {
      d += Math.hypot(q[0] - p[0], q[1] - p[1]);
      p = q;
    }
    d += Math.hypot(base[0] - p[0], base[1] - p[1]);
    return d / req.drone.speedMs + nTargets * req.drone.orbitS;
  };

  for (let k = 0; k < nDrones && k < free.length; k++) {
    const seed = pool.find((c) => !taken.has(c.id) && sortieS([[c.x, c.z]], (c.buildingIds?.length ?? 1)) <= req.drone.enduranceS);
    if (!seed) break;
    const picks: PlanCandidate[] = [seed];
    taken.add(seed.id);
    let nb = seed.buildingIds?.length ?? 1;
    const near = pool
      .filter((c) => !taken.has(c.id) && Math.hypot(c.x - seed.x, c.z - seed.z) <= NEAR_M)
      .sort((a, b) => Math.hypot(a.x - seed.x, a.z - seed.z) - Math.hypot(b.x - seed.x, b.z - seed.z));
    for (const c of near) {
      const cb = c.buildingIds?.length ?? 1;
      if (nb + cb > 4) continue;
      const pts = [...picks, c].map((p) => [p.x, p.z] as [number, number]);
      if (sortieS(pts, nb + cb) > req.drone.enduranceS) continue;
      picks.push(c);
      taken.add(c.id);
      nb += cb;
      if (nb >= 4) break;
    }
    const targets = expandCandidateTargets(req, picks.map((p) => p.id));
    if (!targets.length) continue;
    const area = picks.some((p) => p.buildingIds?.length);
    const droneId = free[k];
    missions.push({
      id: `W${wave}-${droneId}`,
      wave,
      droneId,
      kind: area ? 'survey_area' : 'verify_building',
      targetBuildingIds: targets,
      areaCentre: area ? [Math.round(picks.reduce((a, p) => a + p.x, 0) / picks.length), Math.round(picks.reduce((a, p) => a + p.z, 0) / picks.length)] : undefined,
      purpose: `${seed.label}: ${seed.reason}`.slice(0, 160),
      priority: k + 1,
    });
  }

  const reserve = free.filter((d) => !missions.some((m) => m.droneId === d));
  return {
    wave,
    dispatch: missions.length > 0,
    rationale: missions.length
      ? `[Heuristic fallback] Sending ${missions.length} drone${missions.length > 1 ? 's' : ''} to the highest-scoring uncertain targets (unscanned high-risk blocks, low-confidence collapse calls, people seen)` +
        (reserve.length ? `; ${reserve.join(', ')} held in reserve.` : '.')
      : '',
    holdReason: missions.length ? undefined : '[Heuristic fallback] No candidate worth a drone sortie right now.',
    missions,
    model: 'heuristic',
    mode: 'mock',
    latencyMs: 0,
    createdAtSimS: req.simS,
  };
}
