/**
 * Ground-motion physics. Every relation below is a published, California-appropriate model; coefficients
 * are quoted in the comments next to the code that uses them.
 *
 * ── 1. BSSA14 ground-motion model (PGA in g, PGV in cm/s) ────────────────────────────────────────────────
 *   Boore, D.M., Stewart, J.P., Seyhan, E. & Atkinson, G.M. (2014). NGA-West2 equations for predicting PGA,
 *   PGV, and 5%-damped PSA for shallow crustal earthquakes. Earthquake Spectra 30(3), 1057–1085.
 *
 *     ln Y = F_E(M, mech) + F_P(R_JB, M) + F_S(Vs30, R_JB, M)
 *     F_E  = e_mech + e4 (M − Mh) + e5 (M − Mh)²      (M ≤ Mh)
 *          = e_mech + e6 (M − Mh)                     (M > Mh)        e_mech ∈ {e0 U, e1 SS, e2 NS, e3 RS}
 *     F_P  = [c1 + c2 (M − Mref)] ln(R / Rref) + (c3 + Δc3)(R − Rref),  R = √(R_JB² + h²), Mref 4.5, Rref 1 km,
 *            Δc3 = 0 for California.
 *     F_S  = F_lin + F_nl   (basin term F_δz1 omitted: z1 unknown → its mean is 0)
 *     F_lin = c ln(min(Vs30, Vc) / Vref),  Vref = 760 m/s
 *     F_nl  = f1 + f2 ln((PGA_r + f3) / f3),  f1 = 0, f3 = 0.1 g,
 *     f2    = f4 [exp(f5 (min(Vs30, 760) − 360)) − exp(f5 (760 − 360))]
 *     PGA_r = median PGA on Vs30 = 760 m/s rock.
 *
 *   Coefficients (BSSA14 Table, rows "PGA" and "PGV"):
 *             e0      e1      e2      e3      e4      e5       e6       Mh   c1      c2      c3         h    c(lin)  Vc    f4     f5
 *     PGA   0.4473  0.4856  0.2459  0.4539  1.431   0.05053 −0.1662  5.5  −1.134  0.1917 −0.008088   4.5  −0.600  1500  −0.15  −0.00701
 *     PGV   5.037   5.078   4.849   5.033   1.073  −0.1536   0.2252  6.2  −1.243  0.1489 −0.00344    5.3  −0.840  1300  −0.10  −0.00844
 *   Within-event σ (φ) for M ≥ 5.5 is 0.495 (PGA) / 0.552 (PGV) in BSSA14. Because every building carries
 *   its own Vs30, part of the site-to-site term is explained, so we use single-station-like values
 *   φ_ss ≈ 0.9 φ (Rodriguez-Marek et al. 2013): σ_lnPGA = 0.45, σ_lnPGV = 0.50.
 *
 *   Sanity (M7.8 strike-slip, R_JB 14.6 km ≈ downtown SF from the 1906 trace): PGA rock 0.25 g, Vs30 330 →
 *   0.33 g; PGV rock 28 cm/s, Vs30 330 → 48 cm/s. 1906 estimates for downtown SF are 0.3–0.5 g.
 *
 * ── 2. Moho-reflection term (scenario-agnostic but only active for deep, distant sources) ─────────────────
 *   Somerville & Yoshimura (1990, GRL 17(8)) showed critically reflected S from the Moho roughly doubled
 *   Loma Prieta amplitudes at 50–100 km (SF and Oakland). Observed 1989 SF rock PGA (Rincon Hill 0.09 g,
 *   Yerba Buena Is. 0.07 g) is ~2× the BSSA14 median at R ≈ 80 km, and long-period motion (PGV) was
 *   boosted more (SF/Oakland PGV 10–40 cm/s vs. a BSSA14 median of ~3–9 cm/s), so we add
 *       Δln Y = A · exp(−½ ((R_rup − 80)/18)²) · clamp((depth − 8)/8, 0, 1),   A = 0.65 (PGA), 0.90 (PGV).
 *   It is zero for the 1906 and HayWired scenarios (R ≈ 15 km, shallow hypocentres).
 *
 * ── 3. MMI from PGA / PGV: Worden, Gerstenberger, Rhoades & Wald (2012), BSSA 102(1), Table 1 ──────────────
 *     MMI = c1 + c2 log10(Y)  if log10(Y) ≤ t1,  else  c3 + c4 log10(Y)
 *       PGA (cm/s²): c1 1.78, c2 1.55, c3 −1.60, c4 3.70, t1 1.57
 *       PGV (cm/s) : c1 3.78, c2 1.47, c3 2.89, c4 3.16, t1 0.53
 *   We take the larger of the two estimates (PGA saturates at high intensity; ShakeMap leans on PGV there).
 *
 * ── 4. Significant duration: Bommer, Stafford & Alarcón (2009), BSSA 99(6), 3217–3233 ─────────────────────
 *     ln D = c0 + m1 M + (r1 + r2 M) ln √(R_rup² + h1²) + v1 ln Vs30 + z1 Z_tor
 *       D5-75: c0 −5.6298, m1 1.2619, r1 2.0063, r2 −0.2522, h1 2.3316, v1 −0.2900, z1 −0.0522
 *       D5-95: c0 −2.2393, m1 0.9368, r1 1.5686, r2 −0.1953, h1 2.5000, v1 −0.3478, z1 −0.0365
 *   D5-75 is the S-wave strong phase, D5-95 includes the coda; we use their mean as the duration of
 *   "strong shaking" felt in a building. For long ruptures the spread of S arrivals from the part of the
 *   fault that alone would produce strong shaking at the site is added (see timing.ts).
 *
 * ── 5. Liquefaction: HAZUS-MH Technical Manual §4.2.2.1 (Liao et al. 1988 / Youd & Perkins 1978) ─────────
 *     P[L | PGA=a] for "very high" susceptibility (artificial fill over Bay Mud) = 9.09 a − 0.82
 *     K_M = 0.0027 M³ − 0.0267 M² − 0.2055 M + 2.9188   (magnitude correction)
 *     K_w = 0.022 d_w + 0.93                              (groundwater depth d_w in feet; SF fill ≈ 5 ft)
 *     P[L] = P[L | PGA] / (K_M K_w) · P_ml
 *   HAZUS uses P_ml = 0.25 for a whole map unit; our onFill flag marks the historic Yerba Buena Cove fill
 *   that actually liquefied in 1906 and 1989 (Youd & Hoose 1978; O'Rourke et al. 1992), so we use 0.6.
 */

export type Mechanism = 'U' | 'SS' | 'NS' | 'RS';

interface BssaCoef {
  e: Record<Mechanism, number>;
  e4: number;
  e5: number;
  e6: number;
  Mh: number;
  c1: number;
  c2: number;
  c3: number;
  h: number;
  clin: number;
  Vc: number;
  f4: number;
  f5: number;
}

const BSSA_PGA: BssaCoef = {
  e: { U: 0.4473, SS: 0.4856, NS: 0.2459, RS: 0.4539 },
  e4: 1.431, e5: 0.05053, e6: -0.1662, Mh: 5.5,
  c1: -1.134, c2: 0.1917, c3: -0.008088, h: 4.5,
  clin: -0.6, Vc: 1500, f4: -0.15, f5: -0.00701,
};

const BSSA_PGV: BssaCoef = {
  e: { U: 5.037, SS: 5.078, NS: 4.849, RS: 5.033 },
  e4: 1.073, e5: -0.1536, e6: 0.2252, Mh: 6.2,
  c1: -1.243, c2: 0.1489, c3: -0.00344, h: 5.3,
  clin: -0.84, Vc: 1300, f4: -0.1, f5: -0.00844,
};

const VREF = 760;
const MREF = 4.5;

const MOHO_AMP_PGA = 0.65;
const MOHO_AMP_PGV = 0.9;

export const SIGMA_LN_PGA = 0.45;
export const SIGMA_LN_PGV = 0.5;
/** Correlation between PGA and PGV within-event residuals (Baker & Cornell 2006 report ~0.7–0.8). */
export const RHO_PGA_PGV = 0.75;

/** ln of the median on Vs30 = 760 m/s rock (F_E + F_P). */
function lnRock(c: BssaCoef, M: number, rjb: number, mech: Mechanism): number {
  const dm = M - c.Mh;
  const fe = c.e[mech] + (M <= c.Mh ? c.e4 * dm + c.e5 * dm * dm : c.e6 * dm);
  const R = Math.sqrt(rjb * rjb + c.h * c.h);
  const fp = (c.c1 + c.c2 * (M - MREF)) * Math.log(R) + c.c3 * (R - 1);
  return fe + fp;
}

/** BSSA14 site term F_lin + F_nl. */
function siteTerm(c: BssaCoef, vs30: number, pgaRockG: number): number {
  const flin = c.clin * Math.log(Math.min(vs30, c.Vc) / VREF);
  const f2 = c.f4 * (Math.exp(c.f5 * (Math.min(vs30, VREF) - 360)) - Math.exp(c.f5 * (VREF - 360)));
  const fnl = f2 * Math.log((pgaRockG + 0.1) / 0.1);
  return flin + fnl;
}

/** Moho-reflection amplification (ln units), see header §2. */
export function mohoTerm(rrupKm: number, depthKm: number, amplitude: number): number {
  const depthW = Math.max(0, Math.min(1, (depthKm - 8) / 8));
  if (depthW === 0) return 0;
  const z = (rrupKm - 80) / 18;
  return amplitude * Math.exp(-0.5 * z * z) * depthW;
}

export interface MedianMotion {
  lnPga: number; // ln(g)
  lnPgv: number; // ln(cm/s)
  /** Site terms (ln), useful for diagnostics. */
  fsPga: number;
  fsPgv: number;
}

/** Median PGA (g) and PGV (cm/s) at a site. */
export function medianMotion(M: number, rjbKm: number, rrupKm: number, vs30: number, mech: Mechanism, depthKm: number): MedianMotion {
  const moho = mohoTerm(rrupKm, depthKm, MOHO_AMP_PGA);
  const lnPgaRock = lnRock(BSSA_PGA, M, rjbKm, mech) + moho;
  const pgaR = Math.exp(lnPgaRock);
  const fsPga = siteTerm(BSSA_PGA, vs30, pgaR);
  const fsPgv = siteTerm(BSSA_PGV, vs30, pgaR);
  return {
    lnPga: lnPgaRock + fsPga,
    lnPgv: lnRock(BSSA_PGV, M, rjbKm, mech) + mohoTerm(rrupKm, depthKm, MOHO_AMP_PGV) + fsPgv,
    fsPga,
    fsPgv,
  };
}

/** Median rock (Vs30 760) PGV in cm/s — used to find the "strong-shaking" part of a long rupture. */
export function rockPgv(M: number, rjbKm: number, mech: Mechanism): number {
  return Math.exp(lnRock(BSSA_PGV, M, rjbKm, mech));
}

/** Worden et al. (2012) GMICE, PGA in g → MMI. */
export function mmiFromPga(pgaG: number): number {
  const l = Math.log10(Math.max(pgaG * 980.665, 1e-3));
  return l <= 1.57 ? 1.78 + 1.55 * l : -1.6 + 3.7 * l;
}

/** Worden et al. (2012) GMICE, PGV in cm/s → MMI. */
export function mmiFromPgv(pgvCms: number): number {
  const l = Math.log10(Math.max(pgvCms, 1e-4));
  return l <= 0.53 ? 3.78 + 1.47 * l : 2.89 + 3.16 * l;
}

/** Combined instrumental intensity: larger of the PGA and PGV estimates, clamped to I..X. */
export function mmiFrom(pgaG: number, pgvCms: number): number {
  return Math.max(1, Math.min(10, Math.max(mmiFromPga(pgaG), mmiFromPgv(pgvCms))));
}

/** Bommer et al. (2009) D5-75 significant duration (s). */
export function durationD575(M: number, rrupKm: number, vs30: number, ztorKm: number): number {
  const lnD =
    -5.6298 + 1.2619 * M + (2.0063 - 0.2522 * M) * Math.log(Math.sqrt(rrupKm * rrupKm + 2.3316 * 2.3316)) - 0.29 * Math.log(vs30) - 0.0522 * ztorKm;
  return Math.exp(lnD);
}

/** Bommer et al. (2009) D5-95 significant duration (s). */
export function durationD595(M: number, rrupKm: number, vs30: number, ztorKm: number): number {
  const lnD =
    -2.2393 + 0.9368 * M + (1.5686 - 0.1953 * M) * Math.log(Math.sqrt(rrupKm * rrupKm + 2.5 * 2.5)) - 0.3478 * Math.log(vs30) - 0.0365 * ztorKm;
  return Math.exp(lnD);
}

/** HAZUS conditional liquefaction probability for very-high-susceptibility fill (see header §5). */
export function liquefactionProbability(pgaG: number, M: number, groundwaterFt = 5, pMl = 0.6): number {
  const pGivenA = Math.max(0, Math.min(1, 9.09 * pgaG - 0.82));
  const km = 0.0027 * M ** 3 - 0.0267 * M ** 2 - 0.2055 * M + 2.9188;
  const kw = 0.022 * groundwaterFt + 0.93;
  return Math.max(0, Math.min(1, pGivenA / (km * kw))) * pMl;
}
