/**
 * Source description, wave arrival times, strong-shaking duration and ShakeAlert timing.
 *
 *   P arrival  = R_hypo / Vp, Vp = 6.0 km/s (Bay Area upper-crust average).
 *   S arrival  = t_front(s*) + √(R_JB² + h²) / Vs, Vs = 3.5 km/s, where s* is the closest point of the trace
 *                to the site and t_front(s) = |s − s_epi| / Vr is when the bilateral rupture front reaches it
 *                (Vr = 2.8 km/s ≈ 0.8 Vs; h = hypocentral depth). For a point source this is R_hypo / Vs.
 *   Duration   = ½(D5-75 + D5-95) (Bommer et al. 2009, gmpe.ts) + W, where W is the spread of S arrivals radiated by
 *                the part of the rupture that would, on its own, produce "strong" (≥ 8 cm/s ≈ MMI VI) rock
 *                PGV at the site (BSSA14 PGV at R_JB = distance to that piece of fault):
 *                    W = max_{s: d(s) ≤ R_strong} [ t_front(s) + √(d(s)² + h²)/Vs ] − S arrival.
 *                Long ruptures that sweep past the site therefore shake longer. Results for downtown SF:
 *                1906 ≈ 50–60 s (Lawson 1908: "about 40 s, a lull, then ~25 s more"), HayWired ≈ 20–25 s,
 *                Loma Prieta ≈ 13–15 s (1989 SF accounts: "about 15 seconds").
 *   ShakeAlert = alert issued once P has reached ~4 stations plus processing/delivery latency:
 *                t_alert = √(h² + (d_offshore + 10 km)²) / Vp + 4.5 s
 *                (10 km ≈ distance to the 4th-nearest Bay Area seismic station; offshore events must
 *                first reach the coast). Typical ShakeAlert alert times are 5–10 s after origin
 *                (e.g. 2019 Ridgecrest M7.1 ≈ 7 s). Warning at a site = S arrival − t_alert (≤ 0 = blind zone).
 */
import { geoToKm, sampleTrace, closestOnTrace, buildFault, type FaultGeometry, type Km2 } from './regional';
import { durationD575, durationD595, rockPgv, type Mechanism } from './gmpe';
import { offshoreKm, type ArgusScenario } from './scenarios';
import type { QuakeScenario } from '../../contracts';
import { hyp, hyp3 } from './math';

export const VP = 6.0;
export const VS = 3.5;
export const VR = 2.8;
/** Rock PGV (cm/s) defining "strong" shaking for the duration window. */
const STRONG_PGV = 8;

export interface SourceContext {
  M: number;
  mech: Mechanism;
  depthKm: number;
  fault: FaultGeometry;
  vr: number;
  /** Distance (km) within which a piece of fault alone produces ≥ STRONG_PGV on rock. */
  strongRadiusKm: number;
  samples: { p: Km2; s: number }[];
  epiLat: number;
  epiLon: number;
}

export interface SourceParams {
  M: number;
  lat: number;
  lon: number;
  depthKm: number;
  trace?: [number, number][]; // [lon, lat]
  ztorKm?: number;
  mech?: Mechanism;
  vr?: number;
}

/** Build the source description from raw parameters. */
export function makeSource(p: SourceParams): SourceContext {
  const { M, lat, lon, depthKm } = p;
  const mech = p.mech ?? 'SS';
  const fault = buildFault(p.trace, lat, lon, depthKm, p.ztorKm ?? 0);
  // Bisection for the strong-shaking radius (rock PGV decreases monotonically with distance).
  let strongRadiusKm = 0;
  if (rockPgv(M, 0, mech) >= STRONG_PGV) {
    let lo = 0;
    let hi = 500;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rockPgv(M, mid, mech) >= STRONG_PGV) lo = mid;
      else hi = mid;
    }
    strongRadiusKm = lo;
  }
  return {
    M,
    mech,
    depthKm,
    fault,
    vr: p.vr ?? VR,
    strongRadiusKm,
    // Only fault pieces that can be within the strong radius of some city site matter for the sweep window
    // (the city spans < 5 km around the origin).
    samples: sampleTrace(fault, 2).filter((s) => Math.sqrt(s.p[0] * s.p[0] + s.p[1] * s.p[1]) <= strongRadiusKm + 6),
    epiLat: lat,
    epiLon: lon,
  };
}

/** Source description of a scenario (reads its USGS event + extras). */
export function sourceContext(sc: QuakeScenario): SourceContext {
  const [lon, lat, depthKm] = sc.event.geometry.coordinates;
  const ext = sc as ArgusScenario;
  return makeSource({
    M: sc.event.properties.mag,
    lat,
    lon,
    depthKm,
    trace: sc.ruptureTrace,
    ztorKm: sc.ztorKm,
    mech: ext.mechanism,
    vr: ext.ruptureVelocityKmS,
  });
}

export interface SiteTiming {
  rjb: number;
  rrup: number;
  pArrivalS: number;
  sArrivalS: number;
  /** W: extra strong-shaking time from the rupture sweeping along the fault (s). */
  sweepS: number;
}

export function siteTiming(src: SourceContext, e: number, n: number): SiteTiming {
  const f = src.fault;
  const h = src.depthKm;
  const hit = closestOnTrace(f, e, n);
  const rjb = hit.rjb;
  const rrup = f.pointSource ? Math.sqrt(rjb * rjb + h * h) : Math.sqrt(rjb * rjb + f.ztorKm * f.ztorKm);
  const rhypo = hyp3(e - f.epi[0], n - f.epi[1], h);
  const pArrivalS = rhypo / VP;
  const sArrivalS = Math.abs(hit.s - f.epiS) / src.vr + Math.sqrt(rjb * rjb + h * h) / VS;
  let latest = sArrivalS;
  const rc = Math.max(src.strongRadiusKm, rjb);
  for (const smp of src.samples) {
    const d = hyp(smp.p[0] - e, smp.p[1] - n);
    if (d > rc) continue;
    const t = Math.abs(smp.s - f.epiS) / src.vr + Math.sqrt(d * d + h * h) / VS;
    if (t > latest) latest = t;
  }
  return { rjb, rrup, pArrivalS, sArrivalS, sweepS: latest - sArrivalS };
}

/** Strong-shaking duration (s) at a site. */
export function strongDuration(src: SourceContext, t: SiteTiming, vs30: number): number {
  const ztor = src.fault.ztorKm;
  const d = 0.5 * (durationD575(src.M, t.rrup, vs30, ztor) + durationD595(src.M, t.rrup, vs30, ztor)) + t.sweepS;
  return Math.max(3, Math.min(120, d));
}

/** ShakeAlert issuance time (s after origin). */
export function shakeAlertIssuedAt(src: SourceContext): number {
  const off = offshoreKm(src.epiLat, src.epiLon);
  return hyp(src.depthKm, off + 10) / VP + 4.5;
}

/** Regional km coordinates of a lat/lon (re-export for convenience). */
export function siteKm(lat: number, lon: number): Km2 {
  return geoToKm(lat, lon);
}
