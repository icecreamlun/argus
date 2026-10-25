/**
 * Rescue layer demo data (debug / screenshot harness only): a fake CopilotSituation + RescuePlan with real
 * facility locations and routes found by a quick Dijkstra over the city road centrelines.
 *
 *   const { createRescueLayer } = await import('/src/rescue/layer/index.ts');
 *   const { buildDemo } = await import('/src/rescue/layer/debug.ts');
 *   const layer = createRescueLayer(ctx); ctx.scene.add(layer.object);
 *   const d = buildDemo(ctx); layer.show(d.plan, d.situation, d.routed); layer.dispatch();
 */
import type { AppContext, CopilotSituation, Facility, RescueIncident, RescuePlan, RoadStatus, RoutedAssignment, RouteResult, UnitType, XZ } from '../../contracts';
import { project } from '../../geo';
import { groundAt } from './common';

const DRIVABLE = new Set(['primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street']);

interface Graph {
  xs: number[];
  zs: number[];
  adj: { to: number; w: number; road: number; seg: number }[][];
  /** Node is in the largest connected component. */
  main: Uint8Array;
}

function buildGraph(ctx: AppContext): Graph {
  const key = (x: number, z: number) => `${Math.round(x * 2)}_${Math.round(z * 2)}`;
  const ids = new Map<string, number>();
  const g: Graph = { xs: [], zs: [], adj: [], main: new Uint8Array(0) };
  const node = (x: number, z: number) => {
    const k = key(x, z);
    let i = ids.get(k);
    if (i === undefined) {
      i = g.xs.length;
      ids.set(k, i);
      g.xs.push(x);
      g.zs.push(z);
      g.adj.push([]);
    }
    return i;
  };
  ctx.city.roads.forEach((r, ri) => {
    if (!DRIVABLE.has(r.kind) || r.tunnel) return;
    for (let s = 0; s < r.points.length - 1; s++) {
      const a = node(r.points[s][0], r.points[s][1]);
      const b = node(r.points[s + 1][0], r.points[s + 1][1]);
      const w = Math.hypot(r.points[s + 1][0] - r.points[s][0], r.points[s + 1][1] - r.points[s][1]) * (r.kind === 'service' ? 1.6 : 1);
      g.adj[a].push({ to: b, w, road: ri, seg: s });
      g.adj[b].push({ to: a, w, road: ri, seg: s });
    }
  });
  // Largest connected component (snap endpoints only onto it).
  const n = g.xs.length;
  const comp = new Int32Array(n).fill(-1);
  let bestC = 0;
  let bestN = 0;
  for (let i = 0, c = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const st = [i];
    comp[i] = c;
    let sz = 0;
    while (st.length) {
      const v = st.pop()!;
      sz++;
      for (const e of g.adj[v])
        if (comp[e.to] < 0) {
          comp[e.to] = c;
          st.push(e.to);
        }
    }
    if (sz > bestN) {
      bestN = sz;
      bestC = c;
    }
    c++;
  }
  g.main = new Uint8Array(n);
  for (let i = 0; i < n; i++) g.main[i] = comp[i] === bestC ? 1 : 0;
  return g;
}

function nearest(g: Graph, x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < g.xs.length; i++) {
    if (!g.main[i]) continue;
    const d = (g.xs[i] - x) ** 2 + (g.zs[i] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function dijkstra(g: Graph, s: number, t: number, blocked: Set<string>): number[] | null {
  const n = g.xs.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  dist[s] = 0;
  // Binary heap of [d, i].
  const heap: [number, number][] = [[0, s]];
  const push = (e: [number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    if (i === t) break;
    for (const e of g.adj[i]) {
      if (blocked.has(`${e.road}:${e.seg}`)) continue;
      const nd = d + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = i;
        push([nd, e.to]);
      }
    }
  }
  if (!isFinite(dist[t])) return null;
  const path: number[] = [];
  for (let i = t; i >= 0; i = prev[i]) path.push(i);
  return path.reverse();
}

export function buildDemo(ctx: AppContext): { plan: RescuePlan; situation: CopilotSituation; routed: RoutedAssignment[] } {
  const g = buildGraph(ctx);
  const at = (lat: number, lon: number): XZ => project(lat, lon);
  const fac = (id: string, kind: Facility['kind'], name: string, address: string, xz: XZ): Facility => ({ id, kind, name, address, lat: 0, lon: 0, x: xz[0], z: xz[1] });
  const facilities: Facility[] = [
    fac('SFFD-13', 'fire_station', 'SFFD Station 13', '530 Sansome St', at(37.7957, -122.4013)),
    fac('SFFD-2', 'fire_station', 'SFFD Station 2', '1340 Powell St', at(37.7974, -122.4106)),
    fac('SFFD-28', 'fire_station', 'SFFD Station 28', '1814 Stockton St', at(37.8013, -122.409)),
    fac('SFPD-CENTRAL', 'police_station', 'SFPD Central', '766 Vallejo St', at(37.7986, -122.4098)),
    fac('HOSP-CHINESE', 'hospital', 'Chinese Hospital', '845 Jackson St', at(37.7956, -122.4089)),
    fac('STAGE-EMB', 'staging', 'Staging · Embarcadero Plaza', 'Embarcadero Plaza', [203, -200]),
    fac('HELI-P17', 'helipad', 'Helipad · Pier 17', 'Pier 17', at(37.803, -122.3985)),
  ];

  // Incidents: big occupied buildings in the core, ≥ 220 m apart.
  const cands = ctx.city.buildings
    .filter((b) => !b.isPart && !b.context && b.address && ['chinatown', 'fidi', 'jackson_square', 'north_beach'].includes(b.district))
    .sort((a, b) => b.occupantsDay - a.occupantsDay);
  const picked: typeof cands = [];
  for (const b of cands) {
    const c = centroid(b.footprint);
    if (picked.every((p) => Math.hypot(centroid(p.footprint)[0] - c[0], centroid(p.footprint)[1] - c[1]) > 220)) picked.push(b);
    if (picked.length >= 7) break;
  }
  const kinds: [RescueIncident['kind'], boolean, Partial<RescueIncident>][] = [
    ['trapped', true, { peopleSeen: 6, trappedSigns: true, damage: 'collapsed', confidence: 0.86 }],
    ['fire', true, { fire: true, peopleSeen: 3, damage: 'extensive', confidence: 0.8 }],
    ['collapse', true, { peopleSeen: 2, damage: 'collapsed', confidence: 0.74 }],
    ['crowd', true, { crowdSize: 140, confidence: 0.7 }],
    ['suspected_collapse', false, { pDestroyed: 0.64, confidence: 0.4 }],
    ['suspected_collapse', false, { pDestroyed: 0.41, confidence: 0.3 }],
    ['trapped', true, { peopleSeen: 2, trappedSigns: true, damage: 'extensive', confidence: 0.6 }],
  ];
  const incidents: RescueIncident[] = picked.map((b, i) => {
    const c = centroid(b.footprint);
    const [kind, verified, extra] = kinds[i % kinds.length];
    return { id: `I-${b.id}`, kind, buildingId: b.id, label: `${b.address} (${b.id})`, x: c[0], z: c[1], verified, confidence: 0.5, occupants: b.occupantsDay, ...extra };
  });
  const I = (k: number) => incidents[Math.min(k, incidents.length - 1)].id;

  const assignments: RescuePlan['assignments'] = [
    { unitType: 'engine', count: 3, fromFacilityId: 'SFFD-13', incidentId: I(0), task: 'Extrication + suppression' },
    { unitType: 'usar', count: 1, fromFacilityId: 'STAGE-EMB', incidentId: I(0), task: 'Heavy rescue' },
    { unitType: 'ambulance', count: 2, fromFacilityId: 'HOSP-CHINESE', incidentId: I(0), task: 'Triage + transport' },
    { unitType: 'engine', count: 2, fromFacilityId: 'SFFD-2', incidentId: I(1), task: 'Fire attack' },
    { unitType: 'truck', count: 1, fromFacilityId: 'SFFD-28', incidentId: I(1), task: 'Ladder / search' },
    { unitType: 'police', count: 4, fromFacilityId: 'SFPD-CENTRAL', incidentId: I(3), task: 'Crowd control' },
    { unitType: 'helicopter', count: 1, fromFacilityId: 'HELI-P17', incidentId: I(2), task: 'Rooftop rescue / overwatch' },
    { unitType: 'ambulance', count: 1, fromFacilityId: 'HOSP-CHINESE', incidentId: I(2), task: 'Transport' },
    { unitType: 'engine', count: 1, fromFacilityId: 'SFFD-28', incidentId: I(4), task: 'Recon of suspected collapse' },
    { unitType: 'police', count: 2, fromFacilityId: 'SFPD-CENTRAL', incidentId: I(1), task: 'Perimeter' },
  ];
  const plan: RescuePlan = {
    priorities: [0, 1, 2, 3, 4].map((k, r) => ({ rank: r + 1, incidentId: I(k), reason: 'demo' })),
    assignments,
    routeClearing: [],
    reassessInMinutes: 10,
  };

  // Blocked segments: a few drivable segments near the middle of some routes (not on them).
  const facById = new Map(facilities.map((f) => [f.id, f]));
  const incById = new Map(incidents.map((i) => [i.id, i]));
  const roads: RoadStatus[] = [];
  const blocked = new Set<string>();
  const routeCache = new Map<string, RouteResult>();
  const route = (a: Facility, inc: RescueIncident, type: UnitType): RouteResult => {
    const ck = `${a.id}|${inc.id}|${type}`;
    const hit = routeCache.get(ck);
    if (hit) return hit;
    let r: RouteResult;
    if (type === 'helicopter') {
      const L = Math.hypot(inc.x - a.x, inc.z - a.z);
      r = {
        mode: 'air',
        reachable: true,
        points: [
          [a.x, groundAt(ctx.terrain, a.x, a.z), a.z],
          [inc.x, groundAt(ctx.terrain, inc.x, inc.z), inc.z],
        ],
        lengthM: L,
        etaMin: 1 + L / 60 / 60,
        avoidedBlocked: 0,
        passesLikelyBlocked: false,
        via: [],
      };
    } else {
      const path = dijkstra(g, nearest(g, a.x, a.z), nearest(g, inc.x, inc.z), blocked) ?? [];
      const pts: [number, number, number][] = path.map((i) => [g.xs[i], groundAt(ctx.terrain, g.xs[i], g.zs[i]), g.zs[i]]);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
      r = { mode: 'road', reachable: pts.length > 1, points: pts, lengthM: L, etaMin: 0.8 + L / 8 / 60, avoidedBlocked: 0, passesLikelyBlocked: false, via: [] };
    }
    routeCache.set(ck, r);
    return r;
  };
  // Mark blocked: one segment adjacent to the 50 % point of the first few routes.
  for (const a of assignments.slice(0, 6)) {
    if (a.unitType === 'helicopter') continue;
    const r = route(facById.get(a.fromFacilityId)!, incById.get(a.incidentId)!, a.unitType);
    if (r.points.length < 4) continue;
    const mid = r.points[Math.floor(r.points.length * 0.55)];
    let best: { road: number; seg: number; d: number } | null = null;
    ctx.city.roads.forEach((rd, ri) => {
      if (!DRIVABLE.has(rd.kind)) return;
      for (let s = 0; s < rd.points.length - 1; s++) {
        const mx = (rd.points[s][0] + rd.points[s + 1][0]) / 2;
        const mz = (rd.points[s][1] + rd.points[s + 1][1]) / 2;
        const d = Math.hypot(mx - mid[0], mz - mid[2]);
        if (d > 25 && d < 70 && (!best || d < best.d)) best = { road: ri, seg: s, d };
      }
    });
    if (best) {
      const b = best as { road: number; seg: number };
      const rd = ctx.city.roads[b.road];
      roads.push({ roadId: rd.id, segment: b.seg, name: rd.name, status: 'verified_blocked', source: 'argon' });
      blocked.add(`${b.road}:${b.seg}`);
    }
  }

  const routed: RoutedAssignment[] = [];
  assignments.forEach((a, ai) => {
    const r = route(facById.get(a.fromFacilityId)!, incById.get(a.incidentId)!, a.unitType);
    for (let k = 0; k < a.count; k++) routed.push({ key: `a${ai}-${k}`, unitType: a.unitType, fromFacilityId: a.fromFacilityId, incidentId: a.incidentId, task: a.task, route: r });
  });

  const situation: CopilotSituation = {
    scenarioId: 'san_andreas_1906',
    simS: 760,
    localTime: '15:12 PDT',
    minutesSinceQuake: 12,
    summary: { buildingsAssessed: 0, collapsesVerified: 0, peopleSeen: 0, trappedSitesVerified: 0, fires: 0, crowds: 0, areaScannedPct: 0, latestArgonSummary: '' },
    incidents,
    roads,
    facilities,
    travelTimes: [],
  };
  return { plan, situation, routed };
}

function centroid(pts: XZ[]): XZ {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    z += p[1];
  }
  return [x / pts.length, z / pts.length];
}
