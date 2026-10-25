/**
 * M5 real San Francisco emergency facilities in / near the study area.
 * Coordinates: OpenStreetMap (Overpass, amenity=fire_station|police|hospital), building centroids, checked
 * against the street addresses. Default units are plausible peacetime staffing; the commander's numbers override.
 */
import type { Facility, UnitType } from '../contracts';
import { project } from '../geo';

type Def = Omit<Facility, 'x' | 'z'>;

const DEFS: Def[] = [
  {
    id: 'SFFD-13',
    kind: 'fire_station',
    name: 'SFFD Station 13',
    address: '530 Sansome St',
    lat: 37.79553,
    lon: -122.401381,
    units: { engine: 1, truck: 1, ambulance: 1 },
  },
  {
    id: 'SFFD-2',
    kind: 'fire_station',
    name: 'SFFD Station 2',
    address: '1340 Powell St',
    lat: 37.797039,
    lon: -122.40991,
    units: { engine: 1, truck: 1, ambulance: 1 },
  },
  {
    id: 'SFFD-28',
    kind: 'fire_station',
    name: 'SFFD Station 28',
    address: '1814 Stockton St',
    lat: 37.802557,
    lon: -122.409385,
    units: { engine: 1, ambulance: 1 },
  },
  {
    id: 'SFFD-35',
    kind: 'fire_station',
    name: 'SFFD Station 35 (fireboats)',
    address: "Pier 22½, The Embarcadero",
    lat: 37.790205,
    lon: -122.388469,
    units: { engine: 2, usar: 1 },
  },
  {
    id: 'SFPD-CENTRAL',
    kind: 'police_station',
    name: 'SFPD Central Station',
    address: '766 Vallejo St',
    lat: 37.798743,
    lon: -122.409934,
    units: { police: 20 },
  },
  {
    id: 'HOSP-CHINESE',
    kind: 'hospital',
    name: 'Chinese Hospital',
    address: '845 Jackson St',
    lat: 37.795477,
    lon: -122.409003,
    units: { ambulance: 2 },
  },
  {
    id: 'HOSP-STFRANCIS',
    kind: 'hospital',
    name: 'Saint Francis Memorial Hospital',
    address: '900 Hyde St',
    lat: 37.789608,
    lon: -122.416867,
    units: { ambulance: 3 },
  },
  {
    // Justin Herman / Embarcadero Plaza — the M4 drone staging point (world ≈ 203, -200).
    id: 'STAGE-EMB',
    kind: 'staging',
    name: 'Embarcadero Plaza staging',
    address: 'Embarcadero Plaza, The Embarcadero & Market St',
    lat: 37.795302,
    lon: -122.395695,
    units: { engine: 3, truck: 1, usar: 2, ambulance: 2, police: 6 },
  },
  {
    // Open apron in front of the Pier 27 cruise terminal (used as an emergency landing zone).
    id: 'HELI-P27',
    kind: 'helipad',
    name: 'Pier 27 landing zone',
    address: 'Pier 27, The Embarcadero & Lombard St',
    lat: 37.8047,
    lon: -122.4022,
    units: { helicopter: 2 },
  },
];

export const FACILITIES: Facility[] = DEFS.map((d) => {
  const [x, z] = project(d.lat, d.lon);
  return { ...d, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
});

export const facilityById = (id: string): Facility | undefined => FACILITIES.find((f) => f.id === id);

/** Default unit totals across all facilities. */
export function defaultUnitTotals(list: Facility[] = FACILITIES): Partial<Record<UnitType, number>> {
  const out: Partial<Record<UnitType, number>> = {};
  for (const f of list) for (const [k, v] of Object.entries(f.units ?? {})) out[k as UnitType] = (out[k as UnitType] ?? 0) + (v ?? 0);
  return out;
}

/** Facilities that normally field a unit type (for fallbacks when Argon picks an odd base). */
export function facilitiesFor(type: UnitType, list: Facility[] = FACILITIES): Facility[] {
  return list.filter((f) => (f.units?.[type] ?? 0) > 0);
}
