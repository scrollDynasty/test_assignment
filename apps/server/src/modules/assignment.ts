import { createHash } from 'node:crypto';

/**
 * Deterministic weighted assignment: the same (experiment, session) always lands in the same bucket.
 * The result is stored on the session anyway; determinism makes it reproducible and testable,
 * and salting with the experiment id means a new experiment reshuffles users independently.
 */
export function assignVariant(experimentId: string, sessionId: string, variants: Record<string, { weight: number }>): string {
  const names = Object.keys(variants).sort();
  const total = names.reduce((sum, n) => sum + (variants[n]?.weight ?? 0), 0);
  if (names.length === 0 || total <= 0) throw new Error('Experiment has no weighted variants');

  const digest = createHash('sha256').update(`${experimentId}:${sessionId}`).digest();
  const unit = digest.readUIntBE(0, 6) / 2 ** 48; // uniform in [0, 1)
  let point = unit * total;
  for (const name of names) {
    point -= variants[name]?.weight ?? 0;
    if (point < 0) return name;
  }
  return names[names.length - 1] as string;
}
