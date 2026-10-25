/**
 * Deterministic randomness for the quake model.
 *
 * - mulberry32: tiny, fast 32-bit PRNG (Tommy Ettinger, public domain). Same seed → same sequence.
 * - hashString / hash2: 32-bit integer hashing (FNV-1a + murmur3 finaliser) used to derive an
 *   independent stream per (seed, building, purpose), so results never depend on iteration order.
 * - GaussianField: a stationary, unit-variance, spatially correlated Gaussian random field built with
 *   random Fourier features (Rahimi & Recht 2007; the "spectral method" of Shinozuka & Deodatis 1991):
 *       f(p) = sqrt(2/K) · Σ_k cos(ω_k · p + φ_k),   ω_k ~ N(0, I/ℓ²),  φ_k ~ U(0, 2π)
 *   whose covariance tends to exp(-h² / (2ℓ²)) as K grows. We use it for the within-event ground-motion
 *   residual (neighbouring buildings shake alike) and for patchy liquefaction.
 */

export type Rng = () => number;

/** mulberry32 → uniform [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** murmur3 32-bit finaliser. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a string hash, finalised. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** Combine two 32-bit values into one well-mixed hash. */
export function hash2(a: number, b: number): number {
  return fmix32((a ^ Math.imul(b >>> 0, 0x9e3779b1)) >>> 0);
}

/** Independent PRNG stream for (seed, key, purpose). */
export function streamFor(seed: number, key: string, purpose: string): Rng {
  return mulberry32(hash2(hash2(seed >>> 0, hashString(key)), hashString(purpose)));
}

/** Standard normal via Box–Muller (uses two uniforms). */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standard normal CDF Φ(x) (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Unit-variance correlated Gaussian field over the plane (coordinates in km). */
export interface GaussianField {
  (eKm: number, nKm: number): number;
}

/**
 * Build a field as a variance-weighted mix of octaves, each a random-Fourier-feature field with its own
 * correlation length ℓ (km). Weights are variances and are normalised so the result has unit variance.
 */
export function createGaussianField(seed: number, octaves: { lengthKm: number; weight: number }[], wavesPerOctave = 48): GaussianField {
  const rng = mulberry32(seed);
  const total = octaves.reduce((s, o) => s + o.weight, 0);
  const kx: number[] = [];
  const ky: number[] = [];
  const ph: number[] = [];
  const amp: number[] = [];
  for (const o of octaves) {
    const a = Math.sqrt((2 * o.weight) / (total * wavesPerOctave));
    for (let k = 0; k < wavesPerOctave; k++) {
      kx.push(gaussian(rng) / o.lengthKm);
      ky.push(gaussian(rng) / o.lengthKm);
      ph.push(rng() * Math.PI * 2);
      amp.push(a);
    }
  }
  const n = kx.length;
  return (e, nn) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += amp[i] * Math.cos(kx[i] * e + ky[i] * nn + ph[i]);
    return s;
  };
}
