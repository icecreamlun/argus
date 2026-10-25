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
