/**
 * Period-dependent demand and HAZUS displacement-based fragility for mid- and high-rise buildings.
 *
 * Why: HAZUS "equivalent-PGA" curves (fragility.ts) bake in one reference spectrum shape, so a 30-storey tower
 * is judged by the same short-period number (PGA) as a 3-storey walk-up. A tall building responds to
 * long-period motion, which falls off with period; driving its fragility with spectral displacement at its own
 * period is the HAZUS capacity-spectrum idea and what loss studies of a 1906 repeat do (Kircher et al. 2006).
 *
 * ── 1. Elastic 5 %-damped spectrum from the site's own PGA and PGV (both BSSA14 + site term + correlated
 *      residual, field.ts): Newmark & Hall (1982) median spectral amplifications
 *        Sa(T) = min(α_A · PGA, α_V · PGV · 2π / T),   α_A = 2.12, α_V = 1.65
 *      and a constant-displacement branch beyond the corner period T_D (Sa ∝ 1/T²):
 *        T_D = 1 + 2.5 (M − 5.7) s, ≥ 1 s   (Faccioli, Paolucci & Rey 2004, Earthquake Spectra 20(2))
 *        → M7.8 ≈ 6.3 s (no tower in the city reaches it), M6.0 ≈ 1.8 s.
 *      Sanity (1906 repeat, downtown PGA 0.38 g, PGV 45 cm/s): Sa(1 s) ≈ 0.48 g, Sa(3 s) ≈ 0.16 g — within the
 *      BSSA14 M7.8 / 15 km / Vs30 ≈ 350 medians (≈ 0.4 g and ≈ 0.13 g).
 *
 * ── 2. Fundamental period: T = 0.1 N for moment frames (S1, C1) — the classic measured-period rule (Goel &
 *      Chopra 1997 regressions sit close to it for SF-height buildings); 0.075 N for braced, wall and infilled
 *      systems (S2, C2, C3, S5, PC2, RM2), which are stiffer. T ≥ 0.2 s.
 *
 * ── 3. Inelastic displacement — FEMA 440 (2005) displacement-coefficient method, Sd = C1 · C2 · Sd_el(T):
 *        C1 = 1 + (R − 1) / (a T²),   a = 130 / 90 / 60 for site class B / C / D–E (Vs30 > 760 / > 360 / else),
 *             T taken ≥ 0.2 s;
 *        C2 = 1 + ((R − 1) / T)² / 800 for T < 0.7 s and degrading (pinching / strength-loss) systems:
 *             pre- and low-code buildings and every C3 / S5 (infilled frames); C2 = 1 otherwise;
 *        R  = Sa_el(T) / A_y ≥ 1 (strength ratio).  Caps C1 ≤ 2.5, C2 ≤ 1.5 (FEMA 356 tabulated C2 maximum).
 *      Yield spectral acceleration A_y (g), HAZUS capacity curves (Tables 5.7a–d, recalled):
 *        moment frames (S1, C1)   high-code L 0.250  M 0.156  H 0.098
 *        braced / walls (S2, C2, PC2, RM2)  high-code L 0.400  M 0.333  H 0.250
 *        moderate code = ½ high, low and pre-code = ¼ high (HAZUS design-strength ratios);
 *        C3 / S5 (no high-code row): L 0.100  M 0.083  H 0.063 (low and pre).
 *
 * ── 4. HAZUS spectral-displacement medians (MR5 Tables 5.9a–d):  Sd_ds = δ_ds · α₂ · H
 *      δ_ds = average inter-storey drift ratio at the damage threshold, high-code low-rise rows:
 *        S1 .006 .012 .030 .080 · S2, C1 .005 .010 .030 .080 · C2, PC2, RM2 .004 .010 .030 .080
 *        C3, S5 (low-code rows; not permitted at higher codes) .003 .006 .015 .035
 *      code level multipliers (ratio of the HAZUS tables): moderate [1, .87, .80, .75], low [1, .80, .67, .625],
 *      pre = low × 0.8.
 *      HAZUS scales drift by 2/3 for mid-rise and 1/2 for high-rise and uses α₂ = 0.75 (L, M) / 0.6 (H): the
 *      product δ-scale · α₂ = 0.75 / 0.50 / 0.30 at the HAZUS typical heights of 2 / 5 / 13 storeys. We
 *      interpolate it linearly in storey count between those anchors (constant beyond) so there is no step at
 *      a height-class boundary, and use the building's actual roof height H.
 *      β: HAZUS total dispersion of these curves is 0.64–0.75 (≈ 0.68). The site's PGV/PGA residual
 *      (σ ≈ 0.5) and the 0.1 per-building term are simulated explicitly, so β_eff = √(0.68² − 0.5² − 0.1²) ≈ 0.45.
 *
 *   Example (1906 repeat, seed 1976): 750 Kearny (32 st, 111 m, low-code steel frame, PGV 61 cm/s): T 3.2 s →
 *   Sd ≈ 20 in vs. medians 7.9 / 12.6 / 26 / 66 in → P(moderate+) 0.86, P(extensive+) 0.29, P(complete) 0.005;
 *   the equivalent-PGA curve (PGA 0.48 g) had put P(complete) near 0.3. Steel-frame towers of 1906 (Call,
 *   Chronicle, Mills buildings) indeed came through the shaking structurally sound and were lost to the fire.
 */
import type { CodeLevel, StructureType } from '../../contracts';
import type { Quad } from './fragility';

const G_IN = 386.09; // g in in/s²
const G_CM = 980.665; // g in cm/s²
const NH_ACC = 2.12;
const NH_VEL = 1.65;

/** Structural types that use the displacement-based curves once they are 4+ storeys. */
const SPECTRAL_TYPES = new Set<StructureType>(['S1', 'S2', 'S5', 'C1', 'C2', 'C3', 'PC', 'RM']);

/** Mid/high-rise engineered or infilled frames use spectral demand; wood, URM and low-rises keep equivalent PGA. */
export function usesSpectral(structure: StructureType, levels: number): boolean {
  return levels >= 4 && SPECTRAL_TYPES.has(structure);
}

const FRAME = new Set<StructureType>(['S1', 'C1']);
const INFILL = new Set<StructureType>(['C3', 'S5']);

/** Fundamental period (s). */
export function buildingPeriod(structure: StructureType, levels: number): number {
  return Math.max(0.2, (FRAME.has(structure) ? 0.1 : 0.075) * levels);
}

/** Corner period of the constant-displacement branch (Faccioli et al. 2004). */
export function cornerPeriodTD(M: number): number {
  return Math.max(1, 1 + 2.5 * (M - 5.7));
}

/** Elastic 5 %-damped pseudo-spectral acceleration (g) at period T. */
export function spectralAcceleration(pgaG: number, pgvCms: number, T: number, M: number): number {
  const td = cornerPeriodTD(M);
  const vel = (Te: number) => (NH_VEL * pgvCms * 2 * Math.PI) / (Te * G_CM);
  const sa = Math.min(NH_ACC * pgaG, vel(Math.min(T, td)));
  return T <= td ? sa : sa * (td / T) ** 2;
}

const HIGH_DRIFT: Partial<Record<StructureType, Quad>> = {
  S1: [0.006, 0.012, 0.03, 0.08],
  S2: [0.005, 0.01, 0.03, 0.08],
  C1: [0.005, 0.01, 0.03, 0.08],
  C2: [0.004, 0.01, 0.03, 0.08],
  PC: [0.004, 0.01, 0.03, 0.08],
  RM: [0.004, 0.01, 0.03, 0.08],
};
const LOW_DRIFT_INFILL: Quad = [0.003, 0.006, 0.015, 0.035];
const CODE_DRIFT: Record<CodeLevel, Quad> = {
  high: [1, 1, 1, 1],
  moderate: [1, 0.87, 0.8, 0.75],
  low: [1, 0.8, 0.67, 0.625],
  pre: [0.8, 0.64, 0.536, 0.5],
};

/** Threshold drift ratios for a structure type and design level (low-rise row). */
export function driftThresholds(structure: StructureType, code: CodeLevel): Quad {
  if (INFILL.has(structure)) {
    const k = code === 'pre' ? 0.8 : 1;
    return LOW_DRIFT_INFILL.map((v) => v * k) as Quad;
  }
  const hi = HIGH_DRIFT[structure] ?? HIGH_DRIFT.C2!;
  const m = CODE_DRIFT[code];
  return [hi[0] * m[0], hi[1] * m[1], hi[2] * m[2], hi[3] * m[3]];
}

/** HAZUS drift-height scale × α₂, interpolated between typical heights 2 / 5 / 13 storeys. */
export function driftHeightFactor(levels: number): number {
  if (levels <= 2) return 0.75;
  if (levels <= 5) return 0.75 + ((levels - 2) / 3) * (0.5 - 0.75);
  if (levels <= 13) return 0.5 + ((levels - 5) / 8) * (0.3 - 0.5);
  return 0.3;
}

/** Spectral-displacement medians (inches) for the four structural damage states. */
export function sdMedians(structure: StructureType, code: CodeLevel, levels: number, heightM: number): Quad {
  const d = driftThresholds(structure, code);
  const hIn = Math.max(3, heightM) * 39.37;
  const f = driftHeightFactor(levels) * hIn;
  return [d[0] * f, d[1] * f, d[2] * f, d[3] * f];
}

/** Yield spectral acceleration A_y (g) of the HAZUS capacity curve. */
export function yieldAccel(structure: StructureType, code: CodeLevel, levels: number): number {
  const hc = levels <= 3 ? 0 : levels <= 7 ? 1 : 2;
  if (INFILL.has(structure)) return [0.1, 0.083, 0.063][hc];
  const high = FRAME.has(structure) ? [0.25, 0.156, 0.098][hc] : [0.4, 0.333, 0.25][hc];
  return high * (code === 'high' ? 1 : code === 'moderate' ? 0.5 : 0.25);
}

export interface SpectralDemand {
  T: number;
  saG: number;
  /** Elastic and inelastic spectral displacement (inches). */
  sdElastic: number;
  sd: number;
  c1: number;
  c2: number;
}

/** FEMA 440 inelastic spectral-displacement demand at the building's period. */
export function spectralDemand(
  structure: StructureType,
  code: CodeLevel,
  levels: number,
  pgaG: number,
  pgvCms: number,
  vs30: number,
  M: number,
): SpectralDemand {
  const T = buildingPeriod(structure, levels);
  const saG = spectralAcceleration(pgaG, pgvCms, T, M);
  const sdElastic = saG * G_IN * (T / (2 * Math.PI)) ** 2;
  const R = Math.max(1, saG / yieldAccel(structure, code, levels));
  const a = vs30 > 760 ? 130 : vs30 > 360 ? 90 : 60;
  const Tc = Math.max(0.2, T);
  const c1 = Math.min(2.5, 1 + (R - 1) / (a * Tc * Tc));
  const degrading = code === 'pre' || code === 'low' || INFILL.has(structure);
  const c2 = degrading && T < 0.7 ? Math.min(1.5, 1 + ((R - 1) / Tc) ** 2 / 800) : 1;
  return { T, saG, sdElastic, sd: sdElastic * c1 * c2, c1, c2 };
}

/** HAZUS total dispersion of the spectral-displacement curves and the part left after explicit demand sampling. */
export const BETA_SD_HAZUS = 0.68;
export const BETA_SD_EFF = Math.sqrt(BETA_SD_HAZUS ** 2 - 0.5 ** 2 - 0.1 ** 2);
