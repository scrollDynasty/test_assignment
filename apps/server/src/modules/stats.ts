/**
 * Small, dependency-free statistics for the A/B report. Pure functions, unit-tested in stats.test.ts.
 *
 * Conventions: every rate with a zero denominator is `null` (never NaN / Infinity), so the JSON the
 * dashboard receives never contains values it cannot render.
 */

/** z for a two-sided 95% interval (alpha = 0.05). */
export const Z_95 = 1.959963984540054;
/** z for power 0.8 (one-sided quantile of 0.8). */
export const Z_POWER_80 = 0.8416212335729143;

import type { Interval } from '@funnel/shared';

export type { Interval };

/** a / b, or null when b is 0. */
export function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

/**
 * Error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). Good enough for p-values that are
 * displayed with 3-4 significant digits and compared to thresholds like 0.05 / 0.001.
 */
export function erf(x: number): number {
  return x < 0 ? erfc(-x) - 1 : 1 - erfc(x);
}

/**
 * Complementary error function, same approximation. For x >= 0 it is computed directly as
 * poly(t) * exp(-x²), so tiny tail probabilities (an SRM p of 1e-40) keep their relative precision.
 */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x === 0) return 1; // the polynomial sums to 0.999999999 here
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return poly * Math.exp(-x * x);
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Two-sided p-value of a standard normal statistic, P(|Z| >= |z|). */
export function twoSidedP(z: number): number {
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
}

/** Wilson score 95% interval for x successes out of n. null when n = 0. */
export function wilson(x: number, n: number, z = Z_95): Interval | null {
  if (n === 0) return null;
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At x = 0 / x = n the bound is exactly 0 / 1 analytically; avoid 0.9999999999999999 from rounding.
  return [x === 0 ? 0 : Math.max(0, center - half), x === n ? 1 : Math.min(1, center + half)];
}

/**
 * Newcombe's hybrid score interval (method 10, Newcombe 1998) for the difference pB − pA,
 * built from the two Wilson intervals. null when either arm is empty.
 */
export function newcombeDiff(xA: number, nA: number, xB: number, nB: number): Interval | null {
  const ciA = wilson(xA, nA);
  const ciB = wilson(xB, nB);
  if (!ciA || !ciB) return null;
  const pA = xA / nA;
  const pB = xB / nB;
  const d = pB - pA;
  const lower = d - Math.sqrt((pB - ciB[0]) ** 2 + (ciA[1] - pA) ** 2);
  const upper = d + Math.sqrt((ciB[1] - pB) ** 2 + (pA - ciA[0]) ** 2);
  return [lower, upper];
}

/**
 * Two-proportion z-test with pooled variance, two-sided. When the pooled rate is 0 or 1 both arms are
 * identical (all 0 or all 1): z = 0, p = 1. null when either arm is empty.
 */
export function twoProportionZTest(xA: number, nA: number, xB: number, nB: number): { z: number; pValue: number } | null {
  if (nA === 0 || nB === 0) return null;
  const pooled = (xA + xB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (xB / nB - xA / nA) / se;
  return { z, pValue: twoSidedP(z) };
}

/**
 * Minimum detectable effect (absolute difference of proportions) for a two-sided test at alpha = 0.05
 * and power = 0.8, given the actual arm sizes and the pooled baseline rate:
 *   MDE = (z_{1-α/2} + z_{power}) * sqrt(p(1-p) (1/nA + 1/nB)).
 * null when an arm is empty or the baseline is degenerate (0 or 1 — no variance to reason about).
 */
export function mde(baseline: number, nA: number, nB: number): number | null {
  if (nA === 0 || nB === 0 || baseline <= 0 || baseline >= 1) return null;
  return (Z_95 + Z_POWER_80) * Math.sqrt(baseline * (1 - baseline) * (1 / nA + 1 / nB));
}

/**
 * Sample ratio mismatch: chi-square goodness-of-fit of observed arm sizes against the configured
 * weights. With two arms df = 1, and P(χ²₁ ≥ x) = erfc(sqrt(x / 2)) exactly.
 * null when there are no observations or not exactly two arms.
 */
export function srmChiSquare(observed: number[], weights: number[]): { chi2: number; pValue: number } | null {
  if (observed.length !== 2 || weights.length !== 2) return null;
  const total = observed.reduce((s, v) => s + v, 0);
  const wTotal = weights.reduce((s, v) => s + v, 0);
  if (total === 0 || wTotal <= 0) return null;
  let chi2 = 0;
  for (let i = 0; i < 2; i++) {
    const expected = (total * (weights[i] ?? 0)) / wTotal;
    if (expected <= 0) return null;
    chi2 += ((observed[i] ?? 0) - expected) ** 2 / expected;
  }
  return { chi2, pValue: Math.min(1, erfc(Math.sqrt(chi2 / 2))) };
}
