import { describe, expect, it } from 'vitest';
import {
  computeProgress,
  computeResult,
  computeVisibility,
  evaluateCondition,
  filterEventProperties,
  initialState,
  nextStepId,
  resolveVariant,
  FunnelConfigSchema,
  validateAnswer,
  validateConfig,
  validateState,
  type Answers,
  type Condition,
  type InteractiveStep,
  type ResolvedFunnel,
} from '../src/index.js';
import { config, funnel, mutated, rawConfig, type LooseJson } from './helpers.js';

function question(f: ResolvedFunnel, id: string): InteractiveStep {
  const step = f.steps[id];
  if (!step || step.type === 'info' || step.type === 'result') throw new Error(`${id} is not a question`);
  return step;
}

describe('validateConfig', () => {
  it.each([1, 2, 3] as const)('accepts provided funnel-v%i.json unchanged', (v) => {
    const result = validateConfig(rawConfig(v));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each([
    ['unknown step in a sequence', (c: LooseJson) => c.experiment.variants.B.stepSequence.splice(1, 0, 'ghost'), 'unknown step "ghost"'],
    ['branch that looks forward', (c: LooseJson) => {
      const seq: string[] = c.experiment.variants.B.stepSequence;
      seq.splice(seq.indexOf('office_days'), 1);
      seq.splice(1, 0, 'office_days'); // before work_mode, which office_days depends on
    }, 'is not asked before "office_days"'],
    ['unsupported step type', (c: LooseJson) => { c.steps.team_size.type = 'slider'; }, 'Invalid discriminator'],
    ['unsupported operator', (c: LooseJson) => { c.steps.office_days.visibleWhen.operator = 'matches'; }, 'steps.office_days.visibleWhen'],
    ['result step not last', (c: LooseJson) => { c.experiment.variants.A.stepSequence.reverse(); }, 'exactly one result step'],
    ['override of a missing step', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.ghost = { content: {} }; }, 'stepOverrides.ghost'],
    ['rule pointing to a missing result', (c: LooseJson) => { c.resultRules[0].resultId = 'ghost'; }, 'resultRules.0.resultId'],
    ['default result missing', (c: LooseJson) => { c.defaultResultId = 'ghost'; }, 'defaultResultId'],
    // Rules must hold for what a variant shows after overrides, not just the base steps.
    ['override turning a question into a second result step', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.team_size = { type: 'result' }; }, 'exactly one result step'],
    ['override reusing another input name', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.team_size = { input: { name: 'work_mode' } }; }, 'is asked twice'],
    ['override adding a forward-looking branch', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.team_size = { visibleWhen: { answer: 'tool_count', operator: 'gte', value: 3 } }; }, 'is not asked before "team_size"'],
    ['override removing options the rules rely on', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.work_mode = { input: { options: [{ value: 'remote', label: 'Remote' }] } }; }, 'unknown option "hybrid"'],
    ['condition with a misspelt option', (c: LooseJson) => { c.steps.office_days.visibleWhen.value = ['hybrd', 'office']; }, 'expects an array of options'],
    ['in with a scalar value', (c: LooseJson) => { c.steps.office_days.visibleWhen.value = 'hybrid'; }, 'expects an array of options'],
    ['numeric comparison with a string', (c: LooseJson) => { c.resultRules[1].when = { answer: 'team_size', operator: 'gte', value: '15' }; }, 'expects a number'],
    ['contains on a single-select answer', (c: LooseJson) => { c.resultRules[1].when = { answer: 'work_mode', operator: 'contains', value: 'hybrid' }; }, 'only valid for multi-select'],
    ['a conditional result step', (c: LooseJson) => { c.steps.result.visibleWhen = { answer: 'work_mode', operator: 'eq', value: 'office' }; }, 'must always be reachable'],
    // Unanswerable questions: a published version must not be able to trap every new session on one step.
    ['more required selections than options', (c: LooseJson) => { c.steps.priorities.validation.minSelections = 99; }, 'only 5 options'],
    ['minSelections above maxSelections', (c: LooseJson) => { c.steps.priorities.validation.minSelections = 3; c.steps.priorities.validation.maxSelections = 2; }, 'greater than maxSelections'],
    ['a number range with min above max', (c: LooseJson) => { c.steps.team_size.input.min = 10; c.steps.team_size.input.max = 5; }, 'no answer is possible'],
    ['duplicate option values', (c: LooseJson) => { c.steps.work_mode.input.options.push({ value: 'remote', label: 'Remote again' }); }, 'duplicate option values'],
    ['an override that renames a step', (c: LooseJson) => { c.experiment.variants.B.stepOverrides.team_size = { id: 'renamed' }; }, 'changes the id'],
    ['a misspelt progress exclusion', (c: LooseJson) => { c.progress.excludeTypes = ['inf0']; }, 'unknown step type "inf0"'],
  ] as const)('rejects a config with %s', (_label, mutate, expected) => {
    const result = validateConfig(mutated(1, mutate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => `${e.path}: ${e.message}`).join('\n')).toContain(expected);
  });
});

describe('evaluateCondition', () => {
  const answers: Answers = { mode: 'hybrid', hours: 15, picks: ['focus', 'compliance'] };
  it.each<[Condition, boolean]>([
    [{ answer: 'constructor', operator: 'exists' }, false], // inherited keys are not answers
    [{ answer: 'mode', operator: 'eq', value: 'hybrid' }, true],
    [{ answer: 'mode', operator: 'neq', value: 'hybrid' }, false],
    [{ answer: 'mode', operator: 'in', value: ['hybrid', 'office'] }, true],
    [{ answer: 'mode', operator: 'not_in', value: ['hybrid', 'office'] }, false],
    [{ answer: 'hours', operator: 'gte', value: 15 }, true],
    [{ answer: 'hours', operator: 'gt', value: 15 }, false],
    [{ answer: 'hours', operator: 'lt', value: 16 }, true],
    [{ answer: 'hours', operator: 'lte', value: 14 }, false],
    [{ answer: 'picks', operator: 'contains', value: 'compliance' }, true],
    [{ answer: 'picks', operator: 'contains', value: 'cost' }, false],
    [{ answer: 'picks', operator: 'in', value: ['cost', 'focus'] }, true],
    [{ answer: 'mode', operator: 'exists' }, true],
    [{ answer: 'missing', operator: 'neq', value: 'x' }, false],
    [{ answer: 'missing', operator: 'not_in', value: ['x'] }, false],
    [{ not: { answer: 'missing', operator: 'exists' } }, true],
    [{ answer: 'missing', operator: 'exists' }, false],
    // Three-valued logic: not(unknown) stays unknown, so an unanswered question never opens a branch.
    [{ not: { answer: 'missing', operator: 'eq', value: 'x' } }, false],
    [{ any: [{ answer: 'missing', operator: 'eq', value: 1 }, { answer: 'mode', operator: 'eq', value: 'hybrid' }] }, true],
    [{ not: { all: [{ answer: 'missing', operator: 'eq', value: 1 }, { answer: 'mode', operator: 'eq', value: 'remote' }] } }, true],
    [{ all: [{ answer: 'mode', operator: 'eq', value: 'hybrid' }, { answer: 'hours', operator: 'gte', value: 20 }] }, false],
    [{ any: [{ answer: 'mode', operator: 'eq', value: 'remote' }, { answer: 'hours', operator: 'gte', value: 10 }] }, true],
  ])('%j -> %s', (condition, expected) => {
    expect(evaluateCondition(condition, answers)).toBe(expected);
  });
});

describe('resolveVariant', () => {
  it('uses the variant order and deep-merges partial overrides', () => {
    const b = funnel(1, 'B');
    expect(b.sequence).toEqual(config(1).experiment.variants.B?.stepSequence);
    const intro = b.steps.intro;
    expect(intro?.content.title).toBe('How should your team really work?');
    expect(intro?.type).toBe('info');
    const priorities = question(b, 'priorities');
    expect(priorities.content.title).toBe('What would make the biggest difference right now?');
    expect(priorities.type === 'multi-select' && priorities.input.options).toHaveLength(5); // kept from base step
    expect(b.results.hybrid_structured?.title).toBe('Your hybrid model needs clearer rules');
    expect(b.results.hybrid_structured?.summary).toContain('clear reason for office days'); // kept from base result
    expect(funnel(1, 'A').results.hybrid_structured?.title).toBe('Structured hybrid');
  });

  it('v3 variant B does not contain tool_count', () => {
    expect(funnel(3, 'B').sequence).not.toContain('tool_count');
    expect(funnel(3, 'B').steps.tool_count).toBeUndefined();
    expect(funnel(3, 'A').sequence).toContain('tool_count');
  });
});

describe('branching, navigation and progress', () => {
  it('v1: office_days is shown only for hybrid/office', () => {
    const a = funnel(1, 'A');
    expect(nextStepId(a, { work_mode: 'remote' }, 'timezone_span')).toBe('async_maturity');
    expect(nextStepId(a, { work_mode: 'hybrid' }, 'timezone_span')).toBe('office_days');
    expect(nextStepId(a, {}, 'tool_count')).toBe('result');
    expect(nextStepId(a, {}, 'result')).toBeNull();
  });

  it('progress counts only visible questions and grows when a branch opens', () => {
    const a = funnel(1, 'A');
    expect(computeProgress(a, {}, 'intro')).toEqual({ index: 0, count: 6 });
    expect(computeProgress(a, { team_size: 5 }, 'team_size')).toEqual({ index: 1, count: 6 });
    expect(computeProgress(a, { team_size: 5, work_mode: 'office' }, 'work_mode')).toEqual({ index: 2, count: 7 });
    expect(computeProgress(a, { team_size: 5, work_mode: 'remote' }, 'result')).toEqual({ index: 6, count: 6 });
  });

  it('v3: security_constraints appears only when compliance is selected', () => {
    const a = funnel(3, 'A');
    const base = { team_size: 8, work_mode: 'remote' };
    expect(computeProgress(a, { ...base, priorities: ['focus'] }, 'priorities').count).toBe(7);
    expect(computeProgress(a, { ...base, priorities: ['focus', 'compliance'] }, 'priorities').count).toBe(8);
    expect(nextStepId(a, { ...base, priorities: ['compliance'] }, 'priorities')).toBe('security_constraints');
    expect(nextStepId(a, { ...base, priorities: ['focus'] }, 'priorities')).toBe('timezone_span');
  });

  it('answers of hidden steps are kept but ignored', () => {
    const a = funnel(3, 'A');
    const answers: Answers = { work_mode: 'remote', priorities: ['focus'], security_constraints: 'strict' };
    const { visibleSteps, effectiveAnswers } = computeVisibility(a, answers);
    expect(visibleSteps).not.toContain('security_constraints');
    expect(effectiveAnswers.security_constraints).toBeUndefined();

    // A rule that looks ONLY at the hidden answer proves it is ignored (with raw answers it would match).
    const raw = rawConfig(3) as LooseJson;
    raw.resultRules[0].when = { answer: 'security_constraints', operator: 'in', value: ['strict', 'regulated'] };
    const onlyHidden = resolveVariant(FunnelConfigSchema.parse(raw), 'A');
    expect(computeResult(onlyHidden, answers)).not.toBe('regulated_scale');
    expect(computeResult(onlyHidden, { ...answers, priorities: ['compliance'] })).toBe('regulated_scale');
  });

  it('rejects an unknown current step instead of silently restarting', () => {
    expect(() => nextStepId(funnel(1, 'A'), {}, 'ghost')).toThrow();
  });

  it('initial state starts at the first visible step', () => {
    expect(initialState(funnel(1, 'B'))).toEqual({ answers: {}, history: [], currentStepId: 'intro' });
  });
});

describe('computeResult follows rule order', () => {
  it.each<[1 | 2 | 3, Answers, string]>([
    [1, { work_mode: 'remote', timezone_span: 'wide', async_maturity: 'low' }, 'async_native'],
    [1, { work_mode: 'office', timezone_span: 'same', async_maturity: 'high' }, 'async_native'],
    [1, { work_mode: 'hybrid', timezone_span: 'same', async_maturity: 'low' }, 'hybrid_structured'],
    [1, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'medium' }, 'balanced'],
    [2, { work_mode: 'hybrid', meeting_hours: 15, async_maturity: 'high' }, 'meeting_heavy'],
    [2, { work_mode: 'hybrid', meeting_hours: 14, async_maturity: 'low' }, 'hybrid_structured'],
    [3, { work_mode: 'remote', priorities: ['compliance'], security_constraints: 'regulated', meeting_hours: 30 }, 'regulated_scale'],
    [3, { work_mode: 'remote', priorities: ['compliance'], security_constraints: 'standard', meeting_hours: 30 }, 'meeting_heavy'],
  ])('v%i %j -> %s', (v, answers, expected) => {
    expect(computeResult(funnel(v, 'A'), answers)).toBe(expected);
  });
});

describe('validateAnswer uses config messages with fallbacks', () => {
  const a = funnel(1, 'A');
  it.each([
    ['team_size', '', 'Enter the team size.'],
    ['team_size', 0, 'The team must have at least one person.'],
    ['team_size', 201, 'For this demo, enter a value up to 200.'],
    ['team_size', 2.5, 'Enter a whole number.'],
    ['work_mode', undefined, "Select the team's main work mode."],
    ['work_mode', 'moon', "Select the team's main work mode."],
    ['priorities', [], 'Choose at least one priority.'],
    ['priorities', ['speed', 'focus', 'culture', 'cost'], 'Choose no more than three priorities.'],
  ] as const)('%s = %j -> "%s"', (id, raw, text) => {
    const check = validateAnswer(question(a, id), raw);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toBe(text);
  });

  it('parses numbers strictly', () => {
    expect(validateAnswer(question(a, 'office_days'), '   ')).toMatchObject({ ok: false, code: 'required' });
    expect(validateAnswer(question(a, 'team_size'), '0x10')).toMatchObject({ ok: false, code: 'type' });
    expect(validateAnswer(question(a, 'team_size'), '1e2')).toMatchObject({ ok: false, code: 'type' });
  });

  it('normalizes valid input', () => {
    expect(validateAnswer(question(a, 'team_size'), '12')).toEqual({ ok: true, value: 12 });
    expect(validateAnswer(question(a, 'priorities'), ['speed', 'speed'])).toEqual({ ok: true, value: ['speed'] });
  });
});

describe('validateState (server re-check of client state)', () => {
  const a = funnel(1, 'A');
  const answered = { team_size: 5, work_mode: 'remote', priorities: ['focus'], timezone_span: 'same' };

  it('accepts a consistent state', () => {
    const r = validateState(a, { answers: answered, history: ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span'], currentStepId: 'async_maturity' });
    expect(r.ok).toBe(true);
  });

  it('rejects an answer that does not exist in the pinned version (v2 question in a v1 session)', () => {
    const r = validateState(a, { answers: { ...answered, meeting_hours: 10 }, history: [], currentStepId: 'intro' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ code: 'unknown_answer', detail: 'meeting_hours' });
  });

  it('rejects jumping over an unanswered question', () => {
    const r = validateState(a, { answers: { team_size: 5 }, history: [], currentStepId: 'priorities' });
    expect(r).toEqual({ ok: false, errors: [{ code: 'step_not_reachable', detail: 'priorities requires an answer to work_mode' }] });
  });

  it('rejects a hidden current step', () => {
    const r = validateState(a, { answers: answered, history: [], currentStepId: 'office_days' });
    expect(r).toEqual({ ok: false, errors: [{ code: 'step_not_reachable', detail: 'office_days is hidden' }] });
  });

  it('never trusts client history: rebuilds it from the visible steps before the current one', () => {
    const r = validateState(a, { answers: answered, history: ['result', 'office_days', 'intro', 'intro'], currentStepId: 'async_maturity' });
    expect(r.ok && r.state.history).toEqual(['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span']);
  });

  it('optional questions can be skipped (not triggered by v1-v3, where every question is required)', () => {
    const raw = rawConfig(1) as LooseJson;
    raw.steps.tool_count.validation.required = false;
    raw.steps.priorities.validation.required = false;
    const f = resolveVariant(FunnelConfigSchema.parse(raw), 'A');
    const { priorities: _skipped, ...rest } = answered;
    const r = validateState(f, { answers: { ...rest, async_maturity: 'low' }, history: [], currentStepId: 'result' });
    expect(r.ok).toBe(true);
    expect(validateAnswer(question(f, 'priorities'), [])).toEqual({ ok: true, value: undefined });
  });
});

describe('filterEventProperties (privacy gate)', () => {
  it('keeps only declared scalar properties', () => {
    const { events } = funnel(1, 'A');
    expect(filterEventProperties(events, 'answer_submitted', { answer_kind: 'number', value: 42, answers: { a: 1 } })).toEqual({ answer_kind: 'number' });
    expect(filterEventProperties(events, 'cta_clicked', { result_id: 'balanced', action: 'expand_recommendation', extra: 1 })).toEqual({ result_id: 'balanced', action: 'expand_recommendation' });
    expect(filterEventProperties(events, 'recommendation_expanded', { result_id: 'x' })).toEqual({});
  });
});
