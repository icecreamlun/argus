/**
 * Pure functions of simulation time (seconds after origin) shared by every FX subsystem.
 * Nothing here keeps state, so seek(t) reproduces the exact same visual state.
 */

export const G = 9.81;
export const TAU = Math.PI * 2;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Strong-motion envelope (0..1) at a site.
 *   P phase (pA..sA): a light rattle that ramps up to ~0.13.
 *   S phase: fast rise (~0.7 s), a plateau for ~35 % of the strong-motion duration D, then an
 *   exponential coda — close in shape to Saragoni–Hart / Boore stochastic envelopes.
 */
export function shakeEnvelope(t: number, pA: number, sA: number, D: number): number {
  if (t < pA) return 0;
  const p = 0.13 * smoothstep(0, 1.4, t - pA);
  if (t < sA) return p;
  const tau = t - sA;
  const rise = 1 - Math.exp(-tau / 0.7);
  const hold = 0.35 * D;
  const decay = tau > hold ? Math.exp(-(tau - hold) / (0.22 * D + 1.5)) : 1;
  return Math.max(p * Math.exp(-tau / 2), rise * decay);
}

/** P-phase share of the envelope (for the high-frequency rattle), 0 once S dominates. */
export function pPhase(t: number, pA: number, sA: number): number {
  if (t < pA) return 0;
  return smoothstep(0, 0.8, t - pA) * (t < sA ? 1 : Math.exp(-(t - sA) / 1.2));
}

/**
 * Quasi-random oscillation with unit-ish amplitude around frequency f (Hz): three detuned partials with a
 * slow phase wander so neighbouring buildings with similar periods drift in and out of phase.
 */
export function wobble(t: number, f: number, ph: number): number {
  const a = TAU * f * t + ph + 0.9 * Math.sin(TAU * 0.21 * t + ph * 1.7);
  return 0.66 * Math.sin(a) + 0.26 * Math.sin(1.73 * a + ph * 2.3) + 0.14 * Math.sin(2.91 * a + 0.7 * ph);
}

/** Collapse progress 0..1 with a gravity ease-in (s ∝ t²) — the mass accelerates as storeys give way. */
export function collapseFall(t: number, tf: number, dur: number): number {
  const p = clamp01((t - tf) / dur);
  return p * p;
}

/** Ease-out ramp (0..1) over `dur` seconds starting at t0. */
export function easeOut(t: number, t0: number, dur: number): number {
  const q = clamp01((t - t0) / dur);
  return 1 - (1 - q) * (1 - q) * (1 - q);
}

/** Collapse duration (s): free fall of the lost height, slowed by the resisting structure, clamped to 1.5–4 s. */
export function collapseDuration(height: number, collapseFraction: number): number {
  const drop = Math.max(1, height * collapseFraction);
  return Math.min(4, Math.max(1.5, 1.35 * Math.sqrt((2 * drop) / G)));
}

/** Deterministic flicker 0/1 (lights stuttering as the grid fails). */
export function flicker(t: number, seed: number, rate = 11): number {
  const k = Math.floor(t * rate);
  const h = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
  return h - Math.floor(h) > 0.5 ? 1 : 0;
}
