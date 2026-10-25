/**
 * M5 road router — emergency-vehicle routing on the real street graph (city.roads), plus straight air legs.
 *
 * Graph: vehicle roads only (motorway…living_street, service; no footway/steps/cycleway/rail/cable car/pedestrian,
 * no tunnels — closed after a major quake). Every polyline vertex is a node; coincident vertices merge (≤ 0.35 m
 * always, ≤ 1.5 m on the same layer) and dangling ends are snapped onto a nearby segment (≤ 4 m, same layer,
 * splitting it) so intersections connect. Only the largest connected component is routable (isolated pier
 * aisles / parking loops are dropped from snapping).
 * Cost = length / speed(kind); emergency vehicles may drive against a one-way at a 30 % penalty.
 * Road status: verified_blocked = impassable, likely_blocked = ×6 time, partial = ×2 time.
 * Road ETA = drive time + 1 min turnout. Air (helicopter) = straight arc at ~150 m AGL, 220 km/h, + 3 min spin-up.
 */
import type {
  CityData,
  Facility,
  Heightfield,
  RescueIncident,
  RoadKind,
  RoadStatus,
  RouteResult,
  RouterHandle,
  TravelTime,
  UnitType,
  XZ,
} from '../contracts';

export const ROAD_SPEED_KMH: Partial<Record<RoadKind, number>> = {
  motorway: 55,
  primary: 40,
  secondary: 35,
  tertiary: 30,
  residential: 25,
  living_street: 12,
  service: 15,
};
const WRONG_WAY = 1.3;
const LIKELY_FACTOR = 6;
const PARTIAL_FACTOR = 2;
export const TURNOUT_MIN = 1;
export const AIR_KMH = 220;
export const AIR_SPINUP_MIN = 3;
export const AIR_AGL_M = 150;
const MERGE_EXACT = 0.35;
const MERGE_LAYER = 1.5;
const SNAP_END = 4;
const SAMPLE_M = 8;
const Y_OFF = 1.2;
const MIN_GROUND = 1.5; // pier decks / fill: never draw below this elevation
const CONNECT_KMH = 10; // facility/incident ↔ kerb connector legs
const FOOT_KMH = 4;
const FOOT_MAX_M = 300;
const CELL = 30;

const ST_FREE = 0;
const ST_PARTIAL = 1;
const ST_LIKELY = 2;
const ST_BLOCKED = 3;

class MinHeap {
  k: number[] = [];
  v: number[] = [];
  get size() {
    return this.k.length;
  }
  clear() {
    this.k.length = 0;
    this.v.length = 0;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  /** Pops the min; returns its value, key in this.lastKey. */
  lastKey = 0;
  pop(): number {
    const k = this.k;
    const v = this.v;
    const topK = k[0];
    const topV = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    this.lastKey = topK;
    return topV;
  }
}

interface Snap {
  edge: number;
  t: number; // 0 at node a, 1 at node b
  x: number;
  z: number;
  d: number; // distance from the query point to the kerb point
}

interface Search {
  dist: Float64Array;
  prevEdge: Int32Array; // edge used to reach node (-1 = seed)
  prevNode: Int32Array;
  lb: Uint8Array; // path passes a likely-blocked edge
}

export interface RouterDebug {
  nodes: number;
  edges: number;
  mainEdges: number;
  buildMs: number;
  /** Edge index → [roadId, segment] (debug / tests). */
  edgeRoad(e: number): [string, number];
}

export function createRouter(city: CityData, terrain: Heightfield): RouterHandle & { debug: RouterDebug } {
  const t0 = performance.now();
  const roads = city.roads;

  // ── Nodes (merged vertices) ──
  const nx: number[] = [];
  const nz: number[] = [];
  const nl: number[] = []; // layer
  const nodeGrid = new Map<number, number[]>();
  const gkey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  const NCELL = 2;
  function nodeAt(x: number, z: number, layer: number): number {
    const cx = Math.floor(x / NCELL);
    const cz = Math.floor(z / NCELL);
    let best = -1;
    let bd = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const list = nodeGrid.get(gkey(cx + dx, cz + dz));
        if (!list) continue;
        for (const n of list) {
          const d = Math.hypot(nx[n] - x, nz[n] - z);
          if (d < bd && (d <= MERGE_EXACT || (d <= MERGE_LAYER && nl[n] === layer))) {
            bd = d;
            best = n;
          }
        }
      }
    if (best >= 0) return best;
    const id = nx.length;
    nx.push(x);
    nz.push(z);
    nl.push(layer);
    const k = gkey(cx, cz);
    const l = nodeGrid.get(k);
    if (l) l.push(id);
    else nodeGrid.set(k, [id]);
    return id;
  }

  // ── Raw segments ──
  interface Seg {
    a: number;
    b: number;
    road: number;
    seg: number;
  }
  const segs: Seg[] = [];
  const roadLayer: number[] = [];
  roads.forEach((r, ri) => {
    const sp = ROAD_SPEED_KMH[r.kind];
    const layer = r.layer ?? (r.bridge ? 1 : 0);
    roadLayer[ri] = layer;
    if (!sp || r.tunnel || r.points.length < 2) return;
    let prev = nodeAt(r.points[0][0], r.points[0][1], layer);
    for (let i = 1; i < r.points.length; i++) {
      const n = nodeAt(r.points[i][0], r.points[i][1], layer);
      if (n !== prev) segs.push({ a: prev, b: n, road: ri, seg: i - 1 });
      prev = n;
    }
  });

  // ── Snap dangling ends onto nearby segments (T-junctions whose node was not shared) ──
  {
    const deg = new Int32Array(nx.length);
    for (const s of segs) {
      deg[s.a]++;
      deg[s.b]++;
    }
    const sg = new Map<number, number[]>();
    const SC = 20;
    segs.forEach((s, i) => {
      const x0 = Math.floor((Math.min(nx[s.a], nx[s.b]) - SNAP_END) / SC);
      const x1 = Math.floor((Math.max(nx[s.a], nx[s.b]) + SNAP_END) / SC);
      const z0 = Math.floor((Math.min(nz[s.a], nz[s.b]) - SNAP_END) / SC);
      const z1 = Math.floor((Math.max(nz[s.a], nz[s.b]) + SNAP_END) / SC);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = gkey(cx, cz);
          const l = sg.get(k);
          if (l) l.push(i);
          else sg.set(k, [i]);
        }
    });
    const splits = new Map<number, { t: number; n: number }[]>();
    const extra: Seg[] = [];
    for (let n = 0; n < nx.length; n++) {
      if (deg[n] !== 1) continue;
      const px = nx[n];
      const pz = nz[n];
      const list = sg.get(gkey(Math.floor(px / SC), Math.floor(pz / SC)));
      if (!list) continue;
      let best = -1;
      let bd = SNAP_END;
      let bt = 0;
      for (const i of list) {
        const s = segs[i];
        if (s.a === n || s.b === n || nl[s.a] !== nl[n]) continue;
        const ax = nx[s.a];
        const az = nz[s.a];
        const dx = nx[s.b] - ax;
        const dz = nz[s.b] - az;
        const L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        const d = Math.hypot(ax + dx * t - px, az + dz * t - pz);
        if (d < bd) {
          bd = d;
          best = i;
          bt = t;
        }
      }
      if (best < 0) continue;
      const s = segs[best];
      const L = Math.hypot(nx[s.b] - nx[s.a], nz[s.b] - nz[s.a]);
      if (bt * L < MERGE_LAYER) extra.push({ a: n, b: s.a, road: s.road, seg: s.seg });
      else if ((1 - bt) * L < MERGE_LAYER) extra.push({ a: n, b: s.b, road: s.road, seg: s.seg });
      else {
        const l = splits.get(best);
        if (l) l.push({ t: bt, n });
        else splits.set(best, [{ t: bt, n }]);
      }
    }
    for (const [i, list] of splits) {
      const s = segs[i];
      list.sort((p, q) => p.t - q.t);
      let prev = s.a;
      const chain: Seg[] = [];
      for (const { n } of list) {
        if (n !== prev) chain.push({ a: prev, b: n, road: s.road, seg: s.seg });
        prev = n;
      }
      chain.push({ a: prev, b: s.b, road: s.road, seg: s.seg });
      segs[i] = chain[0];
      for (let k = 1; k < chain.length; k++) segs.push(chain[k]);
    }
    for (const e of extra) segs.push(e);
  }

  // ── Edges + CSR adjacency ──
  const N = nx.length;
  const E = segs.length;
  const ea = new Int32Array(E);
  const eb = new Int32Array(E);
  const elen = new Float64Array(E);
  const etime = new Float64Array(E); // seconds at free flow (forward)
  const eroad = new Int32Array(E);
  const eseg = new Int32Array(E);
  const eone = new Uint8Array(E);
  const est = new Uint8Array(E);
  for (let i = 0; i < E; i++) {
    const s = segs[i];
    const r = roads[s.road];
    ea[i] = s.a;
    eb[i] = s.b;
    eroad[i] = s.road;
    eseg[i] = s.seg;
    eone[i] = r.oneway ? 1 : 0;
    const L = Math.max(0.1, Math.hypot(nx[s.b] - nx[s.a], nz[s.b] - nz[s.a]));
    elen[i] = L;
    etime[i] = L / ((ROAD_SPEED_KMH[r.kind] ?? 15) / 3.6);
  }
  const adjStart = new Int32Array(N + 1);
  for (let i = 0; i < E; i++) {
    adjStart[ea[i] + 1]++;
    adjStart[eb[i] + 1]++;
  }
  for (let n = 0; n < N; n++) adjStart[n + 1] += adjStart[n];
  const adj = new Int32Array(2 * E); // edge*2 + dir (0: a→b, 1: b→a)
  {
    const fill = adjStart.slice(0, N);
    for (let i = 0; i < E; i++) {
      adj[fill[ea[i]]++] = i * 2;
      adj[fill[eb[i]]++] = i * 2 + 1;
    }
  }

  // ── Largest connected component (undirected) ──
  const comp = new Int32Array(N).fill(-1);
  let mainComp = -1;
  {
    let best = 0;
    let c = 0;
    const stack: number[] = [];
    for (let s = 0; s < N; s++) {
      if (comp[s] >= 0) continue;
      let size = 0;
      comp[s] = c;
      stack.push(s);
      while (stack.length) {
        const n = stack.pop()!;
        size++;
        for (let k = adjStart[n]; k < adjStart[n + 1]; k++) {
          const e = adj[k] >> 1;
          const m = ea[e] === n ? eb[e] : ea[e];
          if (comp[m] < 0) {
            comp[m] = c;
            stack.push(m);
          }
        }
      }
      if (size > best) {
        best = size;
        mainComp = c;
      }
      c++;
    }
  }

  // ── Edge spatial index (main component only) ──
  const egrid = new Map<number, number[]>();
  let mainEdges = 0;
  for (let i = 0; i < E; i++) {
    if (comp[ea[i]] !== mainComp) continue;
    mainEdges++;
    const x0 = Math.floor(Math.min(nx[ea[i]], nx[eb[i]]) / CELL);
    const x1 = Math.floor(Math.max(nx[ea[i]], nx[eb[i]]) / CELL);
    const z0 = Math.floor(Math.min(nz[ea[i]], nz[eb[i]]) / CELL);
    const z1 = Math.floor(Math.max(nz[ea[i]], nz[eb[i]]) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = gkey(cx, cz);
        const l = egrid.get(k);
        if (l) l.push(i);
        else egrid.set(k, [i]);
      }
  }

  // Road segment key → edges (for setRoadStatus).
  const segEdges = new Map<string, number[]>();
  for (let i = 0; i < E; i++) {
    const k = `${roads[eroad[i]].id}:${eseg[i]}`;
    const l = segEdges.get(k);
    if (l) l.push(i);
    else segEdges.set(k, [i]);
  }

  function snap(x: number, z: number, passable: boolean): Snap | null {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: Snap | null = null;
    const seen = new Set<number>();
    for (let ring = 0; ring <= 40; ring++) {
      if (best && (ring - 1) * CELL > best.d) break;
      for (let dx = -ring; dx <= ring; dx++)
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const list = egrid.get(gkey(cx + dx, cz + dz));
          if (!list) continue;
          for (const e of list) {
            if (seen.has(e)) continue;
            seen.add(e);
            if (passable && est[e] === ST_BLOCKED) continue;
            const ax = nx[ea[e]];
            const az = nz[ea[e]];
            const ddx = nx[eb[e]] - ax;
            const ddz = nz[eb[e]] - az;
            const L2 = ddx * ddx + ddz * ddz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * ddx + (z - az) * ddz) / L2));
            const qx = ax + ddx * t;
            const qz = az + ddz * t;
            // Small bias against service aisles so incidents snap to the street they front.
            const d = Math.hypot(x - qx, z - qz) + (roads[eroad[e]].kind === 'service' ? 6 : 0);
            if (!best || d < best.d) best = { edge: e, t, x: qx, z: qz, d };
          }
        }
    }
    if (best) best.d = Math.hypot(x - best.x, z - best.z);
    return best;
  }

  /** Travel seconds over fraction `frac` of edge e in direction dir. */
  function cost(e: number, dir: number, useStatus: boolean, frac = 1): number {
    const s = useStatus ? est[e] : ST_FREE;
    if (s === ST_BLOCKED) return Infinity;
    let c = etime[e] * frac;
    if (eone[e] && dir === 1) c *= WRONG_WAY;
    if (s === ST_LIKELY) c *= LIKELY_FACTOR;
    else if (s === ST_PARTIAL) c *= PARTIAL_FACTOR;
    return c;
  }

  const bufs: Search = {
    dist: new Float64Array(N),
    prevEdge: new Int32Array(N),
    prevNode: new Int32Array(N),
    lb: new Uint8Array(N),
  };
  const heap = new MinHeap();

  interface TargetHit {
    cost: number;
    via: number; // node the target edge is entered from (-1 = same edge as source)
    lb: boolean;
  }

  /** Dijkstra from a source snap. With `target`, stops once the target is settled and returns the best hit. */
  function search(src: Snap, useStatus: boolean, target?: Snap): TargetHit | null {
    const { dist, prevEdge, prevNode, lb } = bufs;
    dist.fill(Infinity);
    prevEdge.fill(-1);
    prevNode.fill(-1);
    lb.fill(0);
    heap.clear();
    const se = src.edge;
    const srcLb = useStatus && est[se] === ST_LIKELY ? 1 : 0;
    const ca = cost(se, 1, useStatus, src.t);
    const cb = cost(se, 0, useStatus, 1 - src.t);
    const a = ea[se];
    const b = eb[se];
    if (ca < dist[a]) {
      dist[a] = ca;
      lb[a] = srcLb;
      heap.push(ca, a);
    }
    if (cb < dist[b]) {
      dist[b] = cb;
      lb[b] = srcLb;
      heap.push(cb, b);
    }
    let best: TargetHit | null = null;
    let ta = -1;
    let tb = -1;
    let cta = Infinity;
    let ctb = Infinity;
    if (target) {
      const te = target.edge;
      ta = ea[te];
      tb = eb[te];
      cta = cost(te, 0, useStatus, target.t);
      ctb = cost(te, 1, useStatus, 1 - target.t);
      const tLb = useStatus && est[te] === ST_LIKELY;
      if (te === se) {
        const dir = target.t >= src.t ? 0 : 1;
        const c = cost(se, dir, useStatus, Math.abs(target.t - src.t));
        if (c < Infinity) best = { cost: c, via: -1, lb: tLb };
      }
    }
    while (heap.size) {
      const n = heap.pop();
      const d = heap.lastKey;
      if (d > dist[n]) continue;
      if (best && d >= best.cost) break;
      if (target) {
        if (n === ta && d + cta < (best?.cost ?? Infinity)) best = { cost: d + cta, via: n, lb: !!lb[n] || (useStatus && est[target.edge] === ST_LIKELY) };
        if (n === tb && d + ctb < (best?.cost ?? Infinity)) best = { cost: d + ctb, via: n, lb: !!lb[n] || (useStatus && est[target.edge] === ST_LIKELY) };
      }
      for (let k = adjStart[n]; k < adjStart[n + 1]; k++) {
        const e = adj[k] >> 1;
        const dir = adj[k] & 1;
        const c = cost(e, dir, useStatus);
        if (c === Infinity) continue;
        const m = dir === 0 ? eb[e] : ea[e];
        const nd = d + c;
        if (nd < dist[m]) {
          dist[m] = nd;
          prevEdge[m] = e;
          prevNode[m] = n;
          lb[m] = lb[n] || (useStatus && est[e] === ST_LIKELY) ? 1 : 0;
          heap.push(nd, m);
        }
      }
    }
    return best;
  }

  /** Node chain + edges from the source seed to node n (uses the last search buffers). */
  function chainTo(n: number): { nodes: number[]; edges: number[] } {
    const nodes: number[] = [];
    const edges: number[] = [];
    let cur = n;
    let guard = 0;
    while (cur >= 0 && guard++ < N + 5) {
      nodes.push(cur);
      const e = bufs.prevEdge[cur];
      if (e < 0) break;
      edges.push(e);
      cur = bufs.prevNode[cur];
    }
    nodes.reverse();
    edges.reverse();
    return { nodes, edges };
  }

  const groundY = (x: number, z: number) => Math.max(terrain.heightAt(x, z), MIN_GROUND) + Y_OFF;

  function densify(xz: XZ[]): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let i = 0; i < xz.length; i++) {
      const [x, z] = xz[i];
      if (i > 0) {
        const [px, pz] = xz[i - 1];
        const L = Math.hypot(x - px, z - pz);
        if (L < 0.2) continue;
        const n = Math.floor(L / SAMPLE_M);
        for (let k = 1; k <= n; k++) {
          const f = k / (n + 1);
          const sx = px + (x - px) * f;
          const sz = pz + (z - pz) * f;
          out.push([sx, groundY(sx, sz), sz]);
        }
      }
      out.push([x, groundY(x, z), z]);
    }
    return out;
  }

  function viaNames(edges: number[]): string[] {
    const runs: { name: string; len: number }[] = [];
    for (const e of edges) {
      const name = roads[eroad[e]].name;
      if (!name) continue;
      const last = runs[runs.length - 1];
      if (last && last.name === name) last.len += elen[e];
      else runs.push({ name, len: elen[e] });
    }
    const out: string[] = [];
    runs.forEach((r, i) => {
      if ((r.len >= 30 || i === 0 || i === runs.length - 1) && !out.includes(r.name)) out.push(r.name);
    });
    return out;
  }

  function airRoute(from: XZ, to: XZ): RouteResult {
    const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const n = Math.max(12, Math.min(64, Math.ceil(L / 40)));
    const pts: [number, number, number][] = [];
    // Cruise altitude clears the highest ground along the leg.
    let maxG = 0;
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      maxG = Math.max(maxG, terrain.heightAt(from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f));
    }
    const g0 = groundY(from[0], from[1]);
    const g1 = groundY(to[0], to[1]);
    const cruise = maxG + AIR_AGL_M;
    const ramp = Math.min(0.35, 250 / Math.max(L, 1));
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      const x = from[0] + (to[0] - from[0]) * f;
      const z = from[1] + (to[1] - from[1]) * f;
      const up = Math.min(1, f / ramp);
      const down = Math.min(1, (1 - f) / ramp);
      const s = (u: number) => u * u * (3 - 2 * u);
      const ground = g0 + (g1 - g0) * f;
      const y = ground + (cruise - ground) * Math.min(s(up), s(down));
      pts.push([x, Math.max(y, groundY(x, z) + 2), z]);
    }
    return {
      mode: 'air',
      reachable: true,
      points: pts,
      lengthM: Math.round(L),
      etaMin: round1(airMinutes(L)),
      avoidedBlocked: 0,
      passesLikelyBlocked: false,
      via: ['direct flight'],
    };
  }

  function roadRoute(from: XZ, to: XZ): RouteResult {
    const s = snap(from[0], from[1], true);
    const t = snap(to[0], to[1], true);
    const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const fail: RouteResult = {
      mode: 'road',
      reachable: false,
      points: [
        [from[0], groundY(from[0], from[1]), from[1]],
        [to[0], groundY(to[0], to[1]), to[1]],
      ],
      lengthM: Math.round(straight),
      etaMin: 0,
      avoidedBlocked: 0,
      passesLikelyBlocked: false,
      via: [],
    };
    if (!s || !t) return fail;
    const hit = search(s, true, t);
    let nodes: number[] = [];
    let edges: number[] = [];
    let endXZ: XZ = [t.x, t.z];
    let driveS = 0;
    let footM = 0;
    let lbPass = false;
    if (hit) {
      driveS = hit.cost;
      lbPass = hit.lb;
      if (hit.via >= 0) {
        ({ nodes, edges } = chainTo(hit.via));
        edges.push(t.edge);
      } else edges.push(t.edge);
    } else {
      // Target cut off by verified blockages: drive to the closest reachable node, last stretch on foot.
      let bn = -1;
      let bd = FOOT_MAX_M;
      for (let n = 0; n < N; n++) {
        if (bufs.dist[n] === Infinity) continue;
        const d = Math.hypot(nx[n] - to[0], nz[n] - to[1]);
        if (d < bd) {
          bd = d;
          bn = n;
        }
      }
      if (bn < 0) return fail;
      driveS = bufs.dist[bn];
      lbPass = !!bufs.lb[bn];
      ({ nodes, edges } = chainTo(bn));
      endXZ = [nx[bn], nz[bn]];
      footM = bd;
    }
    const xz: XZ[] = [];
    if (s.d > 3) xz.push([from[0], from[1]]);
    xz.push([s.x, s.z]);
    for (const n of nodes) xz.push([nx[n], nz[n]]);
    xz.push(endXZ);
    if (footM > 0 || t.d > 3) xz.push([to[0], to[1]]);
    const points = densify(xz);
    let lengthM = 0;
    for (let i = 1; i < points.length; i++) lengthM += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
    const connectS = ((s.d + (footM > 0 ? 0 : t.d)) / CONNECT_KMH) * 3.6;
    const footS = (footM / FOOT_KMH) * 3.6;

    // Blocked segments the free-flow shortest path would have used (= what this route avoids).
    let avoided = 0;
    if (anyBlocked) {
      const free = search(s, false, t);
      if (free) {
        const fe = free.via >= 0 ? chainTo(free.via).edges : [];
        fe.push(t.edge);
        const keys = new Set<string>();
        for (const e of fe) if (est[e] === ST_BLOCKED) keys.add(`${eroad[e]}:${eseg[e]}`);
        avoided = keys.size;
      }
    }
    const via = viaNames([s.edge, ...edges]);
    if (footM > 0) via.push(`last ${Math.round(footM)} m on foot`);
    return {
      mode: 'road',
      reachable: true,
      points,
      lengthM: Math.round(lengthM),
      etaMin: round1((driveS + connectS + footS) / 60 + TURNOUT_MIN),
      avoidedBlocked: avoided,
      passesLikelyBlocked: lbPass,
      via,
    };
  }

  let anyBlocked = false;

  /** Main-component nodes within FOOT_MAX_M of a point, with distances. */
  function nearNodes(x: number, z: number): [number, number][] {
    const out: [number, number][] = [];
    for (let n = 0; n < N; n++) {
      if (comp[n] !== mainComp) continue;
      const d = Math.hypot(nx[n] - x, nz[n] - z);
      if (d < FOOT_MAX_M) out.push([n, d]);
    }
    return out;
  }

  const handle: RouterHandle & { debug: RouterDebug } = {
    setRoadStatus(list: RoadStatus[]) {
      est.fill(ST_FREE);
      anyBlocked = false;
      for (const r of list) {
        const es = segEdges.get(`${r.roadId}:${r.segment}`);
        if (!es) continue;
        const st = r.status === 'verified_blocked' ? ST_BLOCKED : r.status === 'likely_blocked' ? ST_LIKELY : ST_PARTIAL;
        for (const e of es) if (st > est[e]) est[e] = st;
        if (st === ST_BLOCKED) anyBlocked = true;
      }
    },
    route(from: XZ, to: XZ, opts?: { unitType?: UnitType }): RouteResult {
      return opts?.unitType === 'helicopter' ? airRoute(from, to) : roadRoute(from, to);
    },
    travelTimes(facilities: Facility[], incidents: RescueIncident[]): TravelTime[] {
      const out: TravelTime[] = [];
      const tsnaps = incidents.map((i) => snap(i.x, i.z, true));
      const nearCache: [number, number][][] = [];
      for (const f of facilities) {
        const s = snap(f.x, f.z, true);
        if (s) search(s, true);
        const { dist, lb } = bufs;
        incidents.forEach((inc, k) => {
          const air = round1(airMinutes(Math.hypot(inc.x - f.x, inc.z - f.z)));
          const t = tsnaps[k];
          let road: number | null = null;
          let lbp = false;
          if (s && t) {
            const te = t.edge;
            const tLb = est[te] === ST_LIKELY;
            let best = Infinity;
            const ca = dist[ea[te]] + cost(te, 0, true, t.t);
            const cb = dist[eb[te]] + cost(te, 1, true, 1 - t.t);
            if (ca < best) {
              best = ca;
              lbp = !!lb[ea[te]] || tLb;
            }
            if (cb < best) {
              best = cb;
              lbp = !!lb[eb[te]] || tLb;
            }
            if (te === s.edge) {
              const c = cost(te, t.t >= s.t ? 0 : 1, true, Math.abs(t.t - s.t));
              if (c < best) {
                best = c;
                lbp = tLb;
              }
            }
            if (best < Infinity) road = round1((best + ((s.d + t.d) / CONNECT_KMH) * 3.6) / 60 + TURNOUT_MIN);
            else {
              // Cut off by verified blockages: closest reachable node within FOOT_MAX_M, rest on foot (as route()).
              const nearList = (nearCache[k] ??= nearNodes(inc.x, inc.z));
              let bn = -1;
              let bd = Infinity;
              for (const [n, d] of nearList) {
                if (dist[n] < Infinity && d < bd) {
                  bd = d;
                  bn = n;
                }
              }
              if (bn >= 0) {
                road = round1((dist[bn] + (s.d / CONNECT_KMH + bd / FOOT_KMH) * 3.6) / 60 + TURNOUT_MIN);
                lbp = !!lb[bn];
              }
            }
          }
          out.push({ fromFacilityId: f.id, incidentId: inc.id, roadMin: road, airMin: air, passesLikelyBlocked: road !== null && lbp });
        });
      }
      return out;
    },
    debug: {
      nodes: N,
      edges: E,
      mainEdges,
      buildMs: 0,
      edgeRoad: (e: number) => [roads[eroad[e]].id, eseg[e]],
    },
  };
  handle.debug.buildMs = Math.round(performance.now() - t0);
  void roadLayer;
  return handle;
}

export function airMinutes(distanceM: number): number {
  return distanceM / ((AIR_KMH * 1000) / 60) + AIR_SPINUP_MIN;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
