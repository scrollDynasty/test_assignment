import { referencedLeaves } from './conditions.js';
import {
  FunnelConfigSchema,
  isInteractive,
  type FunnelConfig,
  type InteractiveStep,
  type LeafCondition,
  type ResolvedFunnel,
} from './config.js';
import { resolveVariant } from './resolve.js';

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigValidation =
  | { ok: true; config: FunnelConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/**
 * Publish-time gate. A version that passes this can be rendered and evaluated by the current runtime
 * for every variant, so a bad config is rejected before it can reach a single session.
 *
 * Structural rules are checked on what each variant actually shows (after overrides are applied),
 * not only on the base steps: an override could otherwise change a step's type, input name or condition.
 */
export function validateConfig(raw: unknown): ConfigValidation {
  const parsed = FunnelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      warnings: [],
    };
  }
  const config = parsed.data;
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  // --- References between parts of the config ---
  for (const [key, step] of Object.entries(config.steps)) {
    if (step.id !== key) errors.push({ path: `steps.${key}.id`, message: `id "${step.id}" does not match key "${key}"` });
  }
  for (const [key, result] of Object.entries(config.results)) {
    if (result.id !== key) errors.push({ path: `results.${key}.id`, message: `id "${result.id}" does not match key "${key}"` });
  }
  config.resultRules.forEach((rule, i) => {
    if (!Object.hasOwn(config.results, rule.resultId)) errors.push({ path: `resultRules.${i}.resultId`, message: `unknown result "${rule.resultId}"` });
  });
  if (!Object.hasOwn(config.results, config.defaultResultId)) {
    errors.push({ path: 'defaultResultId', message: `unknown result "${config.defaultResultId}"` });
  }
  const eventNames = config.events.allowed.map((e) => e.name);
  if (new Set(eventNames).size !== eventNames.length) errors.push({ path: 'events.allowed', message: 'duplicate event names' });

  const variants = Object.entries(config.experiment.variants);
  if (variants.length === 0) errors.push({ path: 'experiment.variants', message: 'at least one variant is required' });
  for (const [name, variant] of variants) {
    const base = `experiment.variants.${name}`;
    if (new Set(variant.stepSequence).size !== variant.stepSequence.length) {
      errors.push({ path: `${base}.stepSequence`, message: 'duplicate step ids' });
    }
    variant.stepSequence.forEach((id, i) => {
      if (!Object.hasOwn(config.steps, id)) errors.push({ path: `${base}.stepSequence.${i}`, message: `unknown step "${id}"` });
    });
    for (const id of Object.keys(variant.stepOverrides ?? {})) {
      if (!Object.hasOwn(config.steps, id)) errors.push({ path: `${base}.stepOverrides.${id}`, message: `unknown step "${id}"` });
      else if (!variant.stepSequence.includes(id)) warnings.push({ path: `${base}.stepOverrides.${id}`, message: 'step is not in this variant' });
    }
    for (const id of Object.keys(variant.resultOverrides ?? {})) {
      if (!Object.hasOwn(config.results, id)) errors.push({ path: `${base}.resultOverrides.${id}`, message: `unknown result "${id}"` });
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  // --- What every variant really shows ---
  for (const [name] of variants) {
    let funnel: ResolvedFunnel;
    try {
      funnel = resolveVariant(config, name);
    } catch (e) {
      errors.push({ path: `experiment.variants.${name}`, message: `overrides produce an invalid step or result: ${(e as Error).message}` });
      continue;
    }
    checkVariant(funnel, `experiment.variants.${name}`, errors, warnings);
  }

  return errors.length === 0 ? { ok: true, config, warnings } : { ok: false, errors, warnings };
}

function checkVariant(funnel: ResolvedFunnel, path: string, errors: ConfigIssue[], warnings: ConfigIssue[]): void {
  const v = funnel.variant;
  const seq = funnel.sequence;

  const last = funnel.steps[seq[seq.length - 1] ?? ''];
  const resultSteps = seq.filter((id) => funnel.steps[id]?.type === 'result');
  if (resultSteps.length !== 1 || last?.type !== 'result') {
    errors.push({ path: `${path}.stepSequence`, message: 'must contain exactly one result step, and it must be last' });
  }
  if (last?.type === 'result' && last.visibleWhen) {
    errors.push({ path: `steps.${last.id}.visibleWhen`, message: `variant ${v}: the result step must always be reachable` });
  }

  // Input names are unique among the steps this variant shows; remember where each is asked.
  const owner = new Map<string, { step: InteractiveStep; pos: number }>();
  seq.forEach((id, pos) => {
    const step = funnel.steps[id];
    if (!step || !isInteractive(step)) return;
    if (owner.has(step.input.name)) {
      errors.push({ path: `steps.${id}.input.name`, message: `variant ${v}: input "${step.input.name}" is asked twice` });
    }
    owner.set(step.input.name, { step, pos });
  });

  // Branching conditions may only look back, and must be satisfiable given the owning question.
  seq.forEach((id, pos) => {
    const step = funnel.steps[id];
    if (!step?.visibleWhen) return;
    for (const leaf of referencedLeaves(step.visibleWhen)) {
      const o = owner.get(leaf.answer);
      if (!o || o.pos >= pos) {
        errors.push({ path: `steps.${id}.visibleWhen`, message: `variant ${v}: answer "${leaf.answer}" is not asked before "${id}"` });
        continue;
      }
      checkLeaf(leaf, o.step, `steps.${id}.visibleWhen`, v, errors);
    }
  });

  funnel.resultRules.forEach((rule, i) => {
    for (const leaf of referencedLeaves(rule.when)) {
      const o = owner.get(leaf.answer);
      if (!o) {
        warnings.push({ path: `resultRules.${i}`, message: `variant ${v} never asks "${leaf.answer}"; that condition is always false there` });
        continue;
      }
      checkLeaf(leaf, o.step, `resultRules.${i}.when`, v, errors);
    }
  });
}

/** Rejects conditions that can never match because the value does not fit the question it refers to. */
function checkLeaf(leaf: LeafCondition, step: InteractiveStep, path: string, variant: string, errors: ConfigIssue[]): void {
  const fail = (message: string): void => void errors.push({ path, message: `variant ${variant}: "${leaf.answer}" ${leaf.operator}: ${message}` });
  const { operator, value } = leaf;
  if (operator === 'exists') return;

  if (step.type === 'number') {
    if (operator === 'contains') return fail('contains is only valid for multi-select');
    if (operator === 'in' || operator === 'not_in') {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'number')) fail('expects an array of numbers');
    } else if (typeof value !== 'number') fail('expects a number');
    return;
  }

  const options = new Set(step.input.options.map((o) => o.value));
  const isOption = (x: unknown) => typeof x === 'string' && options.has(x);
  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') return fail('numeric comparison on a select question');
  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(value) || !value.every(isOption)) fail(`expects an array of options (${[...options].join(', ')})`);
    return;
  }
  if (operator === 'contains') {
    if (step.type !== 'multi-select') return fail('contains is only valid for multi-select');
    if (!isOption(value)) fail(`unknown option ${JSON.stringify(value)}`);
    return;
  }
  // eq / neq
  if (step.type === 'multi-select') return fail('use contains/in for multi-select answers');
  if (!isOption(value)) fail(`unknown option ${JSON.stringify(value)}`);
}

