/**
 * Formatting + domain vocabulary for the HUD: MMI scale & official USGS ShakeMap colours,
 * HAZUS structure types, damage states, PAGER alert colours, time/coordinate formatting.
 */
import type { BuildingRecord, BuildingUse, CodeLevel, District, StructureType, UsgsEvent } from '../contracts';
import { CITY_ORIGIN, haversineKm } from '../geo';

// ───────────────────────────── MMI / ShakeMap ─────────────────────────────

export interface MmiLevel {
  value: number; // 1..10
  roman: string;
  shaking: string; // perceived shaking (ShakeMap legend)
  damage: string; // potential damage (ShakeMap legend)
  color: string; // official ShakeMap v4 colour
  ink: string; // readable text colour on top of `color`
  pga: string; // ShakeMap v4 legend PGA (%g)
  pgv: string; // ShakeMap v4 legend PGV (cm/s)
}

/** USGS ShakeMap intensity scale (Worden et al. 2012 legend values). */
export const MMI_SCALE: MmiLevel[] = [
  { value: 1, roman: 'I', shaking: 'Not felt', damage: 'None', color: '#FFFFFF', ink: '#2B2F35', pga: '< 0.05', pgv: '< 0.02' },
  { value: 2, roman: 'II', shaking: 'Weak', damage: 'None', color: '#BFCCFF', ink: '#232B45', pga: '0.3', pgv: '0.13' },
  { value: 3, roman: 'III', shaking: 'Weak', damage: 'None', color: '#A0E6FF', ink: '#163845', pga: '0.3', pgv: '0.13' },
  { value: 4, roman: 'IV', shaking: 'Light', damage: 'None', color: '#80FFFF', ink: '#0F3D3D', pga: '2.8', pgv: '1.4' },
  { value: 5, roman: 'V', shaking: 'Moderate', damage: 'Very light', color: '#7AFF93', ink: '#123D1C', pga: '6.2', pgv: '4.7' },
  { value: 6, roman: 'VI', shaking: 'Strong', damage: 'Light', color: '#FFFF00', ink: '#3D3A00', pga: '11.5', pgv: '9.6' },
  { value: 7, roman: 'VII', shaking: 'Very strong', damage: 'Moderate', color: '#FFC800', ink: '#3F2D00', pga: '21.5', pgv: '20' },
  { value: 8, roman: 'VIII', shaking: 'Severe', damage: 'Moderate / heavy', color: '#FF9100', ink: '#3A1D00', pga: '40.1', pgv: '41' },
  { value: 9, roman: 'IX', shaking: 'Violent', damage: 'Heavy', color: '#FF0000', ink: '#FFFFFF', pga: '74.7', pgv: '86' },
  { value: 10, roman: 'X+', shaking: 'Extreme', damage: 'Very heavy', color: '#C80000', ink: '#FFFFFF', pga: '> 139', pgv: '> 178' },
];

/** Integer MMI bin (ShakeMap rounds to the nearest whole intensity), clamped to I..X. */
export function mmiBin(mmi: number): number {
  if (!Number.isFinite(mmi)) return 1;
  return Math.min(10, Math.max(1, Math.round(mmi)));
}

export function mmiLevel(mmi: number): MmiLevel {
  return MMI_SCALE[mmiBin(mmi) - 1];
}

// ───────────────────────────── Damage states (HAZUS) ─────────────────────────────

export const DAMAGE_STATES = [
  { key: 'none', label: 'None', color: 'var(--ag-ds0)' },
  { key: 'slight', label: 'Slight', color: 'var(--ag-ds1)' },
  { key: 'moderate', label: 'Moderate', color: 'var(--ag-ds2)' },
  { key: 'extensive', label: 'Extensive', color: 'var(--ag-ds3)' },
  { key: 'complete', label: 'Complete', color: 'var(--ag-ds4)' },
] as const;

// ───────────────────────────── PAGER alert colours ─────────────────────────────

export type AlertLevel = 'green' | 'yellow' | 'orange' | 'red';

export const ALERT_COLORS: Record<AlertLevel, { bg: string; ink: string }> = {
  green: { bg: '#2E9E4F', ink: '#FFFFFF' },
  yellow: { bg: '#F2C40F', ink: '#3A2E00' },
  orange: { bg: '#F07F12', ink: '#FFFFFF' },
  red: { bg: '#D8231F', ink: '#FFFFFF' },
};

/** PAGER alert from the event, or a magnitude-based stand-in when the feed has none. */
export function alertLevelFor(e: UsgsEvent): AlertLevel {
  if (e.properties.alert) return e.properties.alert;
  const m = e.properties.mag;
  if (m >= 6.8) return 'red';
  if (m >= 6.0) return 'orange';
  if (m >= 5.0) return 'yellow';
  return 'green';
}

/** Conventional magnitude-type spelling: feed "mw"/"mww" → "Mw", "ml" → "ML", "md" → "Md", "mb" stays "mb". */
export function fmtMagType(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.startsWith('mw')) return 'Mw';
  if (k === 'ml') return 'ML';
  if (k === 'md') return 'Md';
  if (k === 'ms' || k === 'ms_20') return 'Ms';
  if (k.startsWith('mb')) return 'mb';
  return t || 'M';
}

// ───────────────────────────── Buildings ─────────────────────────────

export const STRUCTURE_LABELS: Record<StructureType, string> = {
  W1: 'Light wood frame',
  W1_SOFT: 'Wood frame, soft first storey',
  W2: 'Commercial wood frame',
  URM: 'Unreinforced masonry',
  RM: 'Reinforced masonry',
  C1: 'Concrete moment frame',
  C2: 'Concrete shear wall',
  C3: 'Concrete frame, masonry infill',
  PC: 'Precast / tilt-up concrete',
  S1: 'Steel moment frame',
  S2: 'Steel braced frame',
  S5: 'Steel frame, masonry infill',
};

/** HAZUS model-building-type code as printed (W1_SOFT is W1 with a soft-story flag). */
export const hazusCode = (s: StructureType): string => (s === 'W1_SOFT' ? 'W1' : s);

export const CODE_LEVEL_LABELS: Record<CodeLevel, string> = {
  pre: 'Pre-code',
  low: 'Low code',
  moderate: 'Moderate code',
  high: 'High code',
};

export const USE_LABELS: Record<BuildingUse, string> = {
  residential: 'Residential',
  mixed: 'Mixed use',
  commercial: 'Commercial',
  office: 'Office',
  retail: 'Retail',
  hotel: 'Hotel',
  civic: 'Civic',
  religious: 'Religious',
  school: 'School',
  industrial: 'Industrial',
  transport: 'Transport',
  parking: 'Parking',
  other: 'Other',
};

export const DISTRICT_LABELS: Record<District, string> = {
  chinatown: 'Chinatown',
  fidi: 'Financial District',
  embarcadero: 'Embarcadero',
  jackson_square: 'Jackson Square',
  nob_hill: 'Nob Hill',
  north_beach: 'North Beach',
  soma: 'SoMa',
  other: 'San Francisco',
};

export const PROVENANCE_LABELS = {
  height: { osm_height: 'OSM', datasf_lidar: 'DataSF LiDAR', osm_levels: 'OSM levels', estimated: 'Estimated' },
  year: { assessor: 'Assessor', osm: 'OSM', estimated: 'Estimated' },
  structure: { assessor: 'Assessor', estimated: 'Estimated' },
} as const;

/** NEHRP site class from Vs30 (m/s). */
export function siteClass(vs30: number): string {
  if (vs30 > 1500) return 'A';
  if (vs30 > 760) return 'B';
  if (vs30 > 360) return 'C';
  if (vs30 > 180) return 'D';
  return 'E';
}

export function buildingTitle(b: BuildingRecord): string {
  return b.name || b.address || `Building ${b.id}`;
}

// ───────────────────────────── Numbers, places, time ─────────────────────────────

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtInt = (n: number): string => intFmt.format(Math.round(n));

/** 12 400 → "12.4k" for tight slots. */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return fmtInt(n);
}

export function fmtLatLon(lat: number, lon: number, digits = 3): string {
  const la = `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Initial bearing from (lat1,lon1) to (lat2,lon2) as a 16-point compass word. */
export function compass(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

/** Epicentral distance (km) from the study-area centre and the epicentre's direction as seen from the city. */
export function eventDistance(e: UsgsEvent): { km: number; dir: string } {
  const [lon, lat] = e.geometry.coordinates;
  return {
    km: haversineKm(CITY_ORIGIN.lat, CITY_ORIGIN.lon, lat, lon),
    dir: compass(CITY_ORIGIN.lat, CITY_ORIGIN.lon, lat, lon),
  };
}

export function fmtKm(km: number): string {
  return km < 10 ? km.toFixed(1) : fmtInt(km);
}

/** Decimal hours → "16:30". */
export function fmtHours(h: number): string {
  const t = ((h % 24) + 24) % 24;
  let hh = Math.floor(t);
  let mm = Math.round((t - hh) * 60);
  if (mm === 60) {
    hh = (hh + 1) % 24;
    mm = 0;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Decimal hours → "16:30:07". */
export function fmtHoursSec(h: number): string {
  const t = ((h % 24) + 24) % 24;
  const total = Math.floor(t * 3600);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** "T+12.4 s" / "T−3.0 s". */
export function fmtSimTime(s: number): string {
  if (!Number.isFinite(s)) return 'T+0.0 s';
  const sign = s < 0 ? '−' : '+';
  const a = Math.abs(s);
  if (a >= 600) return `T${sign}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
  return `T${sign}${a.toFixed(1)} s`;
}

const pacific = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

/** Origin time in Pacific time, USGS-page style: "2026-10-24 16:30:12 PDT". */
export function fmtOriginTime(ms: number): string {
  const parts = Object.fromEntries(pacific.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second} ${parts.timeZoneName ?? 'PT'}`;
}

/** Day/night occupancy blend for a local hour (matches HAZUS 2 am / 2 pm bookends, smooth in between). */
export function occupancyWeightDay(hour: number): number {
  const t = ((hour % 24) + 24) % 24;
  // 1 at 14:00, 0 at 02:00, cosine in between.
  return 0.5 + 0.5 * Math.cos(((t - 14) / 24) * Math.PI * 2);
}

/** Rough nightFactor from local hour, for when no engine env is available (dev page). */
export function nightFactorFor(hour: number): number {
  const t = ((hour % 24) + 24) % 24;
  const ss = (a: number, b: number, x: number) => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return 1 - ss(5.6, 7.2, t) + ss(18.4, 20.0, t);
}
