import {
  ResultSchema,
  StepSchema,
  type FunnelConfig,
  type ResolvedFunnel,
  type Result,
  type Step,
} from './config.js';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objects merge recursively, everything else (including arrays) is replaced by the override. */
export function deepMerge(base: PlainObject, override: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export class UnknownVariantError extends Error {
  constructor(variant: string) {
    super(`Unknown variant "${variant}"`);
  }
}

/**
 * Applies a variant to a config: its step order plus partial overrides of step and result content.
 * Merged objects are re-parsed so an override can never produce a step the renderer does not understand
 * (validateConfig runs the same merge at publish time, so this never throws for a published version).
 */
export function resolveVariant(config: FunnelConfig, variant: string): ResolvedFunnel {
  const v = config.experiment.variants[variant];
  if (!v) throw new UnknownVariantError(variant);

  const steps: Record<string, Step> = {};
  for (const id of v.stepSequence) {
    const base = config.steps[id];
    if (!base) throw new Error(`Step "${id}" from variant ${variant} is not defined`);
    const override = v.stepOverrides?.[id];
    steps[id] = override ? StepSchema.parse(deepMerge(base, override)) : base;
  }

  const results: Record<string, Result> = {};
  for (const [id, base] of Object.entries(config.results)) {
    const override = v.resultOverrides?.[id];
    results[id] = override ? ResultSchema.parse(deepMerge(base, override)) : base;
  }

  return {
    funnelId: config.funnelId,
    version: config.version,
    experimentId: config.experiment.id,
    variant,
    title: config.title,
    locale: config.locale,
    sequence: [...v.stepSequence],
    steps,
    results,
    resultRules: config.resultRules.map((r) => ({ resultId: r.resultId, when: r.when })),
    defaultResultId: config.defaultResultId,
    progress: { excludeTypes: config.progress?.excludeTypes ?? ['info', 'result'] },
    events: config.events,
  };
}
