/**
 * Mock data for the UI dev page (ui-dev.html): scenarios in real USGS GeoJSON shape, a synthetic city
 * for exposure counts, a deterministic damage timeline and one richly-attributed building.
 * Dev-only — never imported by the app.
 */
import type {
  BuildingDamage,
  BuildingRecord,
  BuildingShaking,
  CameraPreset,
  CityData,
  DamageState,
  QuakeResult,
  QuakeScenario,
  UsgsEvent,
} from '../contracts';
import { CITY_ORIGIN, haversineKm } from '../geo';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usgsEvent(id: string, mag: number, lat: number, lon: number, depth: number, place: string, alert: UsgsEvent['properties']['alert']): UsgsEvent {
  const time = Date.UTC(2026, 9, 24, 23, 30, 12); // 16:30:12 PDT
  return {
    type: 'Feature',
    id,
    properties: {
      mag,
      place,
      time,
      updated: time + 3.6e6,
      tz: null,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      detail: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${id}.geojson`,
      felt: null,
      cdi: null,
      mmi: null,
      alert,
      status: 'reviewed',
      tsunami: 0,
      sig: Math.round(mag * 120),
      net: 'nc',
      code: id.slice(2),
      ids: `,${id},`,
      sources: ',nc,us,',
      types: ',shakemap,losspager,origin,',
      nst: 112,
      dmin: 0.04,
      rms: 0.12,
      gap: 31,
      magType: mag >= 6 ? 'Mw' : 'ml',
      type: 'earthquake',
      title: `M ${mag.toFixed(1)} - ${place}`,
    },
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
  };
}

export const MOCK_SCENARIOS: QuakeScenario[] = [
  {
    id: 'hayward_m70',
    name: 'Hayward Fault M7.0',
    description: 'Rupture nucleating near Fremont and running north under Oakland and Berkeley. The Bay Area’s most likely large quake.',
    event: usgsEvent('nc75000001', 7.0, 37.56, -121.98, 8, '4 km NNE of Fremont, CA', 'orange'),
    localHour: 16.5,
  },
  {
    id: 'san_andreas_1906',
    name: 'San Andreas M7.8, 1906 repeat',
    description: 'The 1906 rupture: 470 km of the northern San Andreas, epicentre just offshore of the Golden Gate.',
    event: usgsEvent('nc75000002', 7.8, 37.75, -122.55, 8, '12 km WSW of San Francisco, CA', 'red'),
    localHour: 5.2,
  },
  {
    id: 'loma_prieta_1989',
    name: 'Loma Prieta M6.9, 1989 repeat',
    description: 'Santa Cruz Mountains rupture that collapsed the Cypress Structure and damaged the Marina’s bay fill.',
    event: usgsEvent('nc75000003', 6.9, 37.04, -121.88, 17, '14 km NE of Aptos, CA', 'orange'),
    localHour: 17.07,
  },
  {
    id: 'bay_m54',
    name: 'Local M5.4 under the Bay',
    description: 'Moderate event on a blind thrust below Yerba Buena Island. Short, sharp shaking downtown.',
    event: usgsEvent('nc75000004', 5.4, 37.81, -122.35, 9, '5 km NW of Oakland, CA', 'yellow'),
    localHour: 11,
  },
];

export const MOCK_PRESETS: CameraPreset[] = [
  { id: 'overview', label: 'Overview — Ferry Building to Chinatown', position: [0, 900, 1200], target: [0, 0, 0] },
  { id: 'ferry', label: 'Ferry Building', position: [700, 80, 0], target: [401, 30, -224] },
  { id: 'chinatown', label: 'Chinatown — Grant Ave', position: [-700, 60, 200], target: [-762, 10, -230] },
  { id: 'street', label: 'Street level — Market St', position: [250, 2, -60], target: [0, 20, 100] },
  { id: 'transamerica', label: 'Transamerica Pyramid', position: [-200, 180, 100], target: [-421, 120, -186] },
  { id: 'embarcadero', label: 'Embarcadero Center', position: [300, 120, 100], target: [70, 60, -166] },
  { id: 'aerial_east', label: 'Aerial from the Bay', position: [1600, 500, 400], target: [0, 0, -100] },
];

/** ~2,100 buildings with HAZUS-like day/night occupancy so exposure counts look realistic. */
export function mockCity(): CityData {
  const r = rng(7);
  const buildings: BuildingRecord[] = [];
  for (let i = 0; i < 2140; i++) {
    const office = r() < 0.35;
    const floors = office ? 4 + Math.floor(r() * 30) : 2 + Math.floor(r() * 5);
    const area = (300 + r() * 1200) * floors;
    const b = mockBuilding();
    buildings.push({
      ...b,
      id: `B${String(i).padStart(4, '0')}`,
      occupantsDay: Math.round((area / (office ? 22 : 80)) * (0.7 + r() * 0.6)),
      occupantsNight: Math.round((area / (office ? 400 : 45)) * (0.7 + r() * 0.6)),
    });
  }
  return {
    meta: {
      name: 'San Francisco — mock',
      bbox: { south: 37.788, west: -122.41, north: 37.799, east: -122.386 },
      contextBBox: { south: 37.7835, west: -122.416, north: 37.804, east: -122.38 },
      origin: { lat: CITY_ORIGIN.lat, lon: CITY_ORIGIN.lon },
      generatedAt: new Date().toISOString(),
      sources: ['mock'],
    },
    buildings,
    roads: [],
    areas: [],
    trees: [],
  };
}

/** A Chinatown URM walk-up — the kind of building rescue crews prioritise. */
export function mockBuilding(): BuildingRecord {
  return {
    id: 'B0412',
    osmId: 'way/27382641',
    name: 'Sun Sing Theatre Building',
    address: '1021 Grant Ave',
    footprint: [
      [0, 0],
      [18, 0],
      [18, 9],
      [14, 9],
      [14, 26],
      [0, 26],
    ],
    baseElevation: 14.2,
    height: 17.6,
    levels: 4,
    use: 'mixed',
    structure: 'URM',
    yearBuilt: 1909,
    codeLevel: 'pre',
    occupantsDay: 86,
    occupantsNight: 54,
    softStory: true,
    district: 'chinatown',
    onFill: false,
    vs30: 412,
    material: 'brick',
    provenance: { height: 'datasf_lidar', year: 'assessor', structure: 'estimated' },
  };
}

/** Rough P/S timing + ShakeAlert latency so the countdown matches the epicentral distance. */
export function alertTiming(s: QuakeScenario): { sArrival: number; issuedAtS: number; warning: number } {
  const [lon, lat, depth] = s.event.geometry.coordinates;
  const hyp = Math.hypot(haversineKm(CITY_ORIGIN.lat, CITY_ORIGIN.lon, lat, lon), depth);
  const sArrival = hyp / 3.5;
  const issuedAtS = Math.min(sArrival * 0.6, 4.8); // first alert ~5 s after origin
  return { sArrival, issuedAtS, warning: sArrival - issuedAtS };
}

export interface MockRun {
  scenario: QuakeScenario;
  result: QuakeResult;
}

/** Build a plausible result: per-building damage with staggered fail times after the S arrival. */
export function mockRun(scenario: QuakeScenario, city: CityData): MockRun {
  const r = rng(1976);
  const { sArrival, issuedAtS, warning } = alertTiming(scenario);
  const mag = scenario.event.properties.mag;
  const severity = Math.max(0, Math.min(1, (mag - 5) / 2.8)); // 0 at M5, 1 at M7.8
  const maxMmi = 5.6 + severity * 3.4;
  const occW = 0.5 + 0.5 * Math.cos(((scenario.localHour - 14) / 24) * Math.PI * 2);

  const damage: BuildingDamage[] = city.buildings.map(() => {
    const u = r();
    const p4 = 0.02 * severity ** 1.5;
    const p3 = p4 + 0.07 * severity ** 1.3;
    const p2 = p3 + 0.16 * severity;
    const p1 = p2 + 0.18 + 0.12 * severity;
    const state = (u < p4 ? 4 : u < p3 ? 3 : u < p2 ? 2 : u < p1 ? 1 : 0) as DamageState;
    const collapsed = state === 4 && r() < 0.45;
    return {
      state,
      exceedance: [p1, p2, p3, p4],
      collapsed,
      collapseFraction: collapsed ? 0.6 : 0,
      leanDirection: r() * Math.PI * 2,
      leanAngle: state >= 3 ? 0.05 : 0,
      debrisRadius: state >= 3 ? 6 : 0,
      fire: state >= 2 && r() < 0.012 + 0.02 * severity,
      failTimeS: sArrival + 0.6 + r() ** 1.6 * (6 + 14 * severity),
      trappedEstimate: collapsed ? 2 + r() * 14 : state === 3 ? r() * 1.4 : 0,
      casualties: [0, 0, 0, 0],
    };
  });

  const byState: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  damage.forEach((d) => byState[d.state]++);
  const shaking: BuildingShaking[] = city.buildings.map(() => ({
    distanceKm: 12,
    pgaG: 0.42,
    pgvCms: 48,
    mmi: maxMmi - 0.3,
    pArrivalS: sArrival * 0.57,
    sArrivalS: sArrival,
    durationS: 18,
  }));

  const result: QuakeResult = {
    scenario,
    shaking,
    damage,
    roads: [],
    stats: {
      buildings: city.buildings.length,
      byState,
      collapsed: damage.filter((d) => d.collapsed).length,
      fires: damage.filter((d) => d.fire).length,
      trappedEstimate: Math.round(damage.reduce((a, d) => a + d.trappedEstimate, 0)),
      blockedSegments: Math.round(damage.filter((d) => d.state >= 3).length * 0.22),
      maxMmi,
      occupantsAtTime: Math.round(city.buildings.reduce((a, b) => a + occW * b.occupantsDay + (1 - occW) * b.occupantsNight, 0)),
    },
    shakeAlert: { issuedAtS, warningSecondsAtCentre: warning, expectedMmi: maxMmi - 0.4 },
    durationS: sArrival + 45,
  };
  return { scenario, result };
}

/** Shaking + damage for the inspector's mock building. */
export function mockBuildingQuake(run: MockRun): { shaking: BuildingShaking; damage: BuildingDamage } {
  const sArrival = run.result.shaking[0].sArrivalS;
  return {
    shaking: { distanceKm: 46.2, pgaG: 0.38, pgvCms: 44, mmi: 7.9, pArrivalS: sArrival * 0.57, sArrivalS: sArrival, durationS: 21 },
    damage: {
      state: 3,
      exceedance: [0.94, 0.72, 0.41, 0.12],
      collapsed: false,
      collapseFraction: 0,
      leanDirection: 1.2,
      leanAngle: 0.04,
      debrisRadius: 5,
      fire: false,
      failTimeS: sArrival + 2.4,
      trappedEstimate: 6,
      casualties: [9, 3, 1, 0],
    },
  };
}

// ───────────────────────────── M4 drones (plan card, feeds, accuracy timeline) ─────────────────────────────
import type { AirUiState, DroneFeed, DroneId, DronePhase, DronePlan, DroneScheduleEntry, PlanUiState, ReconHistoryPoint } from '../contracts';

/** Named targets for the mock plan (dev.ts writes these onto the mock city's records). */
export const M4_TARGETS: Record<string, string> = {
  B0101: '401 Washington St',
  B0102: '53 Waverly Pl',
  B0103: '750 Kearny St',
  B0201: 'Sun Yat-sen Plaza',
  B0202: '920 Grant Ave',
  B0301: '1 Embarcadero Center',
  B0302: '100 Pine St',
};

/** Heli results from T+98 s, then drone wave 1 approved at T+236 s. */
export function mockHistory(upToS = 420): ReconHistoryPoint[] {
  const out: ReconHistoryPoint[] = [];
  const heli = [98, 116, 134, 152, 170, 188];
  heli.forEach((s, i) => {
    const pred = 0.27 + 0.02 * Math.sin(i * 1.7);
    out.push({ simS: s, source: 'heli', observed: 24 * (i + 1), predictionF1: pred, reconF1: 0.36 + i * 0.012, fusedF1: 0.4 + i * 0.022, fusedXbd: 0.6 + i * 0.01, collapsesConfirmed: 2 + i * 2, peopleSeen: 10 * (i + 1) });
  });
  const drone = [268, 289, 305, 327, 349, 372, 394];
  drone.forEach((s, i) => {
    out.push({ simS: s, source: 'drone', observed: 150 + 3 * (i + 1), predictionF1: 0.29, reconF1: 0.44 + i * 0.015, fusedF1: 0.53 + i * 0.022, fusedXbd: 0.68 + i * 0.012, collapsesConfirmed: 13 + i, peopleSeen: 64 + 4 * i });
  });
  return out.filter((p) => p.simS <= upToS);
}

export function mockAirState(history: ReconHistoryPoint[]): AirUiState {
  const last = history[history.length - 1];
  return {
    callsign: 'AIR 1',
    status: 'complete',
    flightS: 112,
    durationS: 112,
    scannedFraction: 0.43,
    pending: 0,
    mode: 'gemini',
    avgLatencyS: 19.6,
    stats: {
      chunksSent: 6,
      chunksDone: 6,
      buildingsObserved: last?.observed ?? 0,
      predictionAccuracy: 0.31,
      reconAccuracy: 0.42,
      predictionWithinOne: 0.7,
      reconWithinOne: 0.78,
      collapsesTruth: 64,
      collapsesPredicted: 17,
      collapsesObserved: last?.collapsesConfirmed ?? 0,
      peopleTruthVisible: 58,
      peopleObserved: last?.peopleSeen ?? 0,
      crowdsObserved: 11,
      surprises: [],
      lastSummary: 'Drone D1 confirms 401 Washington St has pancaked at the second floor; two people visible on the rubble at the Washington St frontage.',
      model: 'gemini-4-argon',
      mode: 'gemini',
      avgLatencyS: 19.6,
      buildingsCovered: 322,
      predictionXbd: 0.62,
      reconXbd: 0.58,
      fusedXbd: last?.fusedXbd ?? 0,
      predictionF1: last?.predictionF1 ?? 0,
      reconF1: last?.reconF1 ?? 0,
      fusedF1: last?.fusedF1 ?? 0,
      history,
      droneObserved: history.filter((p) => p.source === 'drone').length * 3,
    },
  };
}

export function mockPlan(wave: 1 | 2 = 1, missions = 2): DronePlan {
  const all: DronePlan['missions'] = [
    {
      id: `W${wave}-D1`,
      wave,
      droneId: 'D1',
      kind: 'verify_building',
      targetBuildingIds: ['B0101', 'B0102', 'B0103'],
      purpose: 'Low-confidence collapse call (0.41) on a URM walk-up with ~60 occupants; confirm collapse and look for trapped people.',
      priority: 1,
    },
    {
      id: `W${wave}-D2`,
      wave,
      droneId: 'D2',
      kind: 'survey_area',
      targetBuildingIds: ['B0201', 'B0202'],
      areaCentre: [-760, -230],
      purpose: 'Unscanned high-risk URM cluster west of Grant Ave; the helicopter route never covered it.',
      priority: 2,
    },
    {
      id: `W${wave}-D3`,
      wave,
      droneId: 'D3',
      kind: 'verify_building',
      targetBuildingIds: ['B0301', 'B0302'],
      purpose: 'Model expects extensive damage; helicopter saw only slight. Resolve the disagreement.',
      priority: 3,
    },
  ];
  return {
    wave,
    dispatch: true,
    rationale:
      'The helicopter covered 43% of the area. The largest remaining uncertainty is in Chinatown: one collapse call at 0.41 confidence with people likely inside, and an unscanned block of pre-1933 brick buildings. Two drones close those gaps within about 3 minutes; D3 stays in reserve for wave 2.',
    holdReason: 'Coverage is still growing and no low-confidence call involves people. Re-assess after the next helicopter chunk.',
    missions: all.slice(0, missions),
    model: 'gemini-4-argon',
    mode: 'gemini',
    latencyMs: 8400,
    createdAtSimS: 236,
  };
}

export function mockSchedule(plan: DronePlan, startS: number): DroneScheduleEntry[] {
  return plan.missions.map((m, k) => {
    let t = startS + 4 + k * 2;
    const targets = m.targetBuildingIds.map((id, i) => {
      t += i === 0 ? 34 + k * 8 : 9;
      const arriveS = t;
      t += 18;
      return { buildingId: id, arriveS, leaveS: t };
    });
    return { missionId: m.id, droneId: m.droneId, startS, targets, endS: t + 36 + k * 6 };
  });
}

/** Phase of a drone at simS under a schedule (for mock feeds). */
export function mockDronePhase(e: DroneScheduleEntry | undefined, s: number): { phase: DronePhase; target?: string } {
  if (!e || s < e.startS) return { phase: 'idle' };
  if (s >= e.endS) return { phase: 'done' };
  for (const t of e.targets) {
    if (s < t.arriveS) return { phase: 'transit', target: t.buildingId };
    if (s < t.leaveS) return { phase: 'orbit', target: t.buildingId };
  }
  return { phase: 'return' };
}

/** Synthetic aerial frame with AR tags (canvas → JPEG base64, no data: prefix). */
export function mockFrame(id: DroneId, label: string, seed: number): string {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  g.fillStyle = '#5d6157';
  g.fillRect(0, 0, 640, 360);
  g.save();
  g.translate(320, 180);
  g.rotate(-0.35 + r() * 0.2);
  g.fillStyle = '#3d4044';
  g.fillRect(-700, -24, 1400, 48);
  g.fillRect(-30, -500, 60, 1000);
  for (let i = 0; i < 40; i++) {
    const x = -640 + r() * 1280;
    const y = -400 + r() * 800;
    if (Math.abs(y) < 40 || Math.abs(x) < 46) continue;
    const w = 40 + r() * 90;
    const hh = 40 + r() * 90;
    const v = 120 + Math.floor(r() * 90);
    g.fillStyle = `rgb(${v + 20},${v},${v - 18})`;
    g.fillRect(x, y, w, hh);
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(x + w, y + 6, 8, hh);
  }
  // Rubble at the target.
  g.fillStyle = '#8a7a66';
  for (let i = 0; i < 80; i++) g.fillRect(60 + r() * 90 - 45, -110 + r() * 70, 3 + r() * 9, 3 + r() * 9);
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,.8)';
  g.lineWidth = 2;
  g.strokeRect(300, 120, 120, 90);
  g.font = '600 15px Barlow, sans-serif';
  g.fillStyle = 'rgba(15,20,25,.75)';
  g.fillRect(300, 94, g.measureText(label).width + 14, 22);
  g.fillStyle = '#fff';
  g.fillText(label, 307, 110);
  g.font = '500 12px "IBM Plex Mono", monospace';
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillText(`${id}  ALT 70m  37.7952N 122.4058W`, 12, 348);
  return c.toDataURL('image/jpeg', 0.72).split(',')[1];
}

export function mockFeeds(schedule: DroneScheduleEntry[], s: number, nameOf: (id: string) => string): DroneFeed[] {
  return (['D1', 'D2', 'D3'] as DroneId[]).map((id, k) => {
    const e = schedule.find((x) => x.droneId === id);
    const { phase, target } = mockDronePhase(e, s);
    const name = target ? nameOf(target) : '';
    const word = { idle: 'standby', transit: `transit ${name}`, orbit: `orbit ${name}`, return: 'returning', done: 'landed' }[phase];
    return {
      droneId: id,
      phase,
      label: `${id} · ${word}`,
      jpegBase64: phase === 'idle' || phase === 'done' ? null : mockFrame(id, name || 'EMBARCADERO PLAZA', 11 + k * 7 + Math.floor(s / 6)),
      missionId: e?.missionId,
    };
  });
}

export type { PlanUiState };

// ───────────────────────────── M5 copilot (chat drawer) ─────────────────────────────
import type { ChatMessage, CopilotSituation, Facility, RescueIncident, RescuePlan, TravelTime } from '../contracts';

export function mockCopilotSituation(): CopilotSituation {
  const fac = (id: string, kind: Facility['kind'], name: string, x: number, z: number): Facility => ({ id, kind, name, lat: 37.79, lon: -122.4, x, z });
  const facilities: Facility[] = [
    fac('SFFD-13', 'fire_station', 'Station 13 · Sansome', 420, -180),
    fac('SFFD-2', 'fire_station', 'Station 2 · Powell', -260, -120),
    fac('SFFD-1', 'fire_station', 'Station 1 · Folsom', 300, 520),
    fac('SFPD-CENTRAL', 'police_station', 'SFPD Central · Vallejo', -40, -420),
    fac('HOSP-CHINESE', 'hospital', 'Chinese Hospital', -180, -260),
    fac('STAGE-EMB', 'staging', 'Staging · Ferry Plaza', 820, 60),
    fac('HELI-PIER', 'helipad', 'Helipad · Pier 27', 640, -720),
  ];
  const inc = (o: Partial<RescueIncident> & Pick<RescueIncident, 'id' | 'kind' | 'label' | 'verified'>): RescueIncident => ({ x: 0, z: 0, confidence: 0.8, ...o });
  const incidents: RescueIncident[] = [
    inc({ id: 'I-B3291', kind: 'trapped', label: '401 Washington St', verified: true, confidence: 0.92, peopleSeen: 6, trappedSigns: true, damage: 'collapsed', occupants: 140, evidence: 'drone D2 · W1 · t+14 s' }),
    inc({ id: 'I-B2207', kind: 'fire', label: '750 Kearny St', verified: true, confidence: 0.88, fire: true, peopleSeen: 2, damage: 'extensive', evidence: 'AIR 1 chunk 3' }),
    inc({ id: 'I-B1180', kind: 'trapped', label: '53 Waverly Pl', verified: true, confidence: 0.81, peopleSeen: 3, trappedSigns: true, damage: 'collapsed', evidence: 'AIR 1 chunk 5' }),
    inc({ id: 'I-CROWD-2', kind: 'crowd', label: 'Portsmouth Square', verified: true, confidence: 0.9, crowdSize: 85, evidence: 'AIR 1 chunk 2' }),
    inc({ id: 'I-B4410', kind: 'suspected_collapse', label: '920 Grant Ave', verified: false, confidence: 0.55, pDestroyed: 0.62, occupants: 60 }),
  ];
  const roads: CopilotSituation['roads'] = [
    { roadId: 'r12', segment: 3, name: 'Washington St', status: 'verified_blocked', source: 'argon' },
    { roadId: 'r40', segment: 1, name: 'Kearny St', status: 'partial', source: 'argon' },
    { roadId: 'r77', segment: 0, name: 'Grant Ave', status: 'likely_blocked', source: 'model' },
  ];
  const tt = (from: string, incident: string, roadMin: number | null, airMin: number, risk = false): TravelTime => ({ fromFacilityId: from, incidentId: incident, roadMin, airMin, passesLikelyBlocked: risk });
  const travelTimes: TravelTime[] = [
    tt('SFFD-13', 'I-B3291', 4.2, 1.1),
    tt('SFFD-13', 'I-B2207', 6.8, 1.4, true),
    tt('SFFD-2', 'I-B1180', null, 1.0),
    tt('SFFD-2', 'I-B2207', 3.6, 0.9),
    tt('SFFD-1', 'I-B3291', 9.4, 2.2),
    tt('HOSP-CHINESE', 'I-B3291', 5.1, 1.3),
    tt('HOSP-CHINESE', 'I-B1180', 2.4, 0.6),
    tt('SFPD-CENTRAL', 'I-CROWD-2', 3.1, 0.8),
    tt('SFPD-CENTRAL', 'I-B3291', 5.6, 1.2),
    tt('HELI-PIER', 'I-B1180', 12.5, 3.4),
    tt('HELI-PIER', 'I-B4410', 11.2, 3.0),
    tt('STAGE-EMB', 'I-B4410', 7.9, 2.0, true),
  ];
  return {
    scenarioId: 'san_andreas_1906',
    simS: 760,
    localTime: '15:12 PDT',
    minutesSinceQuake: 13,
    summary: { buildingsAssessed: 412, collapsesVerified: 17, peopleSeen: 86, trappedSitesVerified: 5, fires: 3, crowds: 2, areaScannedPct: 64, latestArgonSummary: 'Drone wave 2 confirms collapse at 401 Washington St with people on the rubble.' },
    incidents,
    roads,
    facilities,
    travelTimes,
  };
}

export function mockRescuePlan(): RescuePlan {
  return {
    priorities: [
      { rank: 1, incidentId: 'I-B3291', reason: 'Verified collapse, 6 people seen on rubble, ~140 occupants at this hour.' },
      { rank: 2, incidentId: 'I-B2207', reason: 'Verified fire next to a damaged block; spread risk toward Chinatown.' },
      { rank: 3, incidentId: 'I-B1180', reason: 'Verified collapse with 3 people waving; road access blocked.' },
      { rank: 4, incidentId: 'I-B4410', reason: 'Unverified model risk (62% destroyed). Send a helicopter to look first.' },
    ],
    assignments: [
      { unitType: 'engine', count: 4, fromFacilityId: 'SFFD-13', incidentId: 'I-B3291', task: 'Heavy rescue + debris lift' },
      { unitType: 'engine', count: 4, fromFacilityId: 'SFFD-2', incidentId: 'I-B2207', task: 'Fire attack, protect exposures' },
      { unitType: 'engine', count: 2, fromFacilityId: 'SFFD-1', incidentId: 'I-B3291', task: 'Second alarm, water supply' },
      { unitType: 'ambulance', count: 3, fromFacilityId: 'HOSP-CHINESE', incidentId: 'I-B3291', task: 'Triage at Washington & Montgomery' },
      { unitType: 'ambulance', count: 3, fromFacilityId: 'HOSP-CHINESE', incidentId: 'I-B1180', task: 'Casualty collection point' },
      { unitType: 'police', count: 12, fromFacilityId: 'SFPD-CENTRAL', incidentId: 'I-CROWD-2', task: 'Crowd control, open evacuation lane' },
      { unitType: 'police', count: 8, fromFacilityId: 'SFPD-CENTRAL', incidentId: 'I-B3291', task: 'Perimeter + traffic control' },
      { unitType: 'helicopter', count: 1, fromFacilityId: 'HELI-PIER', incidentId: 'I-B1180', task: 'Roof extraction (no road access)' },
      { unitType: 'helicopter', count: 1, fromFacilityId: 'HELI-PIER', incidentId: 'I-B4410', task: 'Verify suspected collapse' },
    ],
    routeClearing: [
      { roadName: 'Washington St', unitType: 'police', reason: 'Verified blocked; the only direct access to P1 from Station 13.' },
      { roadName: 'Grant Ave', unitType: 'engine', reason: 'Likely blocked (model): needed for P3 by road.' },
    ],
    reassessInMinutes: 10,
    assumptions: ['Unit counts from your message; facilities from SFFD/SFPD station lists.', 'ETAs avoid Argon-verified blockages; likely blockages add a time penalty.'],
  };
}

const MOCK_REPLY = `**Priorities (Argon-verified first):**

1. **401 Washington St** \`I-B3291\` — verified collapse, 6 people seen on the rubble. Send the heaviest rescue package now.
2. **750 Kearny St** — verified fire next to damaged buildings; contain before it spreads.
3. **53 Waverly Pl** — 3 people waving, but **no open road**: use a helicopter.

**Routing**
- 10 engines: 4 from *Station 13* to P1 (4 min), 4 from Station 2 to the fire, 2 as a second alarm.
- 20 officers: 12 to Portsmouth Square for crowd control, 8 for the P1 perimeter. Clear **Washington St** first.
- 6 ambulances split between P1 and P3 from Chinese Hospital.
- 2 helicopters: one extraction at Waverly Pl, one to *verify* 920 Grant Ave (model risk only).

Reassess in 10 min when drone wave 2 lands.`;

export function mockCopilotMessages(withPlan = true, planState: ChatMessage['planState'] = 'none'): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { id: 'u1', role: 'user', text: '我有10辆消防车、20名警察、2架直升机、6辆救护车，如何安排救援路线和优先级？', at: 742 },
  ];
  if (withPlan) msgs.push({ id: 'a1', role: 'assistant', text: MOCK_REPLY, at: 749, plan: mockRescuePlan(), mode: 'gemini', latencyMs: 6400, planState });
  return msgs;
}
