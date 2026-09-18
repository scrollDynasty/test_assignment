import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FunnelConfigSchema, resolveVariant, type FunnelConfig, type ResolvedFunnel } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Raw JSON of a provided config file, exactly as it is on disk. */
export function rawConfig(version: 1 | 2 | 3): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}funnel-v${version}.json`, 'utf8')) as Record<string, unknown>;
}

export function config(version: 1 | 2 | 3): FunnelConfig {
  return FunnelConfigSchema.parse(rawConfig(version));
}

export function funnel(version: 1 | 2 | 3, variant: 'A' | 'B'): ResolvedFunnel {
  return resolveVariant(config(version), variant);
}

/** Untyped view of a config JSON, used only to break configs on purpose in negative tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = Record<string, any>;

/** Deep copy of a provided config with a mutation applied, for negative validator tests. */
export function mutated(version: 1 | 2 | 3, mutate: (c: LooseJson) => void): unknown {
  const copy = structuredClone(rawConfig(version));
  mutate(copy);
  return copy;
}
