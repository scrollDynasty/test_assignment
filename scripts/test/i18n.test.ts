import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentRu, genericRu } from '../../apps/web/src/i18n/content.ru.js';
import { en, ru } from '../../apps/web/src/i18n/ui.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TEXT_KEYS = new Set(['eyebrow', 'title', 'body', 'helperText', 'primaryActionLabel', 'loadingTitle', 'errorTitle', 'retryLabel', 'label', 'summary', 'unit']);

/** Every user-visible text of a config: step content, options, units, messages, results, variant overrides. */
function texts(node: unknown, key = ''): string[] {
  if (typeof node === 'string') return TEXT_KEYS.has(key) || key === '#item' || key === '#message' ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((x) => texts(x, key === 'recommendations' ? '#item' : key));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => (key === 'messages' ? texts(v, '#message') : texts(v, k)));
  }
  return [];
}

describe('Russian translation (i18n)', () => {
  it.each([1, 2, 3])('covers every visible text of funnel-v%i.json', (v) => {
    const config = JSON.parse(readFileSync(`${root}funnel-v${v}.json`, 'utf8')) as Record<string, unknown>;
    const all = [...new Set([...texts(config.steps), ...texts(config.results), ...texts(config.experiment)])];
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((s) => !contentRu[s])).toEqual([]);
  });

  it('translates the generic validation messages of the shared engine', () => {
    for (const msg of ['This field is required.', 'Enter a whole number.', 'Enter a value of at least 3.', 'Choose no more than 2.']) {
      expect(genericRu.some(([re]) => re.test(msg))).toBe(true);
    }
  });

  it('has the same interface keys in both languages and keeps placeholders', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(vars(ru[key]), key).toEqual(vars(en[key]));
    }
  });
});
