import type { AnswerValue, Answers, Condition, LeafCondition } from './config.js';

/**
 * Evaluates a condition tree against answers.
 *
 * A leaf whose answer is missing is false for every operator (including `neq`/`not_in`),
 * because "not answered yet" must never open a branch. `{not: …}` is a plain negation on top of that.
 */
export function evaluateCondition(condition: Condition, answers: Answers): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, answers));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, answers));
  if ('not' in condition) return !evaluateCondition(condition.not, answers);
  return evaluateLeaf(condition, answers[condition.answer]);
}

function evaluateLeaf(leaf: LeafCondition, actual: AnswerValue | undefined): boolean {
  if (actual === undefined) return false;
  const expected = leaf.value;

  switch (leaf.operator) {
    case 'exists':
      return true;
    case 'eq':
      return !Array.isArray(actual) && actual === expected;
    case 'neq':
      return !Array.isArray(actual) && actual !== expected;
    case 'in':
      return isIn(actual, expected);
    case 'not_in':
      return Array.isArray(expected) && !isIn(actual, expected);
    case 'contains':
      return Array.isArray(actual) && typeof expected === 'string' && actual.includes(expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumbers(leaf.operator, actual, expected);
  }
}

/** Scalar: value is one of expected. Array (multi-select): at least one selected value is in expected. */
function isIn(actual: AnswerValue, expected: unknown): boolean {
  if (!Array.isArray(expected)) return false;
  const pool: unknown[] = expected;
  return Array.isArray(actual) ? actual.some((a) => pool.includes(a)) : pool.includes(actual);
}

function compareNumbers(op: 'gt' | 'gte' | 'lt' | 'lte', actual: AnswerValue, expected: unknown): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (op) {
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
  }
}

/** Collects every answer name referenced anywhere in a condition tree. */
export function referencedAnswers(condition: Condition): string[] {
  if ('all' in condition) return condition.all.flatMap(referencedAnswers);
  if ('any' in condition) return condition.any.flatMap(referencedAnswers);
  if ('not' in condition) return referencedAnswers(condition.not);
  return [condition.answer];
}
