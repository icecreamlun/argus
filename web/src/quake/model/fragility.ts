/**
 * HAZUS-MH building damage functions, collapse rates and casualty rates.
 *
 * ── Fragility: HAZUS-MH MR4/MR5 Earthquake Technical Manual, Tables 5.16a–d ──────────────────────────────
 *   "Equivalent-PGA" structural fragility curves: P(DS ≥ ds | PGA) = Φ( ln(PGA / median_ds) / β ), β = 0.64,
 *   medians (g) for Slight / Moderate / Extensive / Complete by model building type, height class and
 *   seismic design level (5.16a High-, 5.16b Moderate-, 5.16c Low-, 5.16d Pre-code).
 *   damage.ts applies them to wood, URM and low-rise buildings with β_eff ≈ 0.44 (demand variability is
 *   simulated explicitly) and a single capacity calibration κ = 1.4 (1989 and 1906-repeat anchors) — see its
 *   header. Mid/high-rise frames use displacement-based curves instead (spectral.ts).
 *
 *   Provenance of the numbers (honest disclosure — the manual was not at hand, values were reproduced
 *   from memory and cross-checked for internal consistency):
 *     • High-code table (HIGH below): reproduced as remembered for every type; we believe these are
 *       within a few hundredths of g of the manual.
 *     • Recalled entries for other code levels (OVERRIDES): W1, W2 at all levels; C1L, C1M, C2L, PC1,
 *       RM1L moderate-code; URML/URMM low- and pre-code; C3L/S5L moderate-code.
 *     • Everything else is DERIVED with the mean code-level ratios of the recalled rows:
 *         moderate ≈ high × [0.81, 0.69, 0.62, 0.61]
 *         low      ≈ high × [0.62, 0.45, 0.40, 0.40]
 *         pre      ≈ low  × [0.88, 0.84, 0.81, 0.80]
 *       (types with no high-code row — C3, S5, URM — start from their low-code row instead).
 *     Derived values are conservative-plausible but may differ from the manual by ±15 %.
 *
 *   Height classes (HAZUS Table 3.1): W1 1–2 st (we do not split), W2 all; S1/S2/S5/C1/C2/C3/PC2/RM2:
 *   L 1–3, M 4–7, H 8+; RM1: L 1–3, M 4+; URM: L 1–2, M 3+; PC1 all (tilt-up, used for PC ≤ 2 storeys).
 *
 * ── Collapse given Complete damage: HAZUS casualty-model collapse rates (% of Complete that is collapse) ─────
 *   W1 3, W2 3, S1/S2/S5 L 8 M 5 H 3, C1/C2 L 13 M 10 H 5, C3 L 15 M 13 H 10, PC1 15, PC2 L 15 M 13 H 10,
 *   RM1 L 13 M 10, RM2 L 13 M 10 H 5, URM L 15 M 15.
 *   URM retrofitted under SF's UMB ordinance (code level ≠ pre): 5 % (see collapseRate).
 *   W1_SOFT (SF soft-story wood): raised to 20 % (judgement: the weak-storey mechanism IS a collapse mode —
 *   FEMA P-807; in the 1989 Marina most red-tagged soft-story buildings lost their first storey).
 *
 * ── Indoor casualty rates: HAZUS Tables 13.3–13.7 (percent of occupants, severity 1..4) ─────────────────────
 *                       Slight            Moderate              Extensive            Complete           Collapse
 *   most types        .05/0/0/0        .20/.025/0/0          1/.1/.001/.001       5/1/.01/.01        40/20/5/10
 *   W1, W2            .05/0/0/0        .25/.03/0/0           1/.1/.001/.001       5/1/.01/.01        40/20/3/5
 *   URM               .14/.02/0/0      .35/.4/.001/.001      2/.2/.002/.002       10/2/.02/.02       40/20/5/10
 *   (recalled; URM slight/moderate are the least certain.)
 */
import type { CodeLevel, StructureType } from '../../contracts';

export type Quad = [number, number, number, number];
/** HAZUS total dispersion of the equivalent-PGA curves (capacity + demand + threshold uncertainty). */
export const BETA_HAZUS = 0.64;

const HIGH: Record<string, Quad> = {
  W1: [0.26, 0.55, 1.28, 2.01],
  W2: [0.26, 0.56, 1.15, 2.08],
  S1L: [0.19, 0.55, 1.08, 2.04],
  S1M: [0.14, 0.38, 0.89, 1.73],
  S1H: [0.1, 0.28, 0.65, 1.43],
  S2L: [0.24, 0.54, 1.22, 2.08],
  S2M: [0.14, 0.42, 1.04, 1.92],
  S2H: [0.11, 0.33, 0.84, 1.78],
  C1L: [0.21, 0.45, 0.97, 1.61],
  C1M: [0.15, 0.37, 0.87, 1.49],
  C1H: [0.11, 0.32, 0.76, 1.29],
  C2L: [0.24, 0.45, 0.9, 1.55],
  C2M: [0.17, 0.36, 0.87, 1.49],
  C2H: [0.12, 0.29, 0.77, 1.38],
  PC1: [0.2, 0.35, 0.72, 1.25],
  PC2L: [0.24, 0.36, 0.69, 1.23],
  PC2M: [0.17, 0.32, 0.72, 1.32],
  PC2H: [0.12, 0.29, 0.7, 1.36],
  RM1L: [0.3, 0.46, 0.93, 1.57],
  RM1M: [0.2, 0.37, 0.81, 1.49],
  RM2L: [0.26, 0.42, 0.87, 1.49],
  RM2M: [0.17, 0.33, 0.75, 1.4],
  RM2H: [0.12, 0.27, 0.67, 1.28],
};

/** Low-code rows for types that HAZUS does not define at high code. */
const LOW_BASE: Record<string, Quad> = {
  C3L: [0.12, 0.17, 0.26, 0.44],
  C3M: [0.1, 0.15, 0.25, 0.46],
  C3H: [0.09, 0.14, 0.23, 0.44],
  S5L: [0.13, 0.17, 0.28, 0.45],
  S5M: [0.11, 0.18, 0.35, 0.62],
  S5H: [0.1, 0.18, 0.39, 0.77],
  URML: [0.14, 0.2, 0.32, 0.46],
  URMM: [0.1, 0.16, 0.27, 0.46],
};

const OVERRIDES: Partial<Record<CodeLevel, Record<string, Quad>>> = {
  moderate: {
    W1: [0.24, 0.43, 0.91, 1.34],
    W2: [0.2, 0.35, 0.64, 1.13],
    C1L: [0.16, 0.31, 0.64, 1.04],
    C1M: [0.13, 0.26, 0.55, 0.94],
    C2L: [0.18, 0.3, 0.49, 0.87],
    PC1: [0.18, 0.24, 0.44, 0.71],
    RM1L: [0.22, 0.3, 0.5, 0.85],
    C3L: [0.15, 0.22, 0.42, 0.8],
    S5L: [0.15, 0.22, 0.4, 0.71],
  },
  low: {
    W1: [0.2, 0.34, 0.61, 0.95],
    W2: [0.14, 0.23, 0.48, 0.75],
    URML: [0.14, 0.2, 0.32, 0.46],
    URMM: [0.1, 0.16, 0.27, 0.46],
  },
  pre: {
    W1: [0.18, 0.29, 0.51, 0.77],
    W2: [0.12, 0.19, 0.37, 0.6],
    URML: [0.13, 0.17, 0.26, 0.37],
    URMM: [0.09, 0.13, 0.21, 0.38],
  },
};

const R_MOD: Quad = [0.81, 0.69, 0.62, 0.61];
const R_LOW: Quad = [0.62, 0.45, 0.4, 0.4];
const R_PRE: Quad = [0.88, 0.84, 0.81, 0.8];
/** Moderate from low for no-high-code types (inverse of the mean low→moderate step). */
const R_LOW_TO_MOD: Quad = [1.25, 1.3, 1.45, 1.5];

const mul = (a: Quad, r: Quad): Quad => [a[0] * r[0], a[1] * r[1], a[2] * r[2], a[3] * r[3]];

/** Medians (g) for a HAZUS class id ("C1M", "URML", …) and design level. */
export function hazusMedians(cls: string, level: CodeLevel): Quad {
  const o = OVERRIDES[level]?.[cls];
  if (o) return o;
  const high = HIGH[cls];
  if (high) {
    if (level === 'high') return high;
    if (level === 'moderate') return mul(high, R_MOD);
    const low = OVERRIDES.low?.[cls] ?? mul(high, R_LOW);
    return level === 'low' ? low : mul(low, R_PRE);
  }
  // C3 / S5 / URM: not permitted by high/moderate codes in HAZUS; anchor on low-code.
  const low = OVERRIDES.low?.[cls] ?? LOW_BASE[cls] ?? LOW_BASE.URML;
  if (level === 'low') return low;
  if (level === 'pre') return OVERRIDES.pre?.[cls] ?? mul(low, R_PRE);
  if (cls.startsWith('URM')) {
    // A URM can't be "moderate/high code"; treat as a retrofitted URM (bolts + parapet bracing).
    const r: Quad = level === 'high' ? [1.15, 1.2, 1.25, 1.3] : [1.08, 1.1, 1.12, 1.15];
    return mul(low, r);
  }
  const mod = OVERRIDES.moderate?.[cls] ?? mul(low, R_LOW_TO_MOD);
  return level === 'moderate' ? mod : mul(mod, [1.1, 1.12, 1.15, 1.18]);
}

/** HAZUS model building class (type + height class) for our structure enum and storey count. */
export function hazusClass(structure: StructureType, levels: number): string {
  const lmh = levels <= 3 ? 'L' : levels <= 7 ? 'M' : 'H';
  switch (structure) {
    case 'W1':
    case 'W1_SOFT':
      return 'W1';
    case 'W2':
      return 'W2';
    case 'URM':
      return levels <= 2 ? 'URML' : 'URMM';
    case 'RM':
      return levels <= 3 ? 'RM1L' : 'RM2' + lmh; // low-rise RM ≈ flexible (wood) diaphragms
    case 'PC':
      return levels <= 2 ? 'PC1' : 'PC2' + lmh;
    case 'C1':
    case 'C2':
    case 'C3':
    case 'S1':
    case 'S2':
    case 'S5':
      return structure + lmh;
  }
}

/** Fraction of Complete damage that is structural collapse (HAZUS), with SF soft-story judgement. */
export function collapseRate(structure: StructureType, cls: string, code: CodeLevel): number {
  if (structure === 'W1_SOFT') return 0.2;
  // SF UMB-retrofitted URM (data marks them 'low'): wall-to-diaphragm anchors and braced parapets remove the
  // out-of-plane wall-collapse mode; retrofitted URMs in 2003 San Simeon and 2014 Napa were damaged but did
  // not collapse (FEMA P-774, 2009; EERI Napa reconnaissance 2014) → 5 % instead of 15 %.
  if (structure === 'URM' && code !== 'pre') return 0.05;
  const table: Record<string, number> = {
    W1: 0.03, W2: 0.03,
    S1L: 0.08, S1M: 0.05, S1H: 0.03, S2L: 0.08, S2M: 0.05, S2H: 0.03, S5L: 0.08, S5M: 0.05, S5H: 0.03,
    C1L: 0.13, C1M: 0.1, C1H: 0.05, C2L: 0.13, C2M: 0.1, C2H: 0.05, C3L: 0.15, C3M: 0.13, C3H: 0.1,
    PC1: 0.15, PC2L: 0.15, PC2M: 0.13, PC2H: 0.1,
    RM1L: 0.13, RM1M: 0.1, RM2L: 0.13, RM2M: 0.1, RM2H: 0.05,
    URML: 0.15, URMM: 0.15,
  };
  return table[cls] ?? 0.1;
}

type CasualtyRow = [Quad, Quad, Quad, Quad, Quad]; // slight, moderate, extensive, complete, collapse (percent)

const CAS_DEFAULT: CasualtyRow = [
  [0.05, 0, 0, 0],
  [0.2, 0.025, 0, 0],
  [1, 0.1, 0.001, 0.001],
  [5, 1, 0.01, 0.01],
  [40, 20, 5, 10],
];
const CAS_WOOD: CasualtyRow = [
  [0.05, 0, 0, 0],
  [0.25, 0.03, 0, 0],
  [1, 0.1, 0.001, 0.001],
  [5, 1, 0.01, 0.01],
  [40, 20, 3, 5],
];
const CAS_URM: CasualtyRow = [
  [0.14, 0.02, 0, 0],
  [0.35, 0.4, 0.001, 0.001],
  [2, 0.2, 0.002, 0.002],
  [10, 2, 0.02, 0.02],
  [40, 20, 5, 10],
];

/** Casualty rates (fractions, not percent) for a damage state (1..4) and collapse flag. */
export function casualtyRates(structure: StructureType, state: number, collapsed: boolean): Quad {
  if (state <= 0) return [0, 0, 0, 0];
  const row = structure === 'URM' ? CAS_URM : structure.startsWith('W') ? CAS_WOOD : CAS_DEFAULT;
  const r = collapsed ? row[4] : row[state - 1];
  return [r[0] / 100, r[1] / 100, r[2] / 100, r[3] / 100];
}

/** Masonry-like structural systems (heavy, brittle; debris spills far; parapets). */
export function isMasonryLike(s: StructureType): boolean {
  return s === 'URM' || s === 'C3' || s === 'S5' || s === 'RM';
}
