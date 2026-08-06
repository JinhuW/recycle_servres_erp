import { describe, it, expect } from 'vitest';
import {
  SPEC_FIELDS_BY_CATEGORY,
  SPEC_DB_COLS_BY_CATEGORY,
  SPEC_FIELD_TO_DB_COL,
  staleSpecFields,
  staleSpecDbCols,
} from '@recycle-erp/shared';

// The backend NULLs columns and the frontend blanks form state from the same
// table. If the two spellings drift, a recategorised line keeps a stale spec on
// one side only — which is invisible until someone filters inventory by it.
describe('line spec-field ownership — camelCase / snake_case parity', () => {
  it('declares the same categories on both maps', () => {
    expect(Object.keys(SPEC_FIELDS_BY_CATEGORY).sort())
      .toEqual(Object.keys(SPEC_DB_COLS_BY_CATEGORY).sort());
  });

  for (const cat of Object.keys(SPEC_FIELDS_BY_CATEGORY)) {
    it(`maps every ${cat} field to its column`, () => {
      const camel = SPEC_FIELDS_BY_CATEGORY[cat as keyof typeof SPEC_FIELDS_BY_CATEGORY];
      const snake = SPEC_DB_COLS_BY_CATEGORY[cat as keyof typeof SPEC_DB_COLS_BY_CATEGORY];
      expect(camel.length).toBe(snake.length);
      expect(camel.map(f => SPEC_FIELD_TO_DB_COL[f])).toEqual([...snake]);
    });
  }
});

describe('staleSpecFields', () => {
  it('clears the other categories’ fields but keeps its own', () => {
    const stale = staleSpecFields('RAM');
    expect(stale).toContain('interface');
    expect(stale).toContain('formFactor');
    expect(stale).toContain('rpm');
    expect(stale).toContain('health');
    expect(stale).toContain('description');
    expect(stale).not.toContain('brand');
    expect(stale).not.toContain('speed');
    expect(stale).not.toContain('chipNumber');
  });

  it('never lists category-agnostic fields', () => {
    for (const cat of ['RAM', 'SSD', 'HDD', 'Other']) {
      for (const keep of ['partNumber', 'serialNumber', 'condition', 'qty', 'unitCost', 'sellPrice']) {
        expect(staleSpecFields(cat)).not.toContain(keep);
      }
    }
  });

  it('clears nothing for a category it does not know', () => {
    expect(staleSpecFields('CPU')).toEqual([]);
    expect(staleSpecDbCols('CPU')).toEqual([]);
  });

  it('mirrors staleSpecFields in snake_case', () => {
    expect(staleSpecDbCols('RAM')).toContain('form_factor');
    expect(staleSpecDbCols('Other')).toContain('chip_number');
    expect(staleSpecDbCols('Other')).not.toContain('item_type');
    expect(staleSpecDbCols('RAM').length).toBe(staleSpecFields('RAM').length);
  });
});
