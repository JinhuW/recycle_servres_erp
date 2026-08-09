import { describe, it, expect } from 'vitest';
import { I18N } from './i18n';

// A missing zh key silently falls back to English, so nothing surfaces the gap
// at runtime. This is the only thing that does.
describe('i18n en/zh parity', () => {
  it('translates every English key', () => {
    const missing = Object.keys(I18N.en).filter(k => !(k in I18N.zh));
    expect(missing, `untranslated keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no zh key without an English source', () => {
    const orphans = Object.keys(I18N.zh).filter(k => !(k in I18N.en));
    expect(orphans, `orphaned zh keys: ${orphans.join(', ')}`).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const holders = (s: string) => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
    const bad: string[] = [];
    for (const [k, en] of Object.entries(I18N.en)) {
      const zh = I18N.zh[k];
      if (!zh) continue;
      if (holders(en).join() !== holders(zh).join()) bad.push(k);
    }
    expect(bad, `placeholder mismatch: ${bad.join(', ')}`).toEqual([]);
  });
});
