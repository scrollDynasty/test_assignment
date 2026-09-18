import { referencedAnswers } from './conditions.js';
import { FunnelConfigSchema, isInteractive, type FunnelConfig } from './config.js';
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

  // Steps: key matches id, input names are unique.
  const inputOwner = new Map<string, string>();
  for (const [key, step] of Object.entries(config.steps)) {
    if (step.id !== key) errors.push({ path: `steps.${key}.id`, message: `id "${step.id}" does not match key "${key}"` });
    if (isInteractive(step)) {
      const owner = inputOwner.get(step.input.name);
      if (owner) errors.push({ path: `steps.${key}.input.name`, message: `input "${step.input.name}" already used by ${owner}` });
      inputOwner.set(step.input.name, key);
    }
  }

  for (const [key, result] of Object.entries(config.results)) {
    if (result.id !== key) errors.push({ path: `results.${key}.id`, message: `id "${result.id}" does not match key "${key}"` });
  }
  config.resultRules.forEach((rule, i) => {
    if (!config.results[rule.resultId]) errors.push({ path: `resultRules.${i}.resultId`, message: `unknown result "${rule.resultId}"` });
    for (const name of referencedAnswers(rule.when)) {
      if (!inputOwner.has(name)) errors.push({ path: `resultRules.${i}.when`, message: `unknown answer "${name}"` });
    }
  });
  if (!config.results[config.defaultResultId]) {
    errors.push({ path: 'defaultResultId', message: `unknown result "${config.defaultResultId}"` });
  }

  const variants = Object.entries(config.experiment.variants);
  if (variants.length === 0) errors.push({ path: 'experiment.variants', message: 'at least one variant is required' });

  for (const [name, variant] of variants) {
    const base = `experiment.variants.${name}`;
    const seq = variant.stepSequence;

    if (new Set(seq).size !== seq.length) errors.push({ path: `${base}.stepSequence`, message: 'duplicate step ids' });
    seq.forEach((id, i) => {
      if (!config.steps[id]) errors.push({ path: `${base}.stepSequence.${i}`, message: `unknown step "${id}"` });
    });
    const resultSteps = seq.filter((id) => config.steps[id]?.type === 'result');
    if (resultSteps.length !== 1 || config.steps[seq[seq.length - 1] ?? '']?.type !== 'result') {
      errors.push({ path: `${base}.stepSequence`, message: 'must contain exactly one result step, and it must be last' });
    }

    for (const id of Object.keys(variant.stepOverrides ?? {})) {
      if (!config.steps[id]) errors.push({ path: `${base}.stepOverrides.${id}`, message: `unknown step "${id}"` });
      else if (!seq.includes(id)) warnings.push({ path: `${base}.stepOverrides.${id}`, message: 'step is not in this variant' });
    }
    for (const id of Object.keys(variant.resultOverrides ?? {})) {
      if (!config.results[id]) errors.push({ path: `${base}.resultOverrides.${id}`, message: `unknown result "${id}"` });
    }

    // Branching conditions may only look back: the step that owns the answer must come earlier in this variant.
    seq.forEach((id, pos) => {
      const step = config.steps[id];
      if (!step?.visibleWhen) return;
      for (const answer of referencedAnswers(step.visibleWhen)) {
        const owner = inputOwner.get(answer);
        const ownerPos = owner ? seq.indexOf(owner) : -1;
        if (ownerPos < 0 || ownerPos >= pos) {
          errors.push({
            path: `steps.${id}.visibleWhen`,
            message: `variant ${name}: answer "${answer}" is not asked before "${id}"`,
          });
        }
      }
    });

    for (const [i, rule] of config.resultRules.entries()) {
      for (const answer of referencedAnswers(rule.when)) {
        const owner = inputOwner.get(answer);
        if (owner && !seq.includes(owner)) {
          warnings.push({ path: `resultRules.${i}`, message: `variant ${name} never asks "${answer}"; this rule can only match without it` });
        }
      }
    }
  }

  // Overrides must still produce valid steps/results.
  if (errors.length === 0) {
    for (const [name] of variants) {
      try {
        resolveVariant(config, name);
      } catch (e) {
        errors.push({ path: `experiment.variants.${name}`, message: `overrides produce an invalid step or result: ${(e as Error).message}` });
      }
    }
  }

  const eventNames = config.events.allowed.map((e) => e.name);
  if (new Set(eventNames).size !== eventNames.length) errors.push({ path: 'events.allowed', message: 'duplicate event names' });

  return errors.length === 0 ? { ok: true, config, warnings } : { ok: false, errors, warnings };
}
