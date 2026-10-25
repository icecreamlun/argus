/**
 * M5 rescue layer: draws a RescuePlan in 3D.
 *   - road routes: glowing ribbons draped along streets, flowing chevrons facility → incident, colour by unit
 *     type, side-by-side lanes per type, units sharing a route drawn once with a count badge;
 *   - air routes: high dotted arcs with a ground shadow;
 *   - incidents: pulsing P1/P2/P3 rings (dashed = unverified, model-only) + light beams + label chips;
 *   - used facilities: icon chips + ground pads; verified-blocked segments near the routes: red X marks;
 *   - dispatch(): unit tokens drive / fly along their routes on a visual clock (clamp(etaMin·4, 8, 40) s),
 *     ETA badges count down, units park at the incident with a soft beacon.
 * Draw calls: ribbons 1, arcs 1, ground markers 1, beams 1, vehicles 1, helicopters 2, glows 1.
 * Everything is on RESCUE_LAYER (main camera only).
 */
import * as THREE from 'three';
import type { AppContext, CopilotSituation, Facility, RescueIncident, RescueLayerHandle, RescuePlan, RoutedAssignment, UnitType } from '../../contracts';
import {
  airArc,
  drapeRoad,
  groundAt,
  makePolyline,
  pxPerMetre,
  RESCUE_LAYER,
  sampleAt,
  UNIT_COLOR,
  UNIT_HEX,
  UNIT_LANE,
  UNIT_SHORT,
  UNIT_SIZE,
  PRIORITY_COLOR,
  PRIORITY_HEX,
  type Polyline,
} from './common';
import { buildArcGeometry, buildRibbonGeometry, createArcMaterial, createRibbonMaterial, MAX_INC, sharedUniforms, type RibbonInput } from './ribbons';
import { createMarkers, STYLE_PAD, STYLE_RING, STYLE_RING_DASHED, STYLE_X, type Beam, type GroundMarker } from './markers';
import { createUnits, type UnitSpec } from './units';
import { createLabels, el, FACILITY_HEX, FACILITY_ICON, type LabelSpec } from './labels';

const LIFT = 1.5;

interface Group {
  idx: number;
  key: string;
  unitType: UnitType;
  mode: 'road' | 'air';
  fromFacilityId: string;
  incidentId: string;
  incIdx: number;
  members: RoutedAssignment[];
  line: Polyline;
  etaMin: number;
  assignmentIdx: number;
  badgeKey: string;
  badgeEl?: HTMLElement;
  lastText?: string;
}

function assignmentIndex(key: string, fallback: number): number {
  const m = /^a(\d+)/.exec(key);
  return m ? Number(m[1]) : fallback;
}

function cleanLabel(s: string): string {
  return s.replace(/\s*\(B\d+\)\s*$/, '').trim();
}

function incidentMain(inc: RescueIncident): string {
  switch (inc.kind) {
    case 'trapped':
      return inc.peopleSeen ? `${inc.peopleSeen} trapped` : 'Trapped signs';
    case 'fire':
      return inc.peopleSeen ? `Fire · ${inc.peopleSeen} seen` : 'Fire';
    case 'collapse':
      return inc.peopleSeen ? `Collapse · ${inc.peopleSeen} seen` : 'Collapse';
    case 'suspected_collapse':
      return 'Suspected collapse';
    case 'crowd':
      return inc.crowdSize ? `Crowd ~${inc.crowdSize}` : 'Crowd';
  }
  return inc.kind;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function createRescueLayer(ctx: AppContext): RescueLayerHandle {
  const object = new THREE.Group();
  object.name = 'rescue-layer';
  object.visible = false;
  ctx.camera.layers.enable(RESCUE_LAYER);

  const u = sharedUniforms();
  const ribbonMat = createRibbonMaterial(u);
  const ribbonXrayMat = createRibbonMaterial(u, true);
  const arcMat = createArcMaterial(u);
  let ribbons: THREE.Mesh | null = null;
  let ribbonsX: THREE.Mesh | null = null;
  let arcs: THREE.Points | null = null;
  const markers = createMarkers(u);
  object.add(markers.object);
  const units = createUnits(u);
  object.add(units.object);
  const labels = createLabels(ctx);

  let groups: Group[] = [];
  let incIndex = new Map<string, number>();
  let active = false;
  let highlightIdx = -1;
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;

  function setLayer() {
    object.traverse((o) => o.layers.set(RESCUE_LAYER));
  }

  function applyHighlight() {
    const w = u.uIncW.value;
    for (let i = 0; i < MAX_INC; i++) w[i] = highlightIdx < 0 ? 1 : i === highlightIdx ? 1.45 : 0.2;
    labels.setHighlight(highlightIdx);
  }

  function disposeRoutes() {
    if (ribbons) {
      object.remove(ribbons);
      ribbons.geometry.dispose();
      ribbons = null;
    }
    if (ribbonsX) {
      object.remove(ribbonsX);
      ribbonsX = null;
    }
    if (arcs) {
      object.remove(arcs);
      arcs.geometry.dispose();
      arcs = null;
    }
  }

  function clear() {
    disposeRoutes();
    markers.clear();
    units.clear();
    labels.clear();
    groups = [];
    incIndex = new Map();
    active = false;
    highlightIdx = -1;
    applyHighlight();
    object.visible = false;
    u.uDispatched.value = 0;
  }

  function show(plan: RescuePlan, situation: CopilotSituation, routed: RoutedAssignment[]) {
    clear();
    const terrain = ctx.terrain;
    const incById = new Map(situation.incidents.map((i) => [i.id, i]));
    const facById = new Map(situation.facilities.map((f) => [f.id, f]));
    const rank = new Map<string, number>();
    for (const p of [...plan.priorities].sort((a, b) => a.rank - b.rank)) if (!rank.has(p.incidentId)) rank.set(p.incidentId, p.rank);

    // Incidents shown: ranked first, then any other assignment target.
    const shownInc: RescueIncident[] = [];
    const addInc = (id: string) => {
      const inc = incById.get(id);
      if (!inc || incIndex.has(id) || shownInc.length >= MAX_INC) return;
      incIndex.set(id, shownInc.length);
      shownInc.push(inc);
    };
    [...rank.entries()].sort((a, b) => a[1] - b[1]).forEach(([id]) => addInc(id));
    for (const r of routed) addInc(r.incidentId);

    // ── Groups: same facility → incident, mode and unit type share one drawn route. ──
    const gmap = new Map<string, Group>();
    routed.forEach((r, i) => {
      if (!r.route || r.route.points.length < 2) return;
      const mode = r.route.mode;
      const key = `${r.fromFacilityId}|${r.incidentId}|${mode}|${r.unitType}`;
      let g = gmap.get(key);
      if (!g) {
        const pts = mode === 'air' ? airArc(terrain, r.route.points) : drapeRoad(terrain, r.route.points, LIFT);
        g = {
          idx: gmap.size,
          key,
          unitType: r.unitType,
          mode,
          fromFacilityId: r.fromFacilityId,
          incidentId: r.incidentId,
          incIdx: incIndex.get(r.incidentId) ?? 0,
          members: [],
          line: makePolyline(pts),
          etaMin: r.route.etaMin,
          assignmentIdx: assignmentIndex(r.key, i),
          badgeKey: `badge:${key}`,
        };
        gmap.set(key, g);
      }
      g.members.push(r);
    });
    groups = [...gmap.values()];
    if (!groups.length && !shownInc.length) return;

    // ── Route geometry ──
    const ribbonIn: RibbonInput[] = [];
    const arcIn: Parameters<typeof buildArcGeometry>[0] = [];
    for (const g of groups) {
      const color = UNIT_COLOR[g.unitType];
      if (g.mode === 'road') ribbonIn.push({ line: g.line, color, lane: UNIT_LANE[g.unitType], incIdx: g.incIdx, order: g.idx });
      else {
        const ground: number[] = [];
        for (let i = 0; i < g.line.n; i++) ground.push(groundAt(terrain, g.line.p[i * 3], g.line.p[i * 3 + 2]) + 1.2);
        arcIn.push({ line: g.line, ground, color, incIdx: g.incIdx, order: g.idx });
      }
    }
    if (ribbonIn.length) {
      ribbons = new THREE.Mesh(buildRibbonGeometry(ribbonIn), ribbonMat);
      ribbons.frustumCulled = false;
      ribbons.renderOrder = 5;
      object.add(ribbons);
      ribbonsX = new THREE.Mesh(ribbons.geometry, ribbonXrayMat);
      ribbonsX.frustumCulled = false;
      ribbonsX.renderOrder = 2;
      object.add(ribbonsX);
    }
    if (arcIn.length) {
      arcs = new THREE.Points(buildArcGeometry(arcIn), arcMat);
      arcs.frustumCulled = false;
      arcs.renderOrder = 7;
      object.add(arcs);
    }

    // ── Markers ──
    const ground: GroundMarker[] = [];
    const beams: Beam[] = [];
    const nrm = (x: number, z: number) => terrain.normalAt(x, z, new THREE.Vector3());
    shownInc.forEach((inc, i) => {
      const r = rank.get(inc.id);
      const pi = r === undefined ? 3 : Math.min(2, Math.max(0, r - 1));
      const color = PRIORITY_COLOR[pi];
      const y = groundAt(terrain, inc.x, inc.z) + 1.2;
      const radius = [46, 36, 28, 22][pi];
      ground.push({
        x: inc.x,
        y,
        z: inc.z,
        normal: nrm(inc.x, inc.z),
        radius,
        minPx: [17, 13, 10, 8][pi],
        style: inc.verified ? STYLE_RING : STYLE_RING_DASHED,
        color,
        intensity: [1.25, 1.0, 0.85, 0.65][pi],
        incIdx: i,
        speed: [1.4, 1.0, 0.75, 0.6][pi],
      });
      if (r !== undefined && pi < 3)
        beams.push({ x: inc.x, y: y - 1, z: inc.z, radius: [2.6, 2.0, 1.6][pi], height: [150, 110, 80][pi], color, intensity: [1.0, 0.75, 0.55][pi] * (inc.verified ? 1 : 0.6), incIdx: i });
    });

    const usedFac = new Map<string, { f: Facility; incs: Set<number>; types: Set<UnitType> }>();
    for (const g of groups) {
      const f = facById.get(g.fromFacilityId);
      if (!f) continue;
      let e = usedFac.get(f.id);
      if (!e) usedFac.set(f.id, (e = { f, incs: new Set(), types: new Set() }));
      e.incs.add(g.incIdx);
      e.types.add(g.unitType);
    }
    for (const { f } of usedFac.values()) {
      ground.push({
        x: f.x,
        y: groundAt(terrain, f.x, f.z) + 1.2,
        z: f.z,
        normal: nrm(f.x, f.z),
        radius: 14,
        minPx: 7,
        style: STYLE_PAD,
        color: new THREE.Color(FACILITY_HEX[f.kind]).lerp(new THREE.Color(1, 1, 1), 0.25),
        intensity: 1,
        incIdx: -1,
      });
    }

    // Verified-blocked segments near the drawn road routes.
    const roadById = new Map(ctx.city.roads.map((r) => [r.id, r]));
    const nearRoute = (x: number, z: number, maxD: number) => {
      for (const g of groups) {
        if (g.mode !== 'road') continue;
        const p = g.line.p;
        for (let i = 0; i < g.line.n; i += 3) if (Math.hypot(p[i * 3] - x, p[i * 3 + 2] - z) < maxD) return true;
      }
      return false;
    };
    let nx = 0;
    for (const rs of situation.roads) {
      if (rs.status !== 'verified_blocked' || nx >= 32) continue;
      const road = roadById.get(rs.roadId);
      if (!road || road.points.length < 2) continue;
      const k = Math.min(Math.max(0, rs.segment), road.points.length - 2);
      const [ax, az] = road.points[k];
      const [bx, bz] = road.points[k + 1];
      const x = (ax + bx) / 2;
      const z = (az + bz) / 2;
      if (!nearRoute(x, z, 160)) continue;
      ground.push({
        x,
        y: groundAt(terrain, x, z) + 1.3,
        z,
        normal: nrm(x, z),
        yaw: Math.atan2(bx - ax, bz - az),
        radius: 7,
        minPx: 7,
        style: STYLE_X,
        color: new THREE.Color('#ff2a1f'),
        intensity: 1,
        incIdx: -1,
      });
      nx++;
    }
    markers.setGround(ground);
    markers.setBeams(beams);

    // ── Labels ──
    const specs: LabelSpec[] = [];
    shownInc.forEach((inc, i) => {
      const r = rank.get(inc.id);
      const pi = r === undefined ? 3 : Math.min(2, Math.max(0, r - 1));
      const e = el('div', `rsq-inc rsq-p${r === undefined ? 0 : Math.min(3, r)}${inc.verified ? '' : ' rsq-unv'}`);
      e.style.setProperty('--c', PRIORITY_HEX[pi]);
      const tag = r === undefined ? '·' : `P${r}`;
      const unv = inc.verified ? '' : `<span class="rsq-unvtxt">model ${inc.pDestroyed !== undefined ? Math.round(inc.pDestroyed * 100) + '%' : 'risk'}</span><i class="rsq-sep"></i>`;
      e.innerHTML = `<b class="rsq-tag">${tag}</b><span class="rsq-txt">${unv}<span class="rsq-main">${esc(incidentMain(inc))}</span><i class="rsq-sep"></i><span class="rsq-sub">${esc(cleanLabel(inc.label))}</span></span>`;
      const y = groundAt(terrain, inc.x, inc.z) + 26;
      specs.push({ key: `inc:${inc.id}`, kind: 'incident', x: inc.x, y, z: inc.z, priority: 100 - (r ?? 50) + (inc.verified ? 0.5 : 0), incIdx: i, el: e });
    });
    for (const { f, incs } of usedFac.values()) {
      const e = el('div', 'rsq-fac');
      e.style.setProperty('--c', FACILITY_HEX[f.kind]);
      e.innerHTML = `<span class="rsq-ico">${FACILITY_ICON[f.kind]}</span><span class="rsq-name">${esc(f.name)}</span>`;
      e.dataset.incs = [...incs].join(',');
      specs.push({ key: `fac:${f.id}`, kind: 'facility', x: f.x, y: groundAt(terrain, f.x, f.z) + 4, z: f.z, priority: 30, incIdx: -1, el: e });
    }
    const v = new THREE.Vector3();
    for (const g of groups) {
      const e = el('div', 'rsq-badge');
      e.style.setProperty('--c', UNIT_HEX[g.unitType]);
      g.badgeEl = e;
      setBadgeText(g, `<span class="rsq-n">${g.members.length}</span>${UNIT_SHORT[g.unitType]}<span class="rsq-eta">${fmtMin(g.etaMin)}</span>`);
      sampleAt(g.line, g.line.length * (g.mode === 'air' ? 0.5 : 0.42), v);
      specs.push({ key: g.badgeKey, kind: 'badge', x: v.x, y: v.y + 2, z: v.z, priority: 10 + (shownInc.length - g.incIdx) * 0.01, incIdx: g.incIdx, el: e });
    }
    labels.set(specs);

    // ── Units ──
    const uspecs: UnitSpec[] = [];
    let order = 0;
    const byAssignment = [...groups].sort((a, b) => a.assignmentIdx - b.assignmentIdx || a.idx - b.idx);
    for (const g of byAssignment) {
      const len = UNIT_SIZE[g.unitType][0];
      g.members.forEach((m, k) => {
        uspecs.push({
          group: g.idx,
          type: g.unitType,
          mode: g.mode,
          line: g.line,
          lane: g.mode === 'road' ? UNIT_LANE[g.unitType] : 0,
          delay: order * 0.45 + k * 0.9,
          duration: THREE.MathUtils.clamp((m.route.etaMin || g.etaMin) * 4, 8, 40),
          parkBack: g.mode === 'road' ? 10 + k * (len + 4) : k * 22,
          incIdx: g.incIdx,
          etaMin: m.route.etaMin || g.etaMin,
        });
      });
      order++;
    }
    units.set(uspecs);

    // Plan bounds (x/z) for the integrator to frame the camera: object.userData.bounds.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const grow = (x: number, z: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    };
    for (const g of groups) for (let i = 0; i < g.line.n; i += 4) grow(g.line.p[i * 3], g.line.p[i * 3 + 2]);
    for (const inc of shownInc) grow(inc.x, inc.z);
    object.userData.bounds = isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;

    u.uShowT.value = now();
    u.uDispatched.value = 0;
    active = true;
    object.visible = true;
    setLayer();
    applyHighlight();
  }

  function fmtMin(m: number): string {
    if (m <= 0.05) return 'on scene';
    return m < 10 ? `${m.toFixed(1)} min` : `${Math.round(m)} min`;
  }

  function setBadgeText(g: Group, html: string) {
    if (!g.badgeEl || g.lastText === html) return;
    g.lastText = html;
    g.badgeEl.innerHTML = html;
    labels.remeasure(g.badgeKey);
  }

  function dispatch() {
    if (!active || units.dispatched) return;
    units.dispatch(now());
    u.uDispatched.value = 1;
    setLayer();
  }

  const lift = new THREE.Vector3();
  ctx.onUpdate(() => {
    if (!active) return;
    const t = now();
    u.uTime.value = t;
    u.uNight.value = ctx.env.nightFactor;
    const H = ctx.renderer.domElement.clientHeight || window.innerHeight;
    const px = pxPerMetre(ctx.camera, H);
    u.uPx.value = px;
    const st = units.update(t, ctx.camera, px, ctx.env.sunDirection);
    if (units.dispatched) {
      for (const s of st) {
        const g = groups[s.group];
        if (!g) continue;
        if (s.started) {
          lift.copy(s.lead);
          labels.move(g.badgeKey, lift.x, lift.y + (g.mode === 'air' ? 10 : 6), lift.z);
        }
        const done = s.arrived === s.total;
        const n = `<span class="rsq-n">${s.total}</span>${UNIT_SHORT[g.unitType]}`;
        const eta = done ? 'on scene' : s.started ? fmtMin(Math.max(0.1, s.remainingMin)) : 'rolling';
        setBadgeText(g, `${n}<span class="rsq-eta">${eta}</span>`);
        g.badgeEl?.classList.toggle('rsq-done', done);
        g.badgeEl?.classList.toggle('rsq-moving', s.started && !done);
      }
    }
    labels.frame();
  });

  return {
    object,
    show,
    dispatch,
    get dispatched() {
      return units.dispatched;
    },
    setHighlight(incidentId: string | null) {
      highlightIdx = incidentId === null ? -1 : (incIndex.get(incidentId) ?? -1);
      applyHighlight();
    },
    clear,
  };
}
