import { evaluateCondition } from './conditions.js';
import type { Answers, ResolvedFunnel, Step } from './config.js';
import { isInteractive } from './steps.js';

export interface SessionState {
  /** Raw answers keyed by input name. May contain answers of steps that are currently hidden. */
  answers: Answers;
  /** Stack of steps the user walked through before the current one (Back pops it). */
  history: string[];
  currentStepId: string;
}

export interface Visibility {
  /** Visible step ids in sequence order. */
  visibleSteps: string[];
  /** Answers of visible steps only: the ones that may affect branching, progress and the result. */
  effectiveAnswers: Answers;
}

/**
 * Walks the sequence once. A step's `visibleWhen` is evaluated against the effective answers of the
 * steps before it; validateConfig guarantees conditions only reference earlier steps, so one pass is exact.
 * An answer of a hidden step is ignored (but kept in state, so it comes back if the branch reopens).
 */
export function computeVisibility(funnel: ResolvedFunnel, answers: Answers): Visibility {
  const visibleSteps: string[] = [];
  const effectiveAnswers: Answers = {};
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (!step) continue;
    if (step.visibleWhen && !evaluateCondition(step.visibleWhen, effectiveAnswers)) continue;
    visibleSteps.push(id);
    if (isInteractive(step)) {
      const value = Object.hasOwn(answers, step.input.name) ? answers[step.input.name] : undefined;
      if (value !== undefined) effectiveAnswers[step.input.name] = value;
    }
  }
  return { visibleSteps, effectiveAnswers };
}

export function firstStepId(funnel: ResolvedFunnel): string {
  const first = computeVisibility(funnel, {}).visibleSteps[0];
  if (!first) throw new Error('Funnel has no visible steps');
  return first;
}

/** Next visible step after `currentId` in sequence order, or null at the end. */
export function nextStepId(funnel: ResolvedFunnel, answers: Answers, currentId: string): string | null {
  const { visibleSteps } = computeVisibility(funnel, answers);
  const from = funnel.sequence.indexOf(currentId);
  if (from < 0) throw new Error(`Step "${currentId}" is not part of this funnel`);
  for (let i = from + 1; i < funnel.sequence.length; i++) {
    const id = funnel.sequence[i];
    if (id !== undefined && visibleSteps.includes(id)) return id;
  }
  return null;
}

export interface Progress {
  /** 1-based position among counted steps; 0 when the current step itself is not counted (e.g. intro). */
  index: number;
  /** Number of counted steps the user can currently reach. */
  count: number;
}

/**
 * Progress counts steps whose type is not excluded (info/result in all provided configs); with
 * `countVisibleOnly` (true in every provided config) only steps visible to this user are counted.
 */
export function computeProgress(funnel: ResolvedFunnel, answers: Answers, currentId: string): Progress {
  const excluded = new Set(funnel.progress.excludeTypes);
  const pool = funnel.progress.countVisibleOnly ? computeVisibility(funnel, answers).visibleSteps : funnel.sequence;
  const counted = pool.filter((id) => {
    const step = funnel.steps[id];
    return step !== undefined && !excluded.has(step.type);
  });
  const pos = counted.indexOf(currentId);
  if (pos >= 0) return { index: pos + 1, count: counted.length };
  // Not counted itself: report how many counted steps come before it in the sequence.
  const seqPos = funnel.sequence.indexOf(currentId);
  const before = counted.filter((id) => funnel.sequence.indexOf(id) < seqPos).length;
  return { index: before, count: counted.length };
}

/** First matching result rule on effective answers, otherwise the default result. */
export function computeResult(funnel: ResolvedFunnel, answers: Answers): string {
  const { effectiveAnswers } = computeVisibility(funnel, answers);
  const rule = funnel.resultRules.find((r) => evaluateCondition(r.when, effectiveAnswers));
  return rule ? rule.resultId : funnel.defaultResultId;
}

export type AnswerKind = 'single_select' | 'multi_select' | 'number';

/** Coarse, non-identifying description of an answer; the only answer-related data allowed in analytics. */
export function answerKind(step: Step): AnswerKind | null {
  switch (step.type) {
    case 'single-select':
      return 'single_select';
    case 'multi-select':
      return 'multi_select';
    case 'number':
      return 'number';
    default:
      return null;
  }
}

export function initialState(funnel: ResolvedFunnel): SessionState {
  return { answers: {}, history: [], currentStepId: firstStepId(funnel) };
}
