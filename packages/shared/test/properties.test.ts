import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeProgress,
  computeResult,
  computeVisibility,
  evaluateCondition,
  firstStepId,
  isInteractive,
  nextStepId,
  validateAnswer,
  validateState,
  type AnswerValue,
  type Answers,
  type Condition,
  type InteractiveStep,
  type ResolvedFunnel,
  resolveVariant,
  FunnelConfigSchema,
} from '../src/index.js';
import { funnel, mutated } from './helpers.js';

/**
 * Property-based tests: instead of a few hand-picked examples, fast-check generates hundreds of answer sets for the
 * real v1/v2/v3 configs (both variants) and checks invariants that must hold for every one of them. A failure is
 * shrunk to the smallest counter-example and is reproducible from the printed seed.
 */

/**
 * In the provided configs no result rule can see a hidden answer without its visibility condition (v3's
 * regulated_scale requires "compliance", which is also what shows security_constraints), so "hidden answers never
 * change the result" cannot fail there. This extra config adds a rule on the conditional office_days directly: there
 * the property only holds if the engine really evaluates rules on visible answers.
 */
const ruleOnConditional = resolveVariant(
  FunnelConfigSchema.parse(
    mutated(1, (c) => c.resultRules.unshift({ resultId: 'office_core', when: { answer: 'office_days', operator: 'gte', value: 1 } })),
  ),
  'A',
);

/**
 * Likewise, every visibleWhen in v1–v3 looks at an always-visible question, so "a hidden answer never opens a later
 * step" cannot fail on them. Here a new question is gated on the conditional office_days itself.
 */
const gateOnConditional = resolveVariant(
  FunnelConfigSchema.parse(
    mutated(1, (c) => {
      c.steps.hub_access = {
        id: 'hub_access',
        type: 'single-select',
        visibleWhen: { answer: 'office_days', operator: 'gte', value: 3 },
        content: { title: 'Does the team share one office hub?' },
        input: { name: 'hub_access', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
        validation: { required: true },
      };
      const seq: string[] = c.experiment.variants.A.stepSequence;
      seq.splice(seq.indexOf('office_days') + 1, 0, 'hub_access');
    }),
  ),
  'A',
);

const FUNNELS = [
  ...([1, 2, 3] as const).flatMap((v) => (['A', 'B'] as const).map((variant) => ({ name: `v${v}/${variant}`, f: funnel(v, variant) }))),
  { name: 'v1/A + a result rule on the conditional office_days', f: ruleOnConditional },
  { name: 'v1/A + a question gated on the conditional office_days', f: gateOnConditional },
];

const questions = (f: ResolvedFunnel): InteractiveStep[] =>
  f.sequence.map((id) => f.steps[id]).filter((s): s is InteractiveStep => s !== undefined && isInteractive(s));

/** A valid answer for a question, derived from its own config (options, limits, step). */
function validAnswer(step: InteractiveStep): fc.Arbitrary<AnswerValue> {
  switch (step.type) {
    case 'single-select':
      return fc.constantFrom(...step.input.options.map((o) => o.value));
    case 'multi-select': {
      const values = step.input.options.map((o) => o.value);
      const min = Math.max(1, step.validation?.minSelections ?? 1);
      const max = Math.min(values.length, step.validation?.maxSelections ?? values.length);
      return fc.subarray(values, { minLength: min, maxLength: max });
    }
    case 'number': {
      const min = step.input.min ?? 0;
      const max = step.input.max ?? min + 1000;
      const size = step.input.step ?? 1;
      return fc.integer({ min: 0, max: Math.floor((max - min) / size) }).map((k) => min + k * size);
    }
  }
}

/** A complete set of valid answers: every question of the funnel answered (hidden ones too). */
const completeAnswers = (f: ResolvedFunnel): fc.Arbitrary<Answers> =>
  fc.record(Object.fromEntries(questions(f).map((q) => [q.input.name, validAnswer(q)])) as Record<string, fc.Arbitrary<AnswerValue>>);

/** Follows Continue from the first step to the end, as the UI does. */
function walk(f: ResolvedFunnel, answers: Answers): string[] {
  const path = [firstStepId(f)];
  for (let next = nextStepId(f, answers, path[0] as string); next !== null; next = nextStepId(f, answers, next)) path.push(next);
  return path;
}

describe.each(FUNNELS)('engine invariants on $name', ({ f }) => {
  it('walking with Continue visits exactly the visible steps, in order, and ends on the result', () => {
    fc.assert(
      fc.property(completeAnswers(f), (answers) => {
        const path = walk(f, answers);
        expect(path).toEqual(computeVisibility(f, answers).visibleSteps);
        expect(f.steps[path[path.length - 1] as string]?.type).toBe('result');
      }),
    );
  });

  it('every prefix of that walk is a state the server accepts, with history rebuilt from visible steps', () => {
    fc.assert(
      fc.property(completeAnswers(f), (answers) => {
        const path = walk(f, answers);
        path.forEach((stepId, i) => {
          const asked = Object.fromEntries(
            path.slice(0, i).flatMap((id) => {
              const s = f.steps[id];
              return s && isInteractive(s) ? [[s.input.name, answers[s.input.name]]] : [];
            }),
          ) as Answers;
          const check = validateState(f, { answers: asked, history: ['tampered'], currentStepId: stepId });
          expect(check.ok).toBe(true);
          if (check.ok) expect(check.state.history).toEqual(path.slice(0, i));
        });
      }),
    );
  });

  it('progress counts only visible questions and moves forward by exactly one per question', () => {
    fc.assert(
      fc.property(completeAnswers(f), (answers) => {
        const visibleQuestions = walk(f, answers).filter((id) => {
          const s = f.steps[id];
          return s !== undefined && isInteractive(s);
        });
        visibleQuestions.forEach((id, i) => {
          expect(computeProgress(f, answers, id)).toEqual({ index: i + 1, count: visibleQuestions.length });
        });
      }),
    );
  });

  it('the result depends only on answers of visible steps: changing a hidden answer never changes it', () => {
    fc.assert(
      fc.property(completeAnswers(f), completeAnswers(f), (answers, other) => {
        const visible = new Set(computeVisibility(f, answers).visibleSteps);
        const mixed: Answers = { ...answers };
        for (const q of questions(f)) {
          if (!visible.has(q.id)) mixed[q.input.name] = other[q.input.name] as AnswerValue;
        }
        expect(computeResult(f, mixed)).toBe(computeResult(f, answers));
      }),
    );
  });

  it('hidden answers never change which steps are visible (nor, therefore, navigation and progress)', () => {
    fc.assert(
      fc.property(completeAnswers(f), completeAnswers(f), fc.boolean(), (answers, other, drop) => {
        const visible = computeVisibility(f, answers).visibleSteps;
        const mixed: Answers = { ...answers };
        for (const q of questions(f)) {
          if (visible.includes(q.id)) continue;
          if (drop) delete mixed[q.input.name];
          else mixed[q.input.name] = other[q.input.name] as AnswerValue;
        }
        expect(computeVisibility(f, mixed).visibleSteps).toEqual(visible);
      }),
    );
  });

  it('every generated answer passes validation; a number outside the configured range never does', () => {
    fc.assert(
      fc.property(completeAnswers(f), fc.integer({ min: 1, max: 10_000 }), (answers, offset) => {
        for (const q of questions(f)) {
          expect(validateAnswer(q, answers[q.input.name]).ok).toBe(true);
          if (q.type === 'number' && q.input.step !== undefined) {
            expect(validateAnswer(q, (q.input.min ?? 0) + q.input.step / 2).ok).toBe(false); // off the step grid
          }
          if (q.type === 'number' && q.input.max !== undefined) expect(validateAnswer(q, q.input.max + offset).ok).toBe(false);
          if (q.type === 'number' && q.input.min !== undefined) expect(validateAnswer(q, q.input.min - offset).ok).toBe(false);
        }
      }),
    );
  });
});

describe('condition DSL laws', () => {
  const leaf: fc.Arbitrary<Condition> = fc.oneof(
    fc.record({ answer: fc.constantFrom('mode', 'missing'), operator: fc.constant('eq' as const), value: fc.constantFrom('remote', 'hybrid') }),
    fc.record({ answer: fc.constantFrom('hours', 'missing'), operator: fc.constantFrom('gt' as const, 'lte' as const), value: fc.integer({ min: 0, max: 40 }) }),
    fc.record({ answer: fc.constantFrom('picks', 'missing'), operator: fc.constant('contains' as const), value: fc.constantFrom('focus', 'cost') }),
    fc.record({ answer: fc.constantFrom('mode', 'hours', 'missing'), operator: fc.constant('exists' as const) }),
  );
  const condition: fc.Arbitrary<Condition> = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc.record({ all: fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 3 }) }),
      fc.record({ any: fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 3 }) }),
      fc.record({ not: tie('node') as fc.Arbitrary<Condition> }),
    ),
  })).node;
  const answers: fc.Arbitrary<Answers> = fc.record(
    { mode: fc.constantFrom('remote', 'hybrid', 'office'), hours: fc.integer({ min: 0, max: 40 }), picks: fc.subarray(['focus', 'cost', 'speed']) },
    { requiredKeys: [] },
  );

  // Double negation and De Morgan hold in two-valued logic too; the law that separates three-valued logic is
  // monotonicity: once a condition is decided on partial answers, answering more questions cannot flip it.
  // That is the product rule "a branch never opens (or closes) before its answer is given". `exists` is excluded:
  // it is decided by the very presence of an answer.
  const decidedLeaf: fc.Arbitrary<Condition> = leaf.filter((l) => !('operator' in l) || l.operator !== 'exists');
  const decidedCondition: fc.Arbitrary<Condition> = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      decidedLeaf,
      fc.record({ all: fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 3 }) }),
      fc.record({ any: fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 3 }) }),
      fc.record({ not: tie('node') as fc.Arbitrary<Condition> }),
    ),
  })).node;
  const fullAnswers: fc.Arbitrary<Answers> = fc.record({
    mode: fc.constantFrom('remote', 'hybrid', 'office'),
    hours: fc.integer({ min: 0, max: 40 }),
    picks: fc.subarray(['focus', 'cost', 'speed']),
  });

  it('monotonic: a condition (or its negation) true on partial answers stays true when more questions are answered', () => {
    fc.assert(
      fc.property(decidedCondition, fullAnswers, fc.subarray(['mode', 'hours', 'picks']), (c, full, known) => {
        const partial = Object.fromEntries(known.map((k) => [k, full[k] as AnswerValue])) as Answers;
        if (evaluateCondition(c, partial)) expect(evaluateCondition(c, full)).toBe(true);
        if (evaluateCondition({ not: c }, partial)) expect(evaluateCondition({ not: c }, full)).toBe(true);
      }),
    );
  });

  it('double negation is the identity', () => {
    fc.assert(
      fc.property(condition, answers, (c, a) => {
        expect(evaluateCondition({ not: { not: c } }, a)).toBe(evaluateCondition(c, a));
      }),
    );
  });

  it("De Morgan: not(all) equals any(not), not(any) equals all(not) — also when answers are missing", () => {
    fc.assert(
      fc.property(fc.array(condition, { minLength: 1, maxLength: 3 }), answers, (cs, a) => {
        const nots = cs.map((c) => ({ not: c }));
        expect(evaluateCondition({ not: { all: cs } }, a)).toBe(evaluateCondition({ any: nots }, a));
        expect(evaluateCondition({ not: { any: cs } }, a)).toBe(evaluateCondition({ all: nots }, a));
      }),
    );
  });

  it('an unanswered question never opens a branch: a leaf on a missing answer is false, and so is its negation', () => {
    fc.assert(
      fc.property(leaf, (l) => {
        if (!('answer' in l) || l.operator === 'exists') return;
        const onMissing = { ...l, answer: 'missing' } as Condition;
        expect(evaluateCondition(onMissing, {})).toBe(false);
        expect(evaluateCondition({ not: onMissing }, {})).toBe(false);
      }),
    );
  });
});
