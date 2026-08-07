import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { I18N } from '../src/lib/i18n';

// src/lib/i18nParity.test.ts compares the two dictionaries against each other,
// so a key missing from BOTH is invisible to it: `t` falls back to the key
// itself and the UI quietly renders a lowercase slug in every language. This is
// the only thing that catches that.
//
// Lives here rather than beside the parity checks because it reads the source
// tree, and node: types are out of scope for src/'s tsconfig.
describe('i18n key coverage', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  function* sources(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) yield* sources(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'i18n.tsx') yield p;
    }
  }

  it('defines every key the app asks for by literal', () => {
    // Only whole-literal calls: the trailing `)` or `,` is what rules out a
    // built key like `t('dim_' + field)`. Those, and `t(LABEL[f] ?? f)`, can't
    // be resolved statically and are left to the parity checks.
    const CALL = /(?<![\w.$])t\(\s*'([A-Za-z0-9_]+)'\s*[),]/g;
    const missing = new Map<string, string>();
    for (const file of sources(SRC)) {
      for (const [, key] of readFileSync(file, 'utf8').matchAll(CALL)) {
        if (!(key in I18N.en) && !missing.has(key)) missing.set(key, file.slice(SRC.length + 1));
      }
    }
    const report = [...missing].map(([k, f]) => `${k} (${f})`).join(', ');
    expect([...missing.keys()], `keys with no English entry: ${report}`).toEqual([]);
  });
});
