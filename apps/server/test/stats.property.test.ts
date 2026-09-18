import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assignVariant } from '../src/modules/assignment.js';
import { mde, newcombeDiff, srmChiSquare, twoProportionZTest, wilson } from '../src/modules/stats.js';

/**
 * Laws the statistics on the dashboard must obey for any counts, not only for the textbook examples in
 * stats.test.ts. Each property runs on hundreds of generated inputs.
 */

/** A proportion as (successes, trials) with successes ≤ trials. */
const counts = fc.integer({ min: 1, max: 5000 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)));

describe('confidence intervals and tests', () => {
  it('Wilson interval stays inside [0, 1] and contains the observed rate', () => {
    fc.assert(
      fc.property(counts, ([x, n]) => {
        const ci = wilson(x, n);
        expect(ci).not.toBeNull();
        const [lo, hi] = ci as [number, number];
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(1);
        expect(lo).toBeLessThanOrEqual(x / n + 1e-12);
        expect(hi).toBeGreaterThanOrEqual(x / n - 1e-12);
      }),
    );
  });

  it('Wilson interval narrows as the sample grows at the same rate', () => {
    fc.assert(
      fc.property(counts, fc.integer({ min: 2, max: 20 }), ([x, n], k) => {
        const [lo1, hi1] = wilson(x, n) as [number, number];
        const [lo2, hi2] = wilson(x * k, n * k) as [number, number];
        expect(hi2 - lo2).toBeLessThanOrEqual(hi1 - lo1 + 1e-12);
      }),
    );
  });

  it('Newcombe interval for B − A lies in [−1, 1], contains the observed difference and flips sign when arms swap', () => {
    fc.assert(
      fc.property(counts, counts, ([xA, nA], [xB, nB]) => {
        const [lo, hi] = newcombeDiff(xA, nA, xB, nB) as [number, number];
        const diff = xB / nB - xA / nA;
        expect(lo).toBeGreaterThanOrEqual(-1 - 1e-12);
        expect(hi).toBeLessThanOrEqual(1 + 1e-12);
        expect(lo).toBeLessThanOrEqual(diff + 1e-12);
        expect(hi).toBeGreaterThanOrEqual(diff - 1e-12);
        const [sLo, sHi] = newcombeDiff(xB, nB, xA, nA) as [number, number];
        expect(sLo).toBeCloseTo(-hi, 12);
        expect(sHi).toBeCloseTo(-lo, 12);
      }),
    );
  });

  it('z-test p-value is a probability, symmetric in the arms, and 1 for identical arms', () => {
    fc.assert(
      fc.property(counts, counts, ([xA, nA], [xB, nB]) => {
        const t = twoProportionZTest(xA, nA, xB, nB);
        if (t === null) return; // both arms at 0% or 100%: no variance, the test is undefined by design
        expect(t.pValue).toBeGreaterThanOrEqual(0);
        expect(t.pValue).toBeLessThanOrEqual(1);
        expect(twoProportionZTest(xB, nB, xA, nA)?.pValue).toBeCloseTo(t.pValue, 12);
        expect(twoProportionZTest(xA, nA, xA, nA)?.pValue ?? 1).toBeCloseTo(1, 12);
      }),
    );
  });

  it('the minimum detectable effect shrinks when both arms grow', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 0.95, noNaN: true }), fc.integer({ min: 20, max: 2000 }), (p, n) => {
        const small = mde(p, n, n);
        const large = mde(p, n * 4, n * 4);
        expect(small).not.toBeNull();
        expect(large).not.toBeNull();
        expect(large as number).toBeLessThan(small as number);
      }),
    );
  });

  it('SRM check (two arms): counts exactly proportional to the weights are never flagged; more skew, smaller p', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 }), fc.integer({ min: 10, max: 200 }), (wA, wB, k) => {
        const even = srmChiSquare([wA * k, wB * k], [wA, wB]);
        expect(even?.chi2).toBeCloseTo(0, 9);
        expect(even?.pValue).toBeCloseTo(1, 9);
        const skewed = srmChiSquare([wA * k + k, wB * k], [wA, wB]);
        const moreSkewed = srmChiSquare([wA * k + 2 * k, wB * k], [wA, wB]);
        expect(moreSkewed?.pValue ?? 1).toBeLessThan(skewed?.pValue ?? 0);
      }),
    );
  });

  it('SRM check is defined for exactly two arms (the experiments are A/B) and says so with null otherwise', () => {
    expect(srmChiSquare([10, 10, 10], [1, 1, 1])).toBeNull();
    expect(srmChiSquare([10], [1])).toBeNull();
  });
});

describe('A/B assignment', () => {
  const variants = fc
    .uniqueArray(fc.constantFrom('A', 'B', 'C', 'D'), { minLength: 1, maxLength: 4 })
    .chain((names) => fc.tuple(...names.map((n) => fc.integer({ min: 0, max: 10 }).map((w) => [n, { weight: w }] as const))))
    .map((entries) => Object.fromEntries(entries))
    .filter((v) => Object.values(v).some((x) => x.weight > 0));

  it('is deterministic and only ever picks a variant with positive weight', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.uuid(), variants, (experiment, session, v) => {
        const picked = assignVariant(experiment, session, v);
        expect(assignVariant(experiment, session, v)).toBe(picked);
        expect(v[picked]?.weight ?? 0).toBeGreaterThan(0);
      }),
    );
  });

  it('splits traffic by the configured weights (20 000 fixed sessions, 50/50 and 70/30)', () => {
    const sessions = Array.from({ length: 20_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const [wA, wB] of [[50, 50], [70, 30]] as const) {
      const counts = { A: 0, B: 0 };
      for (const s of sessions) counts[assignVariant('exp-split', s, { A: { weight: wA }, B: { weight: wB } }) as 'A' | 'B']++;
      expect(counts.A / sessions.length).toBeCloseTo(wA / (wA + wB), 1);
      // A healthy hash passes our own sample-ratio-mismatch check.
      expect(srmChiSquare([counts.A, counts.B], [wA, wB])?.pValue).toBeGreaterThan(1e-4);
    }
  });

  it('does not depend on the order in which variants are listed in the config', () => {
    fc.assert(
      fc.property(fc.uuid(), variants, (session, v) => {
        const reversed = Object.fromEntries(Object.entries(v).reverse());
        expect(assignVariant('exp', session, reversed)).toBe(assignVariant('exp', session, v));
      }),
    );
  });
});
