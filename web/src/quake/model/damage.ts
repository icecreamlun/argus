/**
 * Per-building damage sampling and the visual / human-impact parameters derived from it.
 *
 * Damage state — two HAZUS paths (one per building; building:part pieces use their anchor's record and demand,
 * so a tower and its podium / crown pieces always share one damage state):
 *   • Mid/high-rise (4+ storeys) engineered and infilled frames S1 S2 S5 C1 C2 C3 PC RM: inelastic spectral
 *     displacement at the building's own period against HAZUS drift-based Sd medians (spectral.ts).
 *   • Everything else (wood, URM, low-rises): HAZUS equivalent-PGA curves (fragility.ts),
 *     P(DS ≥ ds) = Φ(ln(PGA/(κ·med_ds))/β_eff) with κ = 1.4 — single capacity calibration. HAZUS
 *     equivalent-PGA curves are a screening tool and are conservative for older stock. Two anchors:
 *       1989: a Loma Prieta repeat (SF PGA ≈ 0.09 g, Rincon Hill record) must stay well under 1 % extensive+
 *             (SF's post-earthquake red-tag rate) — uncalibrated HAZUS gave ~2.5 %;
 *       1906: the HAZUS 1906-repeat study (Kircher, Seligson, Bouabid & Morrow 2006, Earthquake Spectra 22(S2))
 *             found ≈ 10 % of the region's commercial buildings extensive/complete ("about 7,000"), with SF the
 *             hardest-hit county; this old NE quadrant (URM blocks, Bay fill) should sit at ~1.5–2.5× that.
 *     κ 1.25–1.4 satisfies both; 1.4 gives 18 % extensive+ (4.4 % complete) over the 5,689 buildings, 30 %
 *     (8 %) in the 1,902-record core, and 0.1 % extensive+ for 1989.
 *   SF UMB-retrofitted URM (data: URM with codeLevel 'low'; 'pre' = never retrofitted) use the HAZUS RM1
 *   (reinforced masonry, flexible diaphragm) curves at the same code level instead of URM ones — judgement: the
 *   bolts-plus retrofit ties walls to diaphragms and braces parapets, which is what separates RM1 from URM;
 *   the HAZUS URM rows describe unretrofitted masonry (complete median 0.46 → 0.63 g).
 *   Storey count is capped at height / 2.8 m (structuralLevels) — OSM levels are occasionally absurd.
 *   Modifiers (both paths, on the medians):
 *   • soft/weak storey (W1_SOFT or softStory flag):  all medians × 0.6
 *   • unretrofitted URM parapets / cornices (URM, pre-code): slight & moderate medians × 0.85
 *   • liquefied fill (HAZUS ground-failure is PGD-based; this is a proxy): medians × 0.55 (≤ 3 storeys,
 *     shallow spread footings), × 0.75 (4–7), × 0.9 (8+, piles to bedrock/Colma sand)
 *   • named landmarks (Ferry Building 2003 retrofit, Sentinel, Old St Mary's, Customs House, Coit Tower's
 *     massive concrete shaft, …): design level raised to at least 'moderate' (URM → retrofitted URM) and
 *     collapse odds halved, capacity percentile drawn from [0.15, 1) (an engineered retrofit narrows the
 *     uncertainty about a building's weakest link) — most SF landmarks have been seismically upgraded.
 *   One uniform u per structure (building:part pieces share their parent's u) → DS = #{ds : u < P(DS ≥ ds)}.
 * Collapse | Complete: HAZUS collapse rate × 1.5 for liquefied low-rise.
 *
 * Visual parameters (judgement, tuned against 1906/1989/2023-Türkiye imagery):
 *   collapseFraction (share of height lost)
 *     URM / C3 / S5 pancake 0.5–0.9 · soft-story wood: first storey 1/levels (+0–0.1) · other wood 0.4–0.7 ·
 *     concrete / RM / PC: low-rise 0.4–0.8, mid-rise partial 0.3–0.6, high-rise 0.15–0.3 · steel 0.15–0.35 ·
 *     non-collapsed buildings on liquefied ground settle 2–6 % (low-rise).
 *   leanDirection = atan2(dz, dx) of the lean vector in world XZ, i.e. the top moves along (cos θ, sin θ).
 *     It blends downhill (plane fit of neighbouring base elevations), the nearest street frontage and a
 *     random term; liquefied sites lean harder downhill (lateral spreading toward the Bay free face).
 *   leanAngle (radians): extensive 2–6°, complete 5–12°, soft-story collapse 8–15°, pancake 0–4°; +3° liquefied;
 *     capped for non-collapsed mid-rise (4–7 st) at 4° and high-rise (8+) at 1.2° (≈ 2 % residual drift —
 *     already "complete" for a steel/concrete tower; more would read as a collapse).
 *   debrisRadius (m beyond footprint): collapse: masonry 0.4–0.7 H (≤ 30 m), concrete 0.3–0.5 H, wood
 *     0.25–0.45 H, steel 0.15–0.3 H, scaled by (0.45 + 0.55·collapseFraction); complete: masonry 0.2–0.35 H,
 *     others 0.08–0.18 H; extensive: URM/C3/S5 facade & parapet fall 0.15–0.3 H, others glass/cladding
 *     0.03–0.08 H; moderate pre-code URM: parapet drop 0.08–0.15 H half of the time.
 *   failTimeS: sArrival + D · f, f ∈ [0.08, 0.85] — buildings far beyond their capacity fail early in the
 *     strong phase, marginal ones near its end: f = 0.15 + 0.55 (1 − P(DS ≥ state)) ± 0.06.
 *
 * Fire ignition: HAZUS-MH fire-following-earthquake ignition regression (after Scawthorn; reproduced from
 *   memory): λ = 0.581895·PGA² − 0.029444·PGA ignitions per million ft² of floor area. The city-wide expected
 *   count N = Σ λ(PGA_i)·A_i/1e6 is kept; weights only decide WHERE ignitions happen:
 *   w_i = w_DS · w_density · w_type · w_sprinkler with w_DS = [0.5, 0.8, 1.3, 2, 3] (broken gas lines,
 *   overturned heaters in damaged buildings), w_density = clamp(n₆₀/8, 0.5, 2) (neighbours within 60 m),
 *   w_type = 1.3 for wood, w_sprinkler = 0.35 for post-1975 buildings ≥ 7 storeys (SF high-rise sprinkler
 *   rules). μ_i = λ_i A_i w_i · N / Σ(λ A w); P(fire_i) = 1 − e^−μ_i (sampled in index.ts).
 *
 * Casualties: HAZUS indoor casualty rates (fragility.ts) × occupants at the local hour
 *   (day 9–17 h = occupantsDay, night 22–6 h = occupantsNight, linear in the commute shoulders).
 * Trapped (search & rescue ground truth, alive or not): Coburn, Spence & Pomonis (1992) "M3" share of
 *   occupants trapped by collapse — masonry 0.55, concrete 0.7, steel 0.5, wood 0.35 — times the collapsed
 *   share (0.35 + 0.65·collapseFraction); complete non-collapse 2 %, extensive 0.3 %, moderate 0.02 %
 *   (jammed exits, local stair/ceiling failures — US&R experience in 1989 and 1994 is that entrapment
 *   concentrates in collapses). Rounded stochastically (seeded) to whole people.
 */
import type { BuildingDamage, BuildingRecord, CodeLevel, DamageState } from '../../contracts';
import { normCdf, streamFor, type Rng } from './rng';
import { SIGMA_LN_PGA } from './gmpe';
import { BETA_HAZUS, casualtyRates, collapseRate, hazusClass, hazusMedians, isMasonryLike, type Quad } from './fragility';
import { BETA_SD_EFF, sdMedians, spectralDemand, usesSpectral } from './spectral';

export function occupantsAt(b: BuildingRecord, hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const day = b.occupantsDay || 0;
  const night = b.occupantsNight || 0;
  if (h >= 9 && h <= 17) return day;
  if (h >= 22 || h <= 6) return night;
  if (h < 9) return night + ((h - 6) / 3) * (day - night);
  return day + ((h - 17) / 5) * (night - day);
}

export interface DamageInputs {
  b: BuildingRecord;
  /**
   * Record that defines the structural system (levels, height): the building's anchor for building:part
   * pieces, so a tower's podium / crown pieces share the tower's fragility; `b` itself otherwise.
   */
  structural?: BuildingRecord;
  pgaG: number;
  pgvCms: number;
  vs30: number;
  /** Moment magnitude of the event (sets the long-period corner of the demand spectrum). */
  magnitude: number;
  liquefied: boolean;
  sArrivalS: number;
  durationS: number;
  hour: number;
  seed: number;
  /** Unit downhill direction and slope (m/m) from the neighbourhood plane fit. */
  downhill: [number, number];
  slope: number;
  /** Unit vector toward the nearest street, if any. */
  toStreet: [number, number] | null;
  /** Buildings with centroid within 60 m (density proxy for fire). */
  neighbours60: number;
  footprintArea: number;
}

const DEG = Math.PI / 180;

/**
 * HAZUS β = 0.64 already contains ground-motion (demand) variability. We simulate the within-event PGA
 * residual explicitly (σ = SIGMA_LN_PGA plus a 0.1 per-building term), so only the remaining capacity /
 * threshold part is used here: β_eff = √(0.64² − σ² − 0.1²) ≈ 0.44. The population-level dispersion of
 * damage given the median PGA is then back to HAZUS's 0.64 instead of being double counted (≈ 0.79).
 */
export const BETA_EFF = Math.sqrt(BETA_HAZUS ** 2 - SIGMA_LN_PGA ** 2 - 0.1 ** 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Storey count used for fragility class, period and collapse rates. OSM building:levels is occasionally wrong
 * by an order of magnitude (a 120-"storey" 11 m house, a 38-storey 15 m office), so it is capped by the measured
 * height at 2.8 m per storey (the lowest plausible floor-to-floor height).
 */
export function structuralLevels(b: BuildingRecord): number {
  const lv = Math.max(1, Math.round(b.levels || 1));
  return b.height > 3 ? Math.max(1, Math.min(lv, Math.round(b.height / 2.8))) : lv;
}

/** Landmarks other than the bridge are treated as seismically upgraded. */
export function isUpgradedLandmark(b: BuildingRecord): boolean {
  return !!b.landmark && b.landmark !== 'bay_bridge' && b.landmark !== 'other';
}

const CODE_RANK: Record<CodeLevel, number> = { pre: 0, low: 1, moderate: 2, high: 3 };

/** Design level used for fragility (landmarks raised to at least 'moderate'). */
export function effectiveCode(b: BuildingRecord): CodeLevel {
  return isUpgradedLandmark(b) && CODE_RANK[b.codeLevel] < CODE_RANK.moderate ? 'moderate' : b.codeLevel;
}

/** Capacity calibration factor on the equivalent-PGA medians (see header). */
export const KAPPA = 1.4;

/** HAZUS class used for the equivalent-PGA curves; SF UMB-retrofitted URM maps onto low-code RM1 (see header). */
export function pgaClass(b: BuildingRecord, levels: number): string {
  if (b.structure === 'URM' && effectiveCode(b) !== 'pre') return levels <= 2 ? 'RM1L' : 'RM1M';
  return hazusClass(b.structure, levels);
}

/** Effective equivalent-PGA medians (g) for this building and the active modifiers. */
export function effectiveMedians(b: BuildingRecord, liquefied: boolean, levels = structuralLevels(b)): Quad {
  const code = effectiveCode(b);
  // Retrofitted URM: RM1 curves at the URM's own level ('low' = bolts-plus UMB retrofit; landmarks 'moderate').
  const m = hazusMedians(pgaClass(b, levels), code).map((v) => v * KAPPA) as Quad;
  applySiteAndSystemModifiers(m, b, liquefied, levels);
  if (b.structure === 'URM' && code === 'pre') {
    m[0] *= 0.85;
    m[1] *= 0.85;
  }
  return m;
}

/** Soft/weak storey and liquefaction modifiers shared by both fragility paths (multiply the medians). */
function applySiteAndSystemModifiers(m: Quad, b: BuildingRecord, liquefied: boolean, levels: number): void {
  if (b.structure === 'W1_SOFT' || b.softStory) for (let k = 0; k < 4; k++) m[k] *= 0.6;
  if (liquefied) {
    const f = levels <= 3 ? 0.55 : levels <= 7 ? 0.75 : 0.9;
    for (let k = 0; k < 4; k++) m[k] *= f;
  }
}

/** Spectral-displacement medians (inches) with the same modifiers as the PGA path. */
export function effectiveSdMedians(b: BuildingRecord, liquefied: boolean, levels: number, heightM: number): Quad {
  const m = sdMedians(b.structure, effectiveCode(b), levels, heightM);
  applySiteAndSystemModifiers(m, b, liquefied, levels);
  return m;
}

/**
 * P(DS ≥ ds) for ds = 1..4 given this building's demand. Mid/high-rise engineered and infilled frames
 * (spectral.ts) use inelastic spectral displacement at their own period; everything else HAZUS equivalent PGA.
 */
export function exceedanceFor(inp: DamageInputs): { ex: Quad; method: 'sd' | 'pga'; demand: number } {
  const sb = inp.structural ?? inp.b;
  const levels = structuralLevels(sb);
  const ex: Quad = [0, 0, 0, 0];
  let lnD: number;
  let med: Quad;
  let beta: number;
  let method: 'sd' | 'pga';
  let demand: number;
  if (usesSpectral(sb.structure, levels)) {
    const height = sb.height > 0 ? sb.height : 3.7 * levels;
    const d = spectralDemand(sb.structure, effectiveCode(sb), levels, inp.pgaG, inp.pgvCms, inp.vs30, inp.magnitude);
    med = effectiveSdMedians(sb, inp.liquefied, levels, height);
    demand = d.sd;
    beta = BETA_SD_EFF;
    method = 'sd';
  } else {
    med = effectiveMedians(sb, inp.liquefied, levels);
    demand = inp.pgaG;
    beta = BETA_EFF;
    method = 'pga';
  }
  lnD = Math.log(Math.max(demand, 1e-6));
  for (let k = 0; k < 4; k++) {
    const p = normCdf((lnD - Math.log(med[k])) / beta);
    ex[k] = k > 0 ? Math.min(p, ex[k - 1]) : p;
  }
  return { ex, method, demand };
}

function collapseShape(b: BuildingRecord, levels: number, r: Rng): number {
  const s = b.structure;
  if (s === 'W1_SOFT' || (b.softStory && s.startsWith('W'))) return Math.min(0.6, 1 / levels + 0.1 * r());
  if (s === 'URM' || s === 'C3' || s === 'S5') return lerp(0.5, 0.9, r());
  if (s === 'W1' || s === 'W2') return lerp(0.4, 0.7, r());
  if (s === 'S1' || s === 'S2') return lerp(0.15, 0.35, r());
  if (levels <= 3) return lerp(0.4, 0.8, r());
  if (levels <= 7) return lerp(0.3, 0.6, r());
  return lerp(0.15, 0.3, r());
}

function debrisFor(b: BuildingRecord, state: DamageState, collapsed: boolean, collapseFraction: number, r: Rng): number {
  const H = Math.max(3, b.height || 3 * (b.levels || 1));
  const s = b.structure;
  const masonry = isMasonryLike(s);
  if (collapsed) {
    let k: number;
    let cap: number;
    if (masonry) [k, cap] = [lerp(0.4, 0.7, r()), 30];
    else if (s.startsWith('W')) [k, cap] = [lerp(0.25, 0.45, r()), 15];
    else if (s === 'S1' || s === 'S2') [k, cap] = [lerp(0.15, 0.3, r()), 25];
    else [k, cap] = [lerp(0.3, 0.5, r()), 25];
    return Math.min(cap, k * H * (0.45 + 0.55 * collapseFraction));
  }
  if (state === 4) return Math.min(masonry ? 18 : 12, (masonry ? lerp(0.2, 0.35, r()) : lerp(0.08, 0.18, r())) * H);
  if (state === 3) {
    if (s === 'URM' || s === 'C3' || s === 'S5') return Math.min(12, lerp(0.15, 0.3, r()) * H);
    return Math.min(5, lerp(0.03, 0.08, r()) * H);
  }
  if (state === 2 && s === 'URM' && b.codeLevel === 'pre' && r() < 0.5) return Math.min(5, lerp(0.08, 0.15, r()) * H);
  return 0;
}

function leanAngleFor(b: BuildingRecord, lv: number, state: DamageState, collapsed: boolean, liquefied: boolean, r: Rng): number {
  let deg = 0;
  const s = b.structure;
  if (collapsed) {
    if (s === 'W1_SOFT' || b.softStory) deg = lerp(8, 15, r());
    else if (s === 'URM' || s === 'C3' || s === 'S5') deg = lerp(0, 4, r());
    else deg = lerp(3, 8, r());
  } else if (state === 4) deg = lerp(5, 12, r());
  else if (state === 3) deg = lerp(2, 6, r());
  if (liquefied && state >= 3) deg += 3;
  // Taller buildings can't lean far without collapsing: cap by height class (of the whole building).
  if (!collapsed && lv >= 8) deg = Math.min(deg, 1.2);
  else if (!collapsed && lv >= 4) deg = Math.min(deg, 4);
  return deg * DEG;
}

/** Trapped share of occupants given collapse (Coburn, Spence & Pomonis 1992, M3). */
function trappedShareCollapse(b: BuildingRecord): number {
  const s = b.structure;
  if (isMasonryLike(s)) return 0.55;
  if (s.startsWith('W')) return 0.35;
  if (s === 'S1' || s === 'S2') return 0.5;
  return 0.7;
}

/** Ignitions per million ft² of floor area (HAZUS-style regression). */
export function ignitionRate(pgaG: number): number {
  return Math.max(0, 0.581895 * pgaG * pgaG - 0.029444 * pgaG);
}

export function computeDamage(inp: DamageInputs): { damage: BuildingDamage; ignBase: number; ignWeighted: number } {
  const { b, pgaG, liquefied, seed } = inp;
  const levels = structuralLevels(b);
  const groupKey = b.parentId ?? b.id;
  const rState = streamFor(seed, groupKey, 'state');
  const rCollapse = streamFor(seed, groupKey, 'collapse');
  const rv = streamFor(seed, groupKey, 'visual');

  const { ex } = exceedanceFor(inp);
  const u = isUpgradedLandmark(b) ? 0.15 + 0.85 * rState() : rState();
  let state = 0 as DamageState;
  for (let k = 0; k < 4; k++) if (u < ex[k]) state = (k + 1) as DamageState;

  const sLevels = structuralLevels(inp.structural ?? b);
  const cls = hazusClass(b.structure, sLevels);
  let collapsed = false;
  if (state === 4) {
    const pc = Math.min(
      0.9,
      collapseRate(b.structure, cls, effectiveCode(b)) * (liquefied && sLevels <= 3 ? 1.5 : 1) * (isUpgradedLandmark(b) ? 0.5 : 1),
    );
    collapsed = rCollapse() < pc;
  }

  let collapseFraction = 0;
  if (collapsed) collapseFraction = collapseShape(b, levels, rv);
  else if (liquefied && state >= 3 && levels <= 3) collapseFraction = lerp(0.02, 0.06, rv());

  // Lean direction: downhill + street frontage + random.
  const ra = rv() * Math.PI * 2;
  const wd = Math.min(1, inp.slope / 0.08) * 0.6 + (liquefied ? 0.6 : 0);
  let vx = Math.cos(ra) * 0.35 + inp.downhill[0] * wd;
  let vz = Math.sin(ra) * 0.35 + inp.downhill[1] * wd;
  if (inp.toStreet) {
    vx += inp.toStreet[0] * 0.5;
    vz += inp.toStreet[1] * 0.5;
  }
  const leanDirection = Math.atan2(vz, vx);
  const leanAngle = leanAngleFor(b, sLevels, state, collapsed, liquefied, rv);
  const debrisRadius = state >= 2 ? debrisFor(b, state, collapsed, collapseFraction, rv) : 0;

  // Failure time inside the strong-motion window.
  const pAt = state > 0 ? ex[state - 1] : 0;
  const f = Math.max(0.08, Math.min(0.85, 0.15 + 0.55 * (1 - pAt) + 0.12 * (rv() - 0.5)));
  const failTimeS = state > 0 ? inp.sArrivalS + inp.durationS * f : inp.sArrivalS + inp.durationS;

  // Fire ignition: expected HAZUS ignitions here (base) and the location weight (decided in index.ts).
  const floorFt2 = inp.footprintArea * levels * 10.7639;
  const wDs = [0.5, 0.8, 1.3, 2, 3][state];
  const wDens = Math.max(0.5, Math.min(2, inp.neighbours60 / 8));
  const wType = b.structure.startsWith('W') ? 1.3 : 1;
  const wSprinkler = b.yearBuilt >= 1975 && levels >= 7 ? 0.35 : 1;
  const ignBase = ignitionRate(pgaG) * (floorFt2 / 1e6);
  const ignWeighted = ignBase * wDs * wDens * wType * wSprinkler;

  // Casualties & trapped.
  const occ = occupantsAt(b, inp.hour);
  const rates = casualtyRates(b.structure, state, collapsed);
  const casualties: [number, number, number, number] = [
    occ * rates[0],
    occ * rates[1],
    occ * rates[2],
    occ * rates[3],
  ].map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
  let trappedExp = 0;
  if (collapsed) trappedExp = occ * trappedShareCollapse(b) * Math.min(1, 0.35 + 0.65 * collapseFraction);
  else if (state === 4) trappedExp = occ * 0.02;
  else if (state === 3) trappedExp = occ * 0.003;
  else if (state === 2) trappedExp = occ * 0.0002;
  const fl = Math.floor(trappedExp);
  const trappedEstimate = fl + (streamFor(seed, b.id, 'trapped')() < trappedExp - fl ? 1 : 0);

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const damage: BuildingDamage = {
    state,
    exceedance: ex.map(r3) as [number, number, number, number],
    collapsed,
    collapseFraction: r3(collapseFraction),
    leanDirection: r3(leanDirection),
    leanAngle: r3(leanAngle),
    debrisRadius: Math.round(debrisRadius * 10) / 10,
    fire: false,
    failTimeS: Math.round(failTimeS * 100) / 100,
    trappedEstimate,
    casualties,
  };
  return { damage, ignBase, ignWeighted };
}
