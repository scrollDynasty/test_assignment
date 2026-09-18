import type { AnswerValue, Answers, Condition, LeafCondition } from './config.js';

/** true / false, or null when the condition depends on a question that has not been answered. */
type Truth = boolean | null;

/**
 * Evaluates a condition tree against answers with three-valued (Kleene) logic.
 *
 * A leaf whose answer is missing is *unknown*, not false, and `not(unknown)` stays unknown.
 * The final verdict treats unknown as false, so "not answered yet" can never open a branch,
 * no matter whether the condition is written positively or with `not`.
 * `exists` is the one operator that is decidable without an answer.
 */
export function evaluateCondition(condition: Condition, answers: Answers): boolean {
  return evaluate(condition, answers) === true;
}

function evaluate(condition: Condition, answers: Answers): Truth {
  if ('all' in condition) {
    const parts = condition.all.map((c) => evaluate(c, answers));
    if (parts.includes(false)) return false;
    return parts.includes(null) ? null : true;
  }
  if ('any' in condition) {
    const parts = condition.any.map((c) => evaluate(c, answers));
    if (parts.includes(true)) return true;
    return parts.includes(null) ? null : false;
  }
  if ('not' in condition) {
    const inner = evaluate(condition.not, answers);
    return inner === null ? null : !inner;
  }
  // Own keys only: an answer named "constructor" or "toString" must not resolve to an inherited function.
  return evaluateLeaf(condition, Object.hasOwn(answers, condition.answer) ? answers[condition.answer] : undefined);
}

function evaluateLeaf(leaf: LeafCondition, actual: AnswerValue | undefined): Truth {
  if (leaf.operator === 'exists') return actual !== undefined;
  if (actual === undefined) return null;
  const expected = leaf.value;

  switch (leaf.operator) {
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

/** Every leaf (answer + operator + value) in a condition tree. */
export function referencedLeaves(condition: Condition): LeafCondition[] {
  if ('all' in condition) return condition.all.flatMap(referencedLeaves);
  if ('any' in condition) return condition.any.flatMap(referencedLeaves);
  if ('not' in condition) return referencedLeaves(condition.not);
  return [condition];
}
