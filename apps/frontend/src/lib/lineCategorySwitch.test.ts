import { describe, it, expect } from 'vitest';
import { SPEC_FIELDS_BY_CATEGORY } from '@recycle-erp/shared';
import { switchLineCategory, clearedBySwitch, SPEC_FIELD_LABEL_KEY } from './lineCategorySwitch';
import { I18N } from './i18n';

const ramLine = {
  category: 'RAM' as const,
  brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
  classification: 'RDIMM', rank: '2Rx4', speed: '3200', chipNumber: 'K4A8G085WB',
  partNumber: 'M393A4K40DB3-CWE', serialNumber: 'SN-1', condition: 'Pulled — Tested',
  qty: 4, unitCost: 78.5, sellPrice: 96,
};

describe('switchLineCategory', () => {
  it('clears the fields the old category owned', () => {
    const patch = switchLineCategory(ramLine, 'SSD');
    expect(patch.category).toBe('SSD');
    expect(patch).toMatchObject({
      generation: null, type: null, classification: null, rank: null,
      speed: null, chipNumber: null,
    });
  });

  it('keeps the fields the new category also owns', () => {
    const patch = switchLineCategory(ramLine, 'SSD');
    expect(patch).not.toHaveProperty('brand');
    expect(patch).not.toHaveProperty('capacity');
  });

  it('never clears category-agnostic fields', () => {
    const patch = switchLineCategory(ramLine, 'Other');
    for (const keep of ['partNumber', 'serialNumber', 'condition', 'qty', 'unitCost', 'sellPrice']) {
      expect(patch).not.toHaveProperty(keep);
    }
  });

  it('only names fields that actually held a value', () => {
    const sparse = { category: 'RAM' as const, brand: 'Samsung', speed: '' };
    const patch = switchLineCategory(sparse, 'HDD');
    expect(patch).not.toHaveProperty('speed');       // was blank
    expect(patch).not.toHaveProperty('generation');  // was absent
  });

  it('does not resurrect the old fields on the way back', () => {
    const asSsd = { ...ramLine, ...switchLineCategory(ramLine, 'SSD') };
    const back = { ...asSsd, ...switchLineCategory(asSsd, 'RAM') };
    expect(back.generation).toBeNull();
    expect(back.speed).toBeNull();
  });
});

describe('clearedBySwitch', () => {
  it('lists what the undo notice has to name', () => {
    const cleared = clearedBySwitch(ramLine, 'SSD');
    expect(cleared).toContain('generation');
    expect(cleared).toContain('speed');
    expect(cleared).not.toContain('brand');
    expect(cleared).not.toContain('partNumber');
  });

  it('is empty when nothing would be lost', () => {
    expect(clearedBySwitch({ category: 'RAM', brand: 'Samsung' }, 'SSD')).toEqual([]);
  });
});

// The label map is a fourth hand-maintained copy of the shared spec-field list,
// and the only one the i18n coverage tests can't see: LineDrawer looks its keys
// up by variable, so a field added to the shared table and forgotten here falls
// through to t(field) and prints the raw camelCase name in the undo notice, in
// both languages.
describe('SPEC_FIELD_LABEL_KEY', () => {
  const specFields = [...new Set(Object.values(SPEC_FIELDS_BY_CATEGORY).flat())];

  it('labels every spec field the shared table owns', () => {
    const unlabelled = specFields.filter(f => !(f in SPEC_FIELD_LABEL_KEY));
    expect(unlabelled, `spec fields with no label key: ${unlabelled.join(', ')}`).toEqual([]);
  });

  it('points every field at a key the dictionary defines', () => {
    // en only — zh parity is i18nParity.test.ts's job, and a zh gap falls back
    // to the English label rather than to the bare field name.
    const dangling = specFields
      .map(f => SPEC_FIELD_LABEL_KEY[f])
      .filter(k => k !== undefined && !(k in I18N.en));
    expect(dangling, `label keys absent from the dictionary: ${dangling.join(', ')}`).toEqual([]);
  });
});
