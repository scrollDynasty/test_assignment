import type { InteractiveStep, Step } from './config.js';

/** Steps that take an answer. Kept apart from the zod schemas in config.ts, so the browser bundle does not need zod. */
export function isInteractive(step: Step): step is InteractiveStep {
  return step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
}
