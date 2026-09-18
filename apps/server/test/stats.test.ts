import { describe, expect, it } from 'vitest';
import { erf, mde, newcombeDiff, normalCdf, ratio, srmChiSquare, twoProportionZTest, twoSidedP, wilson } from '../src/modules/stats.js';

describe('stats — normal distribution', () => {
  it('erf / normal CDF match table values', () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
    expect(erf(-1)).toBeCloseTo(-0.8427008, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 6);
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 6);
    expect(twoSidedP(0)).toBe(1);
  });
});

describe('stats — Wilson interval', () => {
  it('10 of 20 → [0.2993, 0.7007]', () => {
    const ci = wilson(10, 20);
    expect(ci?.[0]).toBeCloseTo(0.2993, 4);
    expect(ci?.[1]).toBeCloseTo(0.7007, 4);
  });

  it('stays inside [0, 1] at the edges and is null for n = 0', () => {
    const zero = wilson(0, 10);
    expect(zero?.[0]).toBe(0);
    expect(zero?.[1]).toBeCloseTo(0.2775, 4);
    const all = wilson(10, 10);
    expect(all?.[0]).toBeCloseTo(0.7225, 4);
    expect(all?.[1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('stats — Newcombe hybrid interval for a difference', () => {
  it('Newcombe (1998) example (a), method 10: 56/70 vs 48/80 → diff 0.2, CI [0.0524, 0.3339]', () => {
    // b − a with a = 48/80, b = 56/70.
    const ci = newcombeDiff(48, 80, 56, 70);
    expect(ci?.[0]).toBeCloseTo(0.0524, 4);
    expect(ci?.[1]).toBeCloseTo(0.3339, 4);
  });

  it('is null when an arm is empty', () => {
    expect(newcombeDiff(0, 0, 1, 2)).toBeNull();
  });
});

describe('stats — two-proportion z-test (pooled)', () => {
  it('200/1000 vs 250/1000: z = 2.677, p ≈ 0.0074', () => {
    const t = twoProportionZTest(200, 1000, 250, 1000);
    expect(t?.z).toBeCloseTo(2.6774, 3);
    expect(t?.pValue).toBeCloseTo(0.00742, 4);
  });

  it('identical arms give p = 1; degenerate pooled rate does not produce NaN', () => {
    expect(twoProportionZTest(30, 100, 30, 100)?.pValue).toBeCloseTo(1, 6);
    expect(twoProportionZTest(0, 100, 0, 50)).toEqual({ z: 0, pValue: 1 });
    expect(twoProportionZTest(1, 0, 1, 2)).toBeNull();
  });
});

describe('stats — MDE and SRM', () => {
  it('MDE at alpha 0.05 / power 0.8 for p = 0.1, 1000 per arm ≈ 0.0376', () => {
    expect(mde(0.1, 1000, 1000)).toBeCloseTo(0.03759, 4);
    expect(mde(0, 1000, 1000)).toBeNull();
    expect(mde(0.1, 0, 1000)).toBeNull();
  });

  it('SRM chi-square: balanced split is fine, 500/500 against 70/30 weights is a mismatch', () => {
    expect(srmChiSquare([500, 500], [50, 50])).toEqual({ chi2: 0, pValue: 1 });
    const mild = srmChiSquare([520, 480], [50, 50]);
    expect(mild?.chi2).toBeCloseTo(1.6, 10);
    expect(mild?.pValue).toBeCloseTo(0.2059, 4);
    const bad = srmChiSquare([500, 500], [70, 30]);
    expect(bad?.chi2).toBeCloseTo(190.476, 3);
    expect(bad?.pValue).toBeGreaterThan(0);
    expect(bad?.pValue).toBeLessThan(1e-40);
    expect(srmChiSquare([0, 0], [50, 50])).toBeNull();
  });

  it('ratio never returns NaN', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});
