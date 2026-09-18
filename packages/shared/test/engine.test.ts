import { describe, expect, it } from 'vitest';
import {
  computeProgress,
  computeResult,
  computeVisibility,
  evaluateCondition,
  filterEventProperties,
  initialState,
  nextStepId,
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
  ] as const)('rejects a config with %s', (_label, mutate, expected) => {
    const result = validateConfig(mutated(1, mutate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => `${e.path}: ${e.message}`).join('\n')).toContain(expected);
  });
});

describe('evaluateCondition', () => {
  const answers: Answers = { mode: 'hybrid', hours: 15, picks: ['focus', 'compliance'] };
  it.each<[Condition, boolean]>([
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
    expect(computeResult(a, answers)).not.toBe('regulated_scale');
    expect(computeResult(a, { ...answers, priorities: ['compliance'] })).toBe('regulated_scale');
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
    expect(r.ok).toBe(false);
  });

  it('rejects a hidden current step', () => {
    const r = validateState(a, { answers: answered, history: [], currentStepId: 'office_days' });
    expect(r.ok).toBe(false);
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
