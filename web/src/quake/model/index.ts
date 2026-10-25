/**
 * Argus earthquake model — pure TypeScript, no three.js.
 *
 * Pipeline for run(city, scenario, seed):
 *   1. Source: magnitude, mechanism, finite-fault trace, rupture velocity          (timing.ts, regional.ts)
 *   2. Per building: R_JB / R_rup to the trace, P & S arrivals with a propagating rupture front,
 *      strong-shaking duration                                                   (timing.ts)
 *   3. Ground motion: BSSA14 PGA/PGV with nonlinear Vs30 site term + spatially correlated residual,
 *      Worden (2012) MMI, HAZUS liquefaction on historic fill                    (gmpe.ts, field.ts)
 *   4. Damage: HAZUS fragility — inelastic spectral displacement at the building's own period for mid/high-rise
 *      frames (spectral.ts), equivalent PGA for wood / URM / low-rise (+ soft-story / parapet / liquefaction /
 *      landmark modifiers, κ = 1.4 calibration); one fate per building (parts follow their anchor); collapse,
 *      visual parameters, fire ignition, casualties, trapped                (spectral.ts, fragility.ts, damage.ts)
 *   5. Road blockage by debris zones                                            (roads.ts)
 *   6. ShakeAlert timing and summary stats
 * Everything random flows from `seed` through per-building hashed streams, so results are reproducible
 * and independent of iteration order (building capacities depend on the seed only; the ground-motion
 * residual field also mixes in the scenario id).
 *
 * Calibration (scripts/quake-test.mjs, real city.json, 5689 buildings, seed 1976, night; 12-seed range in brackets):
 *   1906 repeat   MMI median 8.2 (fill 8.8, max 9.9); 18 % extensive+ (1039 [800–1186]), 4.4 % complete; 32
 *                 collapses [12–38] — Jackson Sq, Chinatown, Nob Hill soft-story wood, on fill 9; mostly soft-story
 *                 wood, unretrofitted URM, pre-code C3. Core (1,902 records): 8 % complete. High-rises ≥ 15 st:
 *                 modern ones 73 % slight/moderate, none complete; pre/low-code 2 complete (a 1930 infilled frame).
 *                 14 fires. ShakeAlert blind zone (−1.8 s). Observed 1906: MMI VIII on firm ground, IX–X on made
 *                 ground (Boatwright & Bundock 2005); brick buildings on fill failed; steel-frame towers stood.
 *                 HAZUS 1906-repeat study (Kircher et al. 2006): ≈ 10 % of the region's commercial buildings
 *                 extensive/complete, SF the hardest-hit county.
 *   HayWired      MMI median 7.2 (fill 8.4); 4.5 % extensive+, 3 collapses [1–37], mainly URM on fill.
 *   Loma Prieta   MMI median 6.3 (fill 6.8); 7 extensive+ (0.1 %), 0 collapses (0–1 across seeds); ~22 s warning.
 *                 Observed 1989: MMI VI–VII downtown, VII–VIII on waterfront fill, little building damage.
 * Road blockages list only segments with ≥ 50 % of the carriageway covered (1906: 308, 174 of them impassable).
 * See each file's header for formulas, coefficients and references;
 * scripts/quake-test.mjs prints the calibration tables against 1906 / 1989 observations.
 */
import type { BuildingShaking, CityData, QuakeModel, QuakeResult, QuakeScenario } from '../../contracts';
import { CITY_ORIGIN } from '../../geo';
import { geoToKm } from './regional';
import { medianMotion, mmiFrom } from './gmpe';
import { makeSource, sourceContext, siteTiming, strongDuration, shakeAlertIssuedAt, type SourceContext, type SourceParams } from './timing';
import { residualFields, fieldSeed, siteMotion, mmiGridLookup, LIQ_MMI_BUMP, type SiteMotion } from './field';
import { buildingGeo, buildingsNear, siteAt } from './spatial';
import { roadIndex, towardNearestStreet, computeBlockages, type DebrisSource } from './roads';
import { computeDamage, occupantsAt } from './damage';
import { gaussian, streamFor } from './rng';
import { exceedanceFor } from './damage';
import {
  PRESET_SPECS,
  buildUsgsEvent,
  customEventId,
  originTimeMs,
  placeName,
  syntheticTrace,
  wellsCoppersmithSrlKm,
  wellsCoppersmithWidthKm,
  type ArgusScenario,
  type EventImpact,
  type ScenarioSpec,
} from './scenarios';

export type { ArgusScenario } from './scenarios';

export const DEFAULT_SEED = 1976;

/** Bay Area population centres used for the PAGER-style alert proxy. */
const POPULATED: [number, number][] = [
  [CITY_ORIGIN.lat, CITY_ORIGIN.lon], // downtown SF
  [37.7449, -122.4194], // SF Mission
  [37.8044, -122.2712], // Oakland
  [37.8716, -122.2727], // Berkeley
  [37.6688, -122.0808], // Hayward
  [37.5485, -121.9886], // Fremont
  [37.3382, -121.8863], // San Jose
  [37.4419, -122.143], // Palo Alto
  [37.563, -122.3255], // San Mateo
  [37.6879, -122.4702], // Daly City
  [36.9741, -122.0308], // Santa Cruz
  [36.9102, -121.7569], // Watsonville
  [37.9735, -122.5311], // San Rafael
  [38.4404, -122.7141], // Santa Rosa
  [37.9101, -122.0652], // Walnut Creek
];

/** Median MMI at a lat/lon for a given Vs30 (no residual). */
function medianMmiAtGeo(src: SourceContext, lat: number, lon: number, vs30: number): number {
  const [e, n] = geoToKm(lat, lon);
  const t = siteTiming(src, e, n);
  const m = medianMotion(src.M, t.rjb, t.rrup, vs30, src.mech, src.depthKm);
  return mmiFrom(Math.exp(m.lnPga), Math.exp(m.lnPgv));
}

function impactOf(src: SourceContext): EventImpact {
  const populatedMmi = Math.max(...POPULATED.map(([la, lo]) => medianMmiAtGeo(src, la, lo, 300)));
  // Max ShakeMap intensity: soft soil right on the fault (1 km off the trace / epicentre).
  const f = src.fault;
  const rjb = f.pointSource ? 0 : 1;
  const rrup = f.pointSource ? src.depthKm : Math.sqrt(rjb * rjb + f.ztorKm * f.ztorKm);
  const m = medianMotion(src.M, rjb, rrup, 250, src.mech, src.depthKm);
  const maxMmi = Math.min(10, mmiFrom(Math.exp(m.lnPga), Math.exp(m.lnPgv)) + 0.3);
  return { populatedMmi, maxMmi };
}

function scenarioFromSpec(spec: ScenarioSpec): ArgusScenario {
  const trace = spec.trace.map(([lat, lon]) => [lon, lat] as [number, number]);
  const params: SourceParams = {
    M: spec.mag,
    lat: spec.lat,
    lon: spec.lon,
    depthKm: spec.depthKm,
    trace,
    ztorKm: spec.ztorKm,
    mech: spec.mechanism,
  };
  const event = buildUsgsEvent({
    id: spec.eventId,
    mag: spec.mag,
    lat: spec.lat,
    lon: spec.lon,
    depthKm: spec.depthKm,
    localHour: spec.localHour,
    impact: impactOf(makeSource(params)),
  });
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    event,
    ruptureTrace: trace,
    ztorKm: spec.ztorKm,
    localHour: spec.localHour,
    mechanism: spec.mechanism,
    ruptureVelocityKmS: 2.8,
  };
}

/** Copy of a scenario happening at another local hour (re-dates the USGS origin time consistently). */
export function scenarioAtHour<T extends QuakeScenario>(s: T, localHour: number): T {
  const time = originTimeMs(localHour);
  const dt = s.event.properties.updated - s.event.properties.time;
  return {
    ...s,
    localHour,
    event: { ...s.event, properties: { ...s.event.properties, time, updated: time + dt } },
  };
}

/** Least-squares plane through neighbouring base elevations → downhill unit vector and slope (m/m). */
function localSlope(city: CityData, geo: ReturnType<typeof buildingGeo>, i: number, scratch: number[]): { dir: [number, number]; slope: number; n60: number } {
  scratch.length = 0;
  const near = buildingsNear(geo, geo.cx[i], geo.cz[i], 70, scratch);
  const b0 = city.buildings[i].baseElevation;
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0, n60 = 0, cnt = 0;
  for (const j of near) {
    if (j === i) continue;
    const dx = geo.cx[j] - geo.cx[i];
    const dz = geo.cz[j] - geo.cz[i];
    if (Math.sqrt(dx * dx + dz * dz) <= 60) n60++;
    const dy = city.buildings[j].baseElevation - b0;
    if (!Number.isFinite(dy)) continue;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
    sxy += dx * dy;
    szy += dz * dy;
    cnt++;
  }
  const det = sxx * szz - sxz * sxz;
  if (cnt < 3 || Math.abs(det) < 1e-6) return { dir: [0, 0], slope: 0, n60 };
  const gx = (szz * sxy - sxz * szy) / det;
  const gz = (sxx * szy - sxz * sxy) / det;
  const g = Math.sqrt(gx * gx + gz * gz);
  if (g < 1e-4) return { dir: [0, 0], slope: 0, n60 };
  return { dir: [-gx / g, -gz / g], slope: Math.min(g, 0.5), n60 };
}

/** Index of each record's structural anchor (itself unless it is a building:part piece with a known parent). */
const anchorCache = new WeakMap<CityData, Int32Array>();
function anchorIndex(city: CityData): Int32Array {
  const hit = anchorCache.get(city);
  if (hit) return hit;
  const byId = new Map<string, number>();
  city.buildings.forEach((b, i) => byId.set(b.id, i));
  const out = Int32Array.from(city.buildings, (b, i) => (b.parentId ? (byId.get(b.parentId) ?? i) : i));
  anchorCache.set(city, out);
  return out;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Demand scales at which the blind prediction is also evaluated (predictedExceedanceK). */
export const PREDICTION_SCALES = [0.5, 0.71, 1, 1.41, 2] as const;

/** Residual-free fields: the median ground motion a predictor can compute before any observation. */
const ZERO_FIELDS = { a: () => 0, b: () => 0, liq: () => 0, meanA: 0, meanB: 0 };

/**
 * Hidden (truth-only) capacity factor per building: ~12 % are stronger than recorded (unrecorded retrofit,
 * conservative construction), ~15 % weaker (unpermitted alterations, deterioration, poor workmanship).
 * Demand is divided by this factor in the truth world only, so the blind prediction cannot know it.
 */
function hiddenCapacity(seed: number, key: string): number {
  const r = streamFor(seed, key, 'hidden-capacity');
  const u = r();
  if (u < 0.12) return 1.3 + 0.25 * r();
  if (u < 0.27) return 0.6 + 0.15 * r();
  return 0.92 + 0.16 * r();
}

export function createQuakeModel(): QuakeModel & { lastRunMs: number } {
  const scenarios: ArgusScenario[] = PRESET_SPECS.map(scenarioFromSpec);
  /** Seed last used per scenario id, so the ShakeMap overlay matches the run on screen. */
  const lastSeed = new Map<string, number>();
  const srcCache = new WeakMap<QuakeScenario, SourceContext>();
  const srcOf = (s: QuakeScenario) => {
    let c = srcCache.get(s);
    if (!c) srcCache.set(s, (c = sourceContext(s)));
    return c;
  };

  const model = {
    scenarios,
    lastRunMs: 0,

    run(city: CityData, scenario: QuakeScenario, seed = DEFAULT_SEED): QuakeResult {
      const t0 = now();
      lastSeed.set(scenario.id, seed);
      const src = srcOf(scenario);
      const fields = residualFields(city, fieldSeed(seed, scenario.id));
      const geo = buildingGeo(city);
      const ridx = roadIndex(city);
      const hour = scenario.localHour;
      const n = city.buildings.length;
      const shaking: BuildingShaking[] = new Array(n);
      const damage: QuakeResult['damage'] = new Array(n);
      const debris: DebrisSource[] = [];
      const ignBase = new Float64Array(n);
      const ignW = new Float64Array(n);
      const byState: [number, number, number, number, number] = [0, 0, 0, 0, 0];
      let collapsed = 0, fires = 0, trapped = 0, maxMmi = 0, occupants = 0, tEnd = 0;
      const scratch: number[] = [];

      // Pass 1 — ground motion at every record (truth: median × correlated residual; prediction: median only).
      const motion: SiteMotion[] = new Array(n);
      const predicted: SiteMotion[] = new Array(n);
      const liq = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const b = city.buildings[i];
        const x = geo.cx[i];
        const z = geo.cz[i];
        const vs30 = b.vs30 > 0 ? b.vs30 : 300;
        const rz = streamFor(seed, b.parentId ?? b.id, 'zeta');
        const m = siteMotion(src, fields, x, z, vs30, b.onFill ? 1 : 0, [gaussian(rz), gaussian(rz)]);
        motion[i] = m;
        predicted[i] = siteMotion(src, ZERO_FIELDS, x, z, vs30, b.onFill ? 1 : 0);
        const liquefied = b.onFill && m.uLiq < m.pLiq;
        liq[i] = liquefied ? 1 : 0;
        const mmi = Math.min(10, m.mmiShaking + (liquefied ? LIQ_MMI_BUMP : 0));
        const dur = strongDuration(src, m.timing, vs30);
        shaking[i] = {
          distanceKm: Math.round(m.timing.rrup * 1000) / 1000,
          pgaG: Math.round(m.pgaG * 10000) / 10000,
          pgvCms: Math.round(m.pgvCms * 100) / 100,
          mmi: Math.round(mmi * 100) / 100,
          pArrivalS: Math.round(m.timing.pArrivalS * 100) / 100,
          sArrivalS: Math.round(m.timing.sArrivalS * 100) / 100,
          durationS: Math.round(dur * 10) / 10,
          liquefaction: liquefied,
          vs30,
        };
        maxMmi = Math.max(maxMmi, mmi);
        tEnd = Math.max(tEnd, m.timing.sArrivalS + dur);
      }

      // Pass 2 — damage. building:part pieces take their anchor's structural record and demand (one building,
      // one fate: a tower's podium and crown pieces must not be rated separately from the tower).
      const anchorIdx = anchorIndex(city);
      for (let i = 0; i < n; i++) {
        const b = city.buildings[i];
        const a = anchorIdx[i];
        const sb = city.buildings[a];
        const m = motion[a];
        const sh = shaking[a];
        const nb = localSlope(city, geo, i, scratch);
        // Truth only: what the building database does not know (unrecorded retrofits, unpermitted alterations,
        // deterioration, workmanship). Expressed as a capacity factor applied to the demand.
        const cap = hiddenCapacity(seed, sb.parentId ?? sb.id);
        const dmg = computeDamage({
          b,
          structural: sb,
          pgaG: m.pgaG / cap,
          pgvCms: m.pgvCms / cap,
          vs30: sh.vs30 ?? 300,
          magnitude: src.M,
          liquefied: liq[a] === 1,
          sArrivalS: shaking[i].sArrivalS,
          durationS: shaking[i].durationS,
          hour,
          seed,
          downhill: nb.dir,
          slope: nb.slope,
          toStreet: towardNearestStreet(ridx, geo.cx[i], geo.cz[i]),
          neighbours60: nb.n60,
          footprintArea: geo.area[i],
        });
        const d = dmg.damage;
        // Blind prediction (what an operations centre could compute from the USGS event alone).
        const pm = predicted[a];
        d.predictedExceedance = exceedanceFor({
          b,
          structural: sb,
          pgaG: pm.pgaG,
          pgvCms: pm.pgvCms,
          vs30: sh.vs30 ?? 300,
          magnitude: src.M,
          liquefied: pm.pLiq > 0.5,
          sArrivalS: shaking[i].sArrivalS,
          durationS: shaking[i].durationS,
          hour,
          seed,
          downhill: nb.dir,
          slope: nb.slope,
          toStreet: towardNearestStreet(ridx, geo.cx[i], geo.cz[i]),
          neighbours60: nb.n60,
          footprintArea: geo.area[i],
        }).ex.map((v) => Math.round(v * 1000) / 1000) as [number, number, number, number];
        // Same blind prediction at a few demand scales (for spatial correction from observations).
        const k: number[] = [];
        for (const sc of PREDICTION_SCALES) {
          const ex = exceedanceFor({
            b, structural: sb, pgaG: pm.pgaG * sc, pgvCms: pm.pgvCms * sc, vs30: sh.vs30 ?? 300, magnitude: src.M,
            liquefied: pm.pLiq > 0.5, sArrivalS: shaking[i].sArrivalS, durationS: shaking[i].durationS, hour, seed,
            downhill: nb.dir, slope: nb.slope, toStreet: [0, 0], neighbours60: nb.n60, footprintArea: geo.area[i],
          }).ex;
          for (const v of ex) k.push(Math.round(v * 1000) / 1000);
        }
        d.predictedExceedanceK = k;
        damage[i] = d;
        ignBase[i] = dmg.ignBase;
        ignW[i] = dmg.ignWeighted;
        if (d.debrisRadius > 0) debris.push({ building: i, radius: d.debrisRadius });
        byState[d.state]++;
        if (d.collapsed) collapsed++;
        trapped += d.trappedEstimate;
        occupants += occupantsAt(b, hour);
      }

      // Fire: keep the HAZUS expected ignition count, distribute it by the location weights.
      let sumBase = 0;
      let sumW = 0;
      for (let i = 0; i < n; i++) {
        sumBase += ignBase[i];
        sumW += ignW[i];
      }
      const k = sumW > 0 ? sumBase / sumW : 0;
      for (let i = 0; i < n; i++) {
        if (ignW[i] <= 0) continue;
        const p = 1 - Math.exp(-ignW[i] * k);
        if (streamFor(seed, city.buildings[i].id, 'fire')() < p) {
          damage[i].fire = true;
          fires++;
        }
      }

      const roads = computeBlockages(city, geo, debris);

      // ShakeAlert at the city centre (world 0,0 = CITY_ORIGIN).
      const centre = siteTiming(src, 0, 0);
      const issuedAtS = shakeAlertIssuedAt(src);
      const cSite = siteAt(city, geo, 0, 0);
      const cMed = medianMotion(src.M, centre.rjb, centre.rrup, cSite.vs30, src.mech, src.depthKm);
      const expectedMmi = mmiFrom(Math.exp(cMed.lnPga), Math.exp(cMed.lnPgv));
      if (n === 0) tEnd = centre.sArrivalS + strongDuration(src, centre, cSite.vs30);

      const result: QuakeResult = {
        scenario,
        shaking,
        damage,
        roads,
        stats: {
          buildings: n,
          byState,
          collapsed,
          fires,
          trappedEstimate: trapped,
          blockedSegments: roads.length,
          maxMmi: Math.round(maxMmi * 10) / 10,
          occupantsAtTime: Math.round(occupants),
        },
        shakeAlert: {
          issuedAtS: Math.round(issuedAtS * 10) / 10,
          warningSecondsAtCentre: Math.round((centre.sArrivalS - issuedAtS) * 10) / 10,
          expectedMmi: Math.round(expectedMmi * 10) / 10,
        },
        durationS: Math.ceil(Math.max(tEnd, issuedAtS + 10) + 20),
      };
      model.lastRunMs = now() - t0;
      return result;
    },

    customScenario(lat: number, lon: number, depthKm: number, mag: number, localHour: number): QuakeScenario {
      const M = Math.max(3, Math.min(9.5, mag));
      const depth = Math.max(0, Math.min(60, depthKm));
      const finite = M > 6.5;
      const trace = finite ? syntheticTrace(lat, lon, M).map(([la, lo]) => [lo, la] as [number, number]) : undefined;
      const ztorKm = finite ? Math.max(0, depth - wellsCoppersmithWidthKm(M) / 2) : depth;
      const id = customEventId(lat, lon, depth, M);
      const params: SourceParams = { M, lat, lon, depthKm: depth, trace, ztorKm, mech: 'SS' };
      const event = buildUsgsEvent({ id, mag: M, lat, lon, depthKm: depth, localHour, impact: impactOf(makeSource(params)) });
      const place = placeName(lat, lon);
      const s: ArgusScenario = {
        id: `custom_${id}`,
        name: `Custom M${M.toFixed(1)} — ${place}`,
        description: finite
          ? `User-defined M${M.toFixed(1)} strike-slip event, ${depth.toFixed(0)} km deep, modelled as a ~${wellsCoppersmithSrlKm(M).toFixed(0)} km bilateral rupture striking N35W (Wells & Coppersmith 1994).`
          : `User-defined M${M.toFixed(1)} event, ${depth.toFixed(0)} km deep, modelled as a point source.`,
        event,
        ruptureTrace: trace,
        ztorKm,
        localHour,
        mechanism: 'SS',
        ruptureVelocityKmS: 2.8,
      };
      return s;
    },

    mmiAt(city: CityData, scenario: QuakeScenario, x: number, z: number): number {
      return mmiGridLookup(city, scenario, () => srcOf(scenario), lastSeed.get(scenario.id) ?? DEFAULT_SEED, x, z);
    },
  };
  return model;
}
