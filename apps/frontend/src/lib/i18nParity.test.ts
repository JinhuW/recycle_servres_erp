import { describe, it, expect } from 'vitest';
import { I18N } from './i18n';
import zh from './i18n.zh';

// zh ships as its own chunk at runtime; the test imports it directly so the
// parity check stays synchronous.
const en = I18N.en!;

// A missing zh key silently falls back to English, so nothing surfaces the gap
// at runtime. This is the only thing that does.
describe('i18n en/zh parity', () => {
  it('translates every English key', () => {
    const missing = Object.keys(en).filter(k => !(k in zh));
    expect(missing, `untranslated keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no zh key without an English source', () => {
    const orphans = Object.keys(zh).filter(k => !(k in en));
    expect(orphans, `orphaned zh keys: ${orphans.join(', ')}`).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const holders = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
    const bad: string[] = [];
    for (const [key, enText] of Object.entries(en)) {
      const zhText = zh[key];
      if (!zhText) continue;
      if (holders(enText).join() !== holders(zhText).join()) bad.push(key);
    }
    expect(bad, `placeholder mismatch: ${bad.join(', ')}`).toEqual([]);
  });
});
