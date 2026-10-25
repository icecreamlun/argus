/**
 * Earthquake scenarios and their USGS GeoJSON event records.
 *
 * Presets (all re-dated to 2026-10-25, local time PDT = UTC−7):
 *   san_andreas_1906  M7.8 strike-slip, ~470 km bilateral rupture of the northern San Andreas fault from
 *                     Shelter Cove to San Juan Bautista; hypocentre offshore of the Golden Gate, depth 8 km
 *                     (Lomax 2005 relocation ≈ 37.75 N 122.55 W). Trace follows the mapped fault: offshore
 *                     to Point Arena, Gualala valley, Fort Ross, Bodega/Tomales Bay, Olema valley, Bolinas
 *                     Lagoon, offshore 8–15 km west of SF, onshore at Mussel Rock, then down the Peninsula
 *                     (San Andreas Lake, Crystal Springs, Portola Valley, Skyline, Lexington, Loma Prieta)
 *                     to San Juan Bautista. 1906 struck at 05:12 local.
 *   hayward_haywired  M7.0 strike-slip, USGS HayWired scenario (Detweiler & Wein 2017): ~83 km rupture
 *                     of the Hayward fault from Point Pinole to Fremont, epicentre in Oakland, 04:18 pm.
 *   loma_prieta_1989  M6.9 oblique-reverse (rake ≈ 140°, dip 70° SW), epicentre 37.040 N 121.877 W,
 *                     17 km deep, ~40 km blind rupture in the Santa Cruz Mountains striking N50W with
 *                     top-of-rupture ≈ 3.8 km (NGA-West2 flatfile). 1989 struck at 05:04 pm.
 *
 * Custom scenarios: point source for M ≤ 6.5; above that a synthetic bilateral trace centred on the
 * epicentre, striking N35W (Bay Area right-lateral faults), with Wells & Coppersmith (1994) strike-slip
 * surface rupture length log10(SRL km) = −3.55 + 0.74 M and width log10(RW km) = −0.76 + 0.27 M,
 * top of rupture ztor = max(0, depth − RW/2).
 *
 * USGS record fields: id = network + 8 digits ("nc75093861"); place = "<d> km <16-point bearing> of <town>, CA"
 * using the nearest of a list of GeoNames places (as the USGS feed does); alert = PAGER colour from a
 * loss proxy (max median MMI at major Bay Area population centres: ≥ 8.5 red, ≥ 7.5 orange, ≥ 6.5 yellow);
 * sig = mag·100·mag/6.5 + PAGER weight (red 2000 / orange 1000 / yellow 650), following the documented
 * USGS significance recipe; tsunami = 1 for an offshore epicentre with M ≥ 6.5 (NTWC message criterion).
 */
import type { QuakeScenario, UsgsEvent } from '../../contracts';
import { haversineKm } from '../../geo';
import type { Mechanism } from './gmpe';
import { bearingDeg, destination } from './regional';

/** Extra (non-contract) parameters carried on our scenario objects; spreads like {...s} keep them. */
export interface ScenarioExtras {
  mechanism?: Mechanism;
  /** Rupture velocity (km/s). */
  ruptureVelocityKmS?: number;
}
export type ArgusScenario = QuakeScenario & ScenarioExtras;

/** GeoNames-style reference places (pop > 1000) for the USGS "place" string. */
const PLACES: [string, number, number][] = [
  ['San Francisco', 37.7749, -122.4194], ['Daly City', 37.6879, -122.4702], ['Pacifica', 37.6138, -122.4869],
  ['South San Francisco', 37.6547, -122.4077], ['Half Moon Bay', 37.4636, -122.4286], ['San Mateo', 37.563, -122.3255],
  ['Redwood City', 37.4852, -122.2364], ['Woodside', 37.4299, -122.2539], ['Palo Alto', 37.4419, -122.143],
  ['Los Gatos', 37.2358, -121.9624], ['San Jose', 37.3382, -121.8863], ['Milpitas', 37.4323, -121.8996],
  ['Fremont', 37.5485, -121.9886], ['Newark', 37.5297, -122.0402], ['Union City', 37.5934, -122.0439],
  ['Hayward', 37.6688, -122.0808], ['Castro Valley', 37.6941, -122.0864], ['San Leandro', 37.7249, -122.1561],
  ['Oakland', 37.8044, -122.2712], ['Alameda', 37.7652, -122.2416], ['Piedmont', 37.8244, -122.2316],
  ['Emeryville', 37.8313, -122.2852], ['Berkeley', 37.8716, -122.2727], ['Albany', 37.8869, -122.2978],
  ['El Cerrito', 37.9161, -122.3108], ['Richmond', 37.9358, -122.3477], ['San Pablo', 37.9621, -122.3455],
  ['Pinole', 38.0044, -122.2989], ['Sausalito', 37.8591, -122.4853], ['Mill Valley', 37.906, -122.545],
  ['Stinson Beach', 37.9005, -122.6444], ['Bolinas', 37.9091, -122.6866], ['San Rafael', 37.9735, -122.5311],
  ['Point Reyes Station', 38.0691, -122.8069], ['Novato', 38.1074, -122.5697], ['Petaluma', 38.2324, -122.6367],
  ['Bodega Bay', 38.3333, -123.0481], ['Jenner', 38.4497, -123.1156], ['Gualala', 38.7657, -123.5267],
  ['Point Arena', 38.9088, -123.6931], ['Fort Bragg', 39.4457, -123.8053], ['Shelter Cove', 40.0304, -124.0731],
  ['Scotts Valley', 37.0511, -122.0147], ['Santa Cruz', 36.9741, -122.0308], ['Aptos', 36.9772, -121.8994],
  ['Corralitos', 36.9883, -121.8063], ['Watsonville', 36.9102, -121.7569], ['Morgan Hill', 37.1305, -121.6544],
  ['Gilroy', 37.0058, -121.5683], ['San Juan Bautista', 36.8455, -121.538], ['Hollister', 36.8525, -121.4016],
  ['Monterey', 36.6002, -121.8947], ['Walnut Creek', 37.9101, -122.0652], ['Concord', 37.978, -122.0311],
  ['Livermore', 37.6819, -121.768], ['Vallejo', 38.1041, -122.2566], ['Napa', 38.2975, -122.2869],
  // Rest of California, so custom events anywhere in the state get a sensible place name.
  ['Santa Rosa', 38.4404, -122.7141], ['Ukiah', 39.1502, -123.2078], ['Eureka', 40.8021, -124.1637],
  ['Ferndale', 40.5762, -124.2639], ['Redding', 40.5865, -122.3917], ['Sacramento', 38.5816, -121.4944],
  ['Stockton', 37.9577, -121.2908], ['Modesto', 37.6391, -120.9969], ['Salinas', 36.6777, -121.6555],
  ['Parkfield', 35.8997, -120.4327], ['San Luis Obispo', 35.2828, -120.6596], ['Fresno', 36.7378, -119.7871],
  ['Bakersfield', 35.3733, -119.0187], ['Santa Barbara', 34.4208, -119.6982], ['Ventura', 34.2746, -119.229],
  ['Los Angeles', 34.0522, -118.2437], ['Ridgecrest', 35.6225, -117.6709], ['Palm Springs', 33.8303, -116.5453],
  ['San Bernardino', 34.1083, -117.2898], ['Riverside', 33.9806, -117.3755], ['San Diego', 32.7157, -117.1611],
  ['El Centro', 32.792, -115.5631], ['Mammoth Lakes', 37.6485, -118.9721], ['Truckee', 39.328, -120.1833],
];

/** Pacific coastline (lat, lon), north → south, for the offshore test (land is east of it). */
const COAST: [number, number][] = [
  [40.44, -124.41], [40.03, -124.07], [39.45, -123.81], [38.91, -123.71], [38.45, -123.12], [38.3, -123.06],
  [38.0, -122.98], [37.9, -122.68], [37.81, -122.48], [37.76, -122.511], [37.665, -122.495], [37.46, -122.44],
  [37.25, -122.41], [37.1, -122.29], [36.96, -122.02], [36.9, -121.8], [36.6, -121.89], [36.3, -121.9],
];

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** USGS-style place string: "10 km NW of Daly City, CA". */
export function placeName(lat: number, lon: number): string {
  let best = PLACES[0];
  let bestD = Infinity;
  for (const p of PLACES) {
    const d = haversineKm(lat, lon, p[1], p[2]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (bestD < 0.5) return `${best[0]}, CA`;
  const b = bearingDeg(best[1], best[2], lat, lon);
  return `${Math.round(bestD)} km ${COMPASS[Math.round(b / 22.5) % 16]} of ${best[0]}, CA`;
}

/** Longitude of the coastline at a latitude (linear interpolation), or null outside its span. */
function coastLonAt(lat: number): number | null {
  for (let i = 0; i < COAST.length - 1; i++) {
    const [la, lo] = COAST[i];
    const [lb, lob] = COAST[i + 1];
    if (lat <= la && lat >= lb) return lo + ((lat - la) / (lb - la)) * (lob - lo);
  }
  return null;
}

/** Offshore distance (km) west of the coastline, 0 if on land / in the Bay. */
export function offshoreKm(lat: number, lon: number): number {
  const c = coastLonAt(lat);
  if (c === null || lon >= c) return 0;
  return haversineKm(lat, lon, lat, c);
}

/** Origin time: 2026-10-25 at localHour PDT (UTC−7), ms since epoch. */
export function originTimeMs(localHour: number): number {
  return Date.UTC(2026, 9, 25, 7, 0, 0) + Math.round(localHour * 3600) * 1000;
}

export interface EventImpact {
  /** Max median MMI at Bay Area population centres (PAGER loss proxy). */
  populatedMmi: number;
  /** Max MMI anywhere on the ShakeMap (soft soil next to the fault). */
  maxMmi: number;
}

export function alertFor(populatedMmi: number): UsgsEvent['properties']['alert'] {
  if (populatedMmi >= 8.5) return 'red';
  if (populatedMmi >= 7.5) return 'orange';
  if (populatedMmi >= 6.5) return 'yellow';
  return 'green';
}

/** Build the USGS GeoJSON Feature. */
export function buildUsgsEvent(opts: {
  id: string;
  mag: number;
  lat: number;
  lon: number;
  depthKm: number;
  localHour: number;
  impact: EventImpact;
}): UsgsEvent {
  const { id, mag, lat, lon, depthKm, localHour, impact } = opts;
  const time = originTimeMs(localHour);
  const alert = alertFor(impact.populatedMmi);
  const pagerSig = alert === 'red' ? 2000 : alert === 'orange' ? 1000 : alert === 'yellow' ? 650 : 0;
  const felt = Math.round(1500 * 10 ** (0.5 * (mag - 5)) * (alert === 'red' ? 2 : 1));
  const offshore = offshoreKm(lat, lon);
  const place = placeName(lat, lon);
  const code = id.replace(/^nc/, '');
  const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    type: 'Feature',
    id,
    properties: {
      mag: r1(mag, 1),
      place,
      time,
      updated: time + 47 * 60 * 1000,
      tz: null,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      detail: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${id}.geojson`,
      felt,
      cdi: r1(Math.min(10, impact.maxMmi - 0.4), 1),
      mmi: r1(impact.maxMmi, 3),
      alert,
      status: 'reviewed',
      tsunami: offshore > 0 && mag >= 6.5 ? 1 : 0,
      sig: Math.round((mag * 100 * mag) / 6.5 + pagerSig),
      net: 'nc',
      code,
      ids: `,${id},`,
      sources: ',nc,',
      types: ',dyfi,finite-fault,focal-mechanism,general-text,ground-failure,losspager,moment-tensor,nearby-cities,oaf,origin,phase-data,shakemap,',
      nst: Math.round(140 + 40 * Math.max(0, mag - 6) - offshore * 2),
      dmin: r1((offshore + 3) / 111.2, 4),
      rms: 0.17,
      gap: offshore > 0 ? Math.round(110 + offshore * 3) : 27,
      magType: 'mw',
      type: 'earthquake',
      title: `M ${mag.toFixed(1)} - ${place}`,
    },
    geometry: { type: 'Point', coordinates: [r1(lon, 4), r1(lat, 4), r1(depthKm, 2)] },
  };
}

// ───────────────────────────── preset definitions ─────────────────────────────

export interface ScenarioSpec {
  id: string;
  eventId: string;
  name: string;
  description: string;
  mag: number;
  lat: number;
  lon: number;
  depthKm: number;
  ztorKm: number;
  localHour: number;
  mechanism: Mechanism;
  /** [lat, lon] north → south (converted to the contract's [lon, lat]). */
  trace: [number, number][];
}

export const PRESET_SPECS: ScenarioSpec[] = [
  {
    id: 'san_andreas_1906',
    eventId: 'nc75093861',
    name: 'San Andreas M7.8 — 1906 repeat',
    description:
      'A repeat of the 18 April 1906 great San Francisco earthquake: ~470 km bilateral rupture of the northern San Andreas fault ' +
      'from Shelter Cove to San Juan Bautista, nucleating offshore of the Golden Gate only ~14 km from downtown. ' +
      'Strong shaking lasts close to a minute; brick buildings and the made ground of the old Yerba Buena Cove suffer most. ' +
      'Downtown is inside the ShakeAlert blind zone.',
    mag: 7.8,
    lat: 37.75,
    lon: -122.55,
    depthKm: 8,
    ztorKm: 0,
    localHour: 5.2,
    mechanism: 'SS',
    trace: [
      [40.0, -124.07], [39.78, -123.98], [39.55, -123.88], [39.3, -123.82], [39.05, -123.75], [38.96, -123.73],
      [38.8, -123.57], [38.65, -123.4], [38.52, -123.25], [38.38, -123.12], [38.27, -123.02], [38.14, -122.89],
      [38.03, -122.79], [37.91, -122.68], [37.83, -122.615], [37.75, -122.55], [37.665, -122.494], [37.58, -122.41],
      [37.48, -122.31], [37.38, -122.21], [37.28, -122.11], [37.19, -122.0], [37.09, -121.86], [36.97, -121.7],
      [36.9, -121.61], [36.85, -121.53],
    ],
  },
  {
    id: 'hayward_haywired',
    eventId: 'nc75093874',
    name: 'Hayward Fault M7.0 — USGS HayWired scenario',
    description:
      'The USGS HayWired scenario: an M7.0 rupture of the Hayward fault from Point Pinole to Fremont with its epicentre in Oakland. ' +
      'The East Bay is devastated; across the Bay, downtown San Francisco sits ~16 km from the fault and feels strong (MMI VI–VII) shaking ' +
      'with light to moderate damage, worst on the waterfront fill.',
    mag: 7.0,
    lat: 37.8,
    lon: -122.2,
    depthKm: 8,
    ztorKm: 0,
    localHour: 16.3,
    mechanism: 'SS',
    trace: [
      [37.99, -122.36], [37.94, -122.31], [37.89, -122.27], [37.87, -122.252], [37.83, -122.22], [37.8, -122.195],
      [37.77, -122.16], [37.73, -122.13], [37.68, -122.08], [37.62, -122.03], [37.55, -121.97], [37.5, -121.92],
      [37.45, -121.85],
    ],
  },
  {
    id: 'loma_prieta_1989',
    eventId: 'nc75093882',
    name: 'Loma Prieta M6.9 — 1989 repeat',
    description:
      'A repeat of the 17 October 1989 World Series earthquake: an oblique-reverse M6.9 rupture 17 km beneath the Santa Cruz Mountains, ' +
      '~95 km south of downtown. Moho-reflected waves still bring MMI VI–VII to the city, the Embarcadero fill shakes hardest, ' +
      'and ShakeAlert gives San Francisco around 20 seconds of warning.',
    mag: 6.9,
    lat: 37.04,
    lon: -121.877,
    depthKm: 17,
    ztorKm: 3.8,
    localHour: 17.07,
    mechanism: 'RS',
    trace: [
      [37.16, -122.06], [37.1, -121.968], [37.04, -121.877], [36.985, -121.79], [36.93, -121.7],
    ],
  },
];

/** Wells & Coppersmith (1994) strike-slip surface rupture length (km). */
export function wellsCoppersmithSrlKm(M: number): number {
  return 10 ** (-3.55 + 0.74 * M);
}
/** Wells & Coppersmith (1994) strike-slip rupture width (km). */
export function wellsCoppersmithWidthKm(M: number): number {
  return 10 ** (-0.76 + 0.27 * M);
}

/** Synthetic bilateral trace (lat/lon pairs, north → south) through the epicentre, striking N35W. */
export function syntheticTrace(lat: number, lon: number, M: number): [number, number][] {
  const L = wellsCoppersmithSrlKm(M);
  const n = Math.max(3, Math.ceil(L / 10) + 1);
  const north = destination(lat, lon, 325, L / 2);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push(destination(north[0], north[1], 145, (L * i) / (n - 1)));
  return out;
}

/** Stable pseudo-random NC event id for a custom event. */
export function customEventId(lat: number, lon: number, depthKm: number, mag: number): string {
  let h = 2166136261;
  const s = `${lat.toFixed(4)},${lon.toFixed(4)},${depthKm.toFixed(1)},${mag.toFixed(2)}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return 'nc7' + String(5100000 + (h % 4800000)).padStart(7, '0');
}
