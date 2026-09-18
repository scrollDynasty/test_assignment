import { computeVisibility, type SessionState } from './engine.js';
import { isInteractive, type AnswerValue, type InteractiveStep, type ResolvedFunnel } from './config.js';

export type AnswerErrorCode =
  | 'required'
  | 'type'
  | 'min'
  | 'max'
  | 'step'
  | 'invalid_option'
  | 'minSelections'
  | 'maxSelections';

export type AnswerCheck = { ok: true; value: AnswerValue | undefined } | { ok: false; code: AnswerErrorCode; message: string };

/**
 * Message lookup with fallbacks. The provided configs do not define every key
 * (e.g. `priorities` has no `required`, number steps have no message for fractional input),
 * so we fall back to a related key and then to a generic text instead of showing nothing.
 */
const FALLBACKS: Record<AnswerErrorCode, AnswerErrorCode[]> = {
  required: ['required', 'minSelections'],
  type: ['required'],
  min: ['min'],
  max: ['max'],
  step: [],
  invalid_option: ['required'],
  minSelections: ['minSelections', 'required'],
  maxSelections: ['maxSelections'],
};

function message(step: InteractiveStep, code: AnswerErrorCode, generic: string): string {
  const messages = step.validation?.messages ?? {};
  for (const key of FALLBACKS[code]) {
    const text = messages[key];
    if (text) return text;
  }
  return generic;
}

function fail(step: InteractiveStep, code: AnswerErrorCode, generic: string): AnswerCheck {
  return { ok: false, code, message: message(step, code, generic) };
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
}

/** Validates and normalizes one answer. The same function runs in the browser and on the server. */
export function validateAnswer(step: InteractiveStep, raw: unknown): AnswerCheck {
  const required = step.validation?.required ?? false;
  if (isEmpty(raw)) {
    if (step.type === 'multi-select' && (step.validation?.minSelections ?? 0) > 0) {
      return fail(step, 'minSelections', 'Choose at least one option.');
    }
    return required ? fail(step, 'required', 'This field is required.') : { ok: true, value: undefined };
  }

  switch (step.type) {
    case 'number': {
      const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(step, 'type', 'Enter a number.');
      const { min, max, step: stepSize } = step.input;
      if (min !== undefined && value < min) return fail(step, 'min', `Enter a value of at least ${min}.`);
      if (max !== undefined && value > max) return fail(step, 'max', `Enter a value up to ${max}.`);
      if (stepSize !== undefined) {
        const units = (value - (min ?? 0)) / stepSize;
        if (Math.abs(units - Math.round(units)) > 1e-9) {
          return fail(step, 'step', stepSize === 1 ? 'Enter a whole number.' : `Enter a multiple of ${stepSize}.`);
        }
      }
      return { ok: true, value };
    }
    case 'single-select': {
      if (typeof raw !== 'string') return fail(step, 'type', 'Choose one option.');
      if (!step.input.options.some((o) => o.value === raw)) {
        return fail(step, 'invalid_option', 'Choose one of the listed options.');
      }
      return { ok: true, value: raw };
    }
    case 'multi-select': {
      if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === 'string')) {
        return fail(step, 'type', 'Choose one or more options.');
      }
      const values = [...new Set(raw)];
      if (!values.every((v) => step.input.options.some((o) => o.value === v))) {
        return fail(step, 'invalid_option', 'Choose from the listed options.');
      }
      const { minSelections, maxSelections } = step.validation ?? {};
      if (minSelections !== undefined && values.length < minSelections) {
        return fail(step, 'minSelections', `Choose at least ${minSelections}.`);
      }
      if (maxSelections !== undefined && values.length > maxSelections) {
        return fail(step, 'maxSelections', `Choose no more than ${maxSelections}.`);
      }
      return { ok: true, value: values };
    }
  }
}

export interface StateError {
  code: 'unknown_answer' | 'invalid_answer' | 'unknown_step' | 'step_not_reachable';
  detail: string;
}

/**
 * Server-side check of a client-submitted state against the session's pinned version:
 * every answer belongs to a step of this version and is valid, and the current step is reachable,
 * i.e. every visible question before it has an answer. Returns the normalized state on success.
 */
export function validateState(
  funnel: ResolvedFunnel,
  state: SessionState,
): { ok: true; state: SessionState } | { ok: false; errors: StateError[] } {
  const errors: StateError[] = [];
  const byInput = new Map<string, InteractiveStep>();
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (step && isInteractive(step)) byInput.set(step.input.name, step);
  }

  const answers: Record<string, AnswerValue> = {};
  for (const [name, raw] of Object.entries(state.answers)) {
    const step = byInput.get(name);
    if (!step) {
      errors.push({ code: 'unknown_answer', detail: name });
      continue;
    }
    const check = validateAnswer(step, raw);
    if (!check.ok) errors.push({ code: 'invalid_answer', detail: `${name}: ${check.code}` });
    else if (check.value !== undefined) answers[name] = check.value;
  }

  for (const id of [...state.history, state.currentStepId]) {
    if (!funnel.sequence.includes(id)) errors.push({ code: 'unknown_step', detail: id });
  }
  if (errors.length > 0) return { ok: false, errors };

  const { visibleSteps } = computeVisibility(funnel, answers);
  if (!visibleSteps.includes(state.currentStepId)) {
    return { ok: false, errors: [{ code: 'step_not_reachable', detail: `${state.currentStepId} is hidden` }] };
  }
  const currentPos = funnel.sequence.indexOf(state.currentStepId);
  for (const id of visibleSteps) {
    if (funnel.sequence.indexOf(id) >= currentPos) break;
    const step = funnel.steps[id];
    if (step && isInteractive(step) && answers[step.input.name] === undefined) {
      errors.push({ code: 'step_not_reachable', detail: `${state.currentStepId} requires an answer to ${id}` });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, state: { answers, history: [...state.history], currentStepId: state.currentStepId } };
}
