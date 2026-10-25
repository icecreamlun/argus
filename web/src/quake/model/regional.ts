/**
 * Regional geometry for source-to-site distances.
 *
 * The city frame in geo.ts is a local equirectangular tangent plane (fine over a few km). Faults are
 * 10–500 km away, so here we use an azimuthal-equidistant projection centred on CITY_ORIGIN:
 * distances and bearings from the city are exact, and since every site is within ~3 km of the centre,
 * site-to-fault distances are accurate to well under 0.1 %. Along-trace lengths (used for the rupture
 * front) are measured with the haversine formula on the sphere, so far-away segments are not distorted.
 *
 * Frame: Km2 = [east, north] in km. World metres (x east, z south) → [x/1000, -z/1000].
 */
import { CITY_ORIGIN, haversineKm } from '../../geo';
import { hyp } from './math';

export type Km2 = [number, number];

const R_EARTH = 6371.0088;
const D2R = Math.PI / 180;
const phi0 = CITY_ORIGIN.lat * D2R;
const lam0 = CITY_ORIGIN.lon * D2R;

/** lat/lon (deg) → [east, north] km, azimuthal equidistant about CITY_ORIGIN. */
export function geoToKm(lat: number, lon: number): Km2 {
  const phi = lat * D2R;
  const dl = lon * D2R - lam0;
  const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, cosc)));
  const k = c < 1e-12 ? 1 : c / Math.sin(c);
  return [
    R_EARTH * k * Math.cos(phi) * Math.sin(dl),
    R_EARTH * k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dl)),
  ];
}

/** Inverse of geoToKm → [lat, lon] (deg). */
export function kmToGeo(e: number, n: number): [number, number] {
  const rho = Math.sqrt(e * e + n * n);
  if (rho < 1e-9) return [CITY_ORIGIN.lat, CITY_ORIGIN.lon];
  const c = rho / R_EARTH;
  const lat = Math.asin(Math.cos(c) * Math.sin(phi0) + (n * Math.sin(c) * Math.cos(phi0)) / rho);
  const lon = lam0 + Math.atan2(e * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - n * Math.sin(phi0) * Math.sin(c));
  return [lat / D2R, lon / D2R];
}

/** World metres (x east, z south) → [east, north] km. */
export function worldToKm(x: number, z: number): Km2 {
  return [x / 1000, -z / 1000];
}

/** Destination point from (lat, lon) along an initial bearing (deg clockwise from north) for distKm. */
export function destination(lat: number, lon: number, bearingDeg: number, distKm: number): [number, number] {
  const d = distKm / R_EARTH;
  const th = bearingDeg * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / D2R, l2 / D2R];
}

/** Initial bearing (deg clockwise from north) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}

/**
 * Finite-fault geometry: a surface trace (polyline) with cumulative along-trace distance, the
 * epicentre's along-trace position, and depths. A point source is a single-vertex trace.
 */
export interface FaultGeometry {
  /** Trace vertices in the regional km frame. */
  pts: Km2[];
  /** Along-trace distance (km, haversine) at each vertex. */
  cum: number[];
  /** Total trace length (km). */
  length: number;
  /** Along-trace position (km) of the epicentre's projection onto the trace. */
  epiS: number;
  epi: Km2;
  hypoDepthKm: number;
  ztorKm: number;
  pointSource: boolean;
}

export interface TraceHit {
  /** Joyner–Boore distance: horizontal distance to the surface trace (km). */
  rjb: number;
  /** Along-trace position (km) of the closest point. */
  s: number;
}

export function buildFault(trace: [number, number][] | undefined, epiLat: number, epiLon: number, depthKm: number, ztorKm: number): FaultGeometry {
  const epi = geoToKm(epiLat, epiLon);
  if (!trace || trace.length < 2) {
    return { pts: [epi], cum: [0], length: 0, epiS: 0, epi, hypoDepthKm: depthKm, ztorKm: depthKm, pointSource: true };
  }
  const pts = trace.map(([lon, lat]) => geoToKm(lat, lon));
  const cum = [0];
  for (let i = 1; i < trace.length; i++) {
    cum.push(cum[i - 1] + haversineKm(trace[i - 1][1], trace[i - 1][0], trace[i][1], trace[i][0]));
  }
  const g: FaultGeometry = { pts, cum, length: cum[cum.length - 1], epiS: 0, epi, hypoDepthKm: depthKm, ztorKm, pointSource: false };
  g.epiS = closestOnTrace(g, epi[0], epi[1]).s;
  return g;
}

/** Closest point of the trace to (e, n) km → Rjb and along-trace position. */
export function closestOnTrace(g: FaultGeometry, e: number, n: number): TraceHit {
  const p = g.pts;
  if (p.length === 1) return { rjb: hyp(e - p[0][0], n - p[0][1]), s: 0 };
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0];
    const ay = p[i][1];
    const dx = p[i + 1][0] - ax;
    const dy = p[i + 1][1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((e - ax) * dx + (n - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = hyp(ax + t * dx - e, ay + t * dy - n);
    if (d < best) {
      best = d;
      bestS = g.cum[i] + t * (g.cum[i + 1] - g.cum[i]);
    }
  }
  return { rjb: best, s: bestS };
}

/** Point on the trace at along-trace position s (km). */
export function pointAtS(g: FaultGeometry, s: number): Km2 {
  const { pts, cum } = g;
  if (pts.length === 1) return pts[0];
  if (s <= 0) return pts[0];
  for (let i = 0; i < pts.length - 1; i++) {
    if (s <= cum[i + 1] || i === pts.length - 2) {
      const seg = cum[i + 1] - cum[i];
      const t = seg > 0 ? Math.min(1, (s - cum[i]) / seg) : 0;
      return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
    }
  }
  return pts[pts.length - 1];
}

/** Sample the trace every ~stepKm → [{ p, s }]. */
export function sampleTrace(g: FaultGeometry, stepKm: number): { p: Km2; s: number }[] {
  if (g.pointSource) return [{ p: g.epi, s: 0 }];
  const n = Math.max(2, Math.ceil(g.length / stepKm) + 1);
  const out: { p: Km2; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s = (g.length * i) / (n - 1);
    out.push({ p: pointAtS(g, s), s });
  }
  return out;
}
