/**
 * Site ground motion = BSSA14 median × spatially correlated within-event residual, plus liquefaction.
 *
 * Residuals (ln units):
 *   ε_A(p), ε_B(p): unit-variance correlated Gaussian fields (rng.ts), each a mix of two octaves with
 *   correlation lengths 1.5 km (65 % of variance) and 0.45 km (35 %) — Jayaram & Baker (2009) find
 *   PGA correlation ranges of a few km; the shorter octave gives block-to-block texture inside our ~3 km city.
 *     ln PGA = median + σ_A · (ε_A − ⟨ε_A⟩)                                   + 0.10 · ζ₁
 *     ln PGV = median + σ_V · (ρ (ε_A − ⟨ε_A⟩) + √(1−ρ²) (ε_B − ⟨ε_B⟩))      + 0.10 · ζ₂
 *   ⟨·⟩ is the mean over the city's buildings: the scenario represents a median event (inter-event term 0,
 *   as in USGS scenario ShakeMaps) and the field only redistributes shaking spatially, so the calibrated
 *   area-average does not drift with the seed. ζ are small independent per-building terms.
 *   Because the field is correlated over ~km and its city mean is removed, the spread actually realised across
 *   ~3 km of city is much smaller than σ: E[var(ε − ⟨ε⟩)] = 1 − mean over building pairs of ρ(d_ij), with
 *   ρ(d) = Σ w_k exp(−d²/2ℓ_k²) (the random-Fourier-feature covariance). residualSpread() returns that factor
 *   (≈ 0.58 for this city → realised σ_lnPGA ≈ 0.26); damage.ts uses it so that capacity-side β plus the sampled
 *   demand spread add back up to HAZUS's total β.
 *
 * Liquefaction (onFill sites only): P_liq from HAZUS (gmpe.ts), gated by a ramp on shaking intensity
 * (MMI 7.0 → 7.6, i.e. "≥ ~7.5"), sampled with a 300 m correlated field so whole blocks fail together.
 * A liquefied site's reported intensity is raised by +1.0 MMI: liquefaction, sand boils and lateral
 * spreading are themselves MMI IX–X diagnostics (Wood & Neumann 1931; 1906 Boatwright & Bundock 2005
 * intensities on SF made ground are IX–X).
 */
import type { CityData, QuakeScenario } from '../../contracts';
import { createGaussianField, hash2, hashString, mulberry32, normCdf, type GaussianField } from './rng';
import { medianMotion, mmiFrom, liquefactionProbability, SIGMA_LN_PGA, SIGMA_LN_PGV, RHO_PGA_PGV } from './gmpe';
import { siteTiming, type SiteTiming, type SourceContext } from './timing';
import { buildingGeo, siteAt } from './spatial';
import { worldToKm } from './regional';

export const LIQ_MMI_BUMP = 1.0;

export interface ResidualFields {
  a: GaussianField;
  b: GaussianField;
  liq: GaussianField;
  meanA: number;
  meanB: number;
}

const residualCache = new WeakMap<CityData, Map<number, ResidualFields>>();

/** Octaves (correlation length, variance weight) of the PGA / PGV residual fields. */
const OCTAVES = [
  { lengthKm: 1.5, weight: 0.65 },
  { lengthKm: 0.45, weight: 0.35 },
];

const spreadCache = new WeakMap<CityData, number>();

/**
 * √E[var(ε − ⟨ε⟩)] over the city's buildings for a unit-variance field with the OCTAVES covariance: the share of
 * σ that the residual field actually realises inside the city (deterministic Monte Carlo over 40k building pairs).
 */
export function residualSpread(city: CityData): number {
  const hit = spreadCache.get(city);
  if (hit !== undefined) return hit;
  const geo = buildingGeo(city);
  const n = city.buildings.length;
  let v = 1;
  if (n > 1) {
    const rng = mulberry32(0x5e1f);
    const wsum = OCTAVES.reduce((a, o) => a + o.weight, 0);
    const pairs = 40000;
    let acc = 0;
    for (let k = 0; k < pairs; k++) {
      const i = Math.floor(rng() * n);
      const j = Math.floor(rng() * n);
      const [e1, n1] = worldToKm(geo.cx[i], geo.cz[i]);
      const [e2, n2] = worldToKm(geo.cx[j], geo.cz[j]);
      const d2 = (e1 - e2) ** 2 + (n1 - n2) ** 2;
      for (const o of OCTAVES) acc += (o.weight / wsum) * Math.exp(-d2 / (2 * o.lengthKm * o.lengthKm));
    }
    v = Math.max(0, 1 - acc / pairs);
  }
  const s = Math.sqrt(v);
  spreadCache.set(city, s);
  return s;
}

/**
 * Seed of the residual field for a scenario: within-event residuals differ from one earthquake to the next,
 * so the scenario id is mixed in (building capacities stay tied to the plain seed).
 */
export function fieldSeed(seed: number, scenarioId: string): number {
  return hash2(seed >>> 0, hashString(scenarioId));
}

export function residualFields(city: CityData, seed: number): ResidualFields {
  let m = residualCache.get(city);
  if (!m) residualCache.set(city, (m = new Map()));
  const hit = m.get(seed);
  if (hit) return hit;
  const a = createGaussianField((seed ^ 0x5eed0a) >>> 0, OCTAVES);
  const b = createGaussianField((seed ^ 0x5eed0b) >>> 0, OCTAVES);
  const liq = createGaussianField((seed ^ 0x11c0e) >>> 0, [{ lengthKm: 0.3, weight: 1 }]);
  const geo = buildingGeo(city);
  let sa = 0;
  let sb = 0;
  const n = city.buildings.length;
  for (let i = 0; i < n; i++) {
    const [e, nn] = worldToKm(geo.cx[i], geo.cz[i]);
    sa += a(e, nn);
    sb += b(e, nn);
  }
  const f: ResidualFields = { a, b, liq, meanA: n ? sa / n : 0, meanB: n ? sb / n : 0 };
  m.set(seed, f);
  return f;
}

export interface SiteMotion {
  pgaG: number;
  pgvCms: number;
  /** MMI from shaking alone (before any ground-failure bump). */
  mmiShaking: number;
  /** Probability that this (fill) site liquefies. */
  pLiq: number;
  /** Correlated uniform used to decide liquefaction (liquefied ⇔ uLiq < pLiq). */
  uLiq: number;
  timing: SiteTiming;
}

const liqRamp = (mmi: number) => Math.max(0, Math.min(1, (mmi - 7.0) / 0.6));

/**
 * Ground motion at world (x, z). `zeta` are the independent per-building terms (0 for map grids).
 */
export function siteMotion(
  src: SourceContext,
  fields: ResidualFields,
  x: number,
  z: number,
  vs30: number,
  fillFraction: number,
  zeta: [number, number] = [0, 0],
): SiteMotion {
  const [e, n] = worldToKm(x, z);
  const t = siteTiming(src, e, n);
  const med = medianMotion(src.M, t.rjb, t.rrup, vs30, src.mech, src.depthKm);
  const ea = fields.a(e, n) - fields.meanA;
  const eb = fields.b(e, n) - fields.meanB;
  const lnPga = med.lnPga + SIGMA_LN_PGA * ea + 0.1 * zeta[0];
  const lnPgv = med.lnPgv + SIGMA_LN_PGV * (RHO_PGA_PGV * ea + Math.sqrt(1 - RHO_PGA_PGV ** 2) * eb) + 0.1 * zeta[1];
  const pgaG = Math.exp(lnPga);
  const pgvCms = Math.exp(lnPgv);
  const mmiShaking = mmiFrom(pgaG, pgvCms);
  const pLiq = fillFraction > 0 ? fillFraction * liquefactionProbability(pgaG, src.M) * liqRamp(mmiShaking) : 0;
  const uLiq = normCdf(fields.liq(e, n));
  return { pgaG, pgvCms, mmiShaking, pLiq, uLiq, timing: t };
}

// ───────────────────────────── ShakeMap grid for mmiAt ─────────────────────────────

interface MmiGrid {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  v: Float32Array;
}

const gridCache = new WeakMap<CityData, Map<string, MmiGrid>>();

function gridKey(sc: QuakeScenario, seed: number): string {
  const [lon, lat, d] = sc.event.geometry.coordinates;
  return `${sc.id}|${lon}|${lat}|${d}|${sc.event.properties.mag}|${seed}`;
}

/** MMI expected at a point on the overlay: shaking MMI + expected ground-failure bump on fill. */
function pointMmi(city: CityData, src: SourceContext, fields: ResidualFields, x: number, z: number): number {
  const site = siteAt(city, buildingGeo(city), x, z);
  const m = siteMotion(src, fields, x, z, site.vs30, site.fill);
  return Math.min(10, m.mmiShaking + LIQ_MMI_BUMP * m.pLiq);
}

export function mmiGridLookup(city: CityData, sc: QuakeScenario, src: () => SourceContext, seed: number, x: number, z: number): number {
  let m = gridCache.get(city);
  if (!m) gridCache.set(city, (m = new Map()));
  const key = gridKey(sc, seed);
  let g = m.get(key);
  if (!g) {
    const s = src();
    const fields = residualFields(city, fieldSeed(seed, sc.id));
    const bb = buildingGeo(city).bounds;
    const margin = 500;
    const step = 40;
    const x0 = bb.minX - margin;
    const z0 = bb.minZ - margin;
    const nx = Math.max(2, Math.ceil((bb.maxX - bb.minX + 2 * margin) / step) + 1);
    const nz = Math.max(2, Math.ceil((bb.maxZ - bb.minZ + 2 * margin) / step) + 1);
    const v = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = pointMmi(city, s, fields, x0 + i * step, z0 + j * step);
    g = { x0, z0, step, nx, nz, v };
    m.set(key, g);
  }
  const fx = (x - g.x0) / g.step;
  const fz = (z - g.z0) / g.step;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return pointMmi(city, src(), residualFields(city, fieldSeed(seed, sc.id)), x, z);
  const i = Math.min(g.nx - 2, Math.floor(fx));
  const j = Math.min(g.nz - 2, Math.floor(fz));
  const tx = fx - i;
  const tz = fz - j;
  const v = g.v;
  const a = v[j * g.nx + i] * (1 - tx) + v[j * g.nx + i + 1] * tx;
  const b = v[(j + 1) * g.nx + i] * (1 - tx) + v[(j + 1) * g.nx + i + 1] * tx;
  return a * (1 - tz) + b * tz;
}
