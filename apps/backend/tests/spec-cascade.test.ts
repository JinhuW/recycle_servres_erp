// A line's RAM and SSD specs have to agree: a SODIMM is laptop memory and
// can't carry a 2Rx4 rank, which only full-size DIMMs do, and a SAS SSD is
// never M.2. The forms
// filter and fix the selects from one table (shared/specCascade) and the API
// refuses what the forms would never produce — but only for a rule whose own
// fields the save changes, because prod holds conflicting lines from before
// the rules and a price edit on one must still save.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  allowedOptions, cascadePatch, CASCADE_FIELDS, CASCADE_VOCABULARY, rankNeeds, specConflicts,
  type CascadeSpec,
} from '@recycle-erp/shared';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const ALL = new Set<string>(CASCADE_FIELDS);
const CATALOG_RANKS = [
  '1Rx4', '1Rx8', '1Rx16', '1Rx32', '2Rx4', '2Rx8', '2Rx16', '2Rx32',
  '4Rx4', '4Rx8', '4Rx16', '8Rx4', '8Rx8', '4DRx4', '8DRx4', '2S2Rx4', '2S4Rx4', '4S2Rx4',
];
// What a SODIMM, CAMM or laptop takes, and what a UDIMM or desktop takes.
const SMALL_RANKS = ['1Rx8', '1Rx16', '1Rx32', '2Rx8', '2Rx16', '2Rx32'];
const UDIMM_RANKS = ['1Rx4', '1Rx8', '1Rx16', '1Rx32', '2Rx4', '2Rx8', '2Rx16', '2Rx32', '4Rx8', '4Rx16'];

describe('rankNeeds', () => {
  it('sorts every catalog rank', () => {
    for (const r of CATALOG_RANKS) {
      const tier = SMALL_RANKS.includes(r) ? 'any' : UDIMM_RANKS.includes(r) ? 'dimm' : 'buffered';
      expect(rankNeeds(r), r).toBe(tier);
    }
  });

  it('sorts a rank the catalog lacks by the same arithmetic', () => {
    expect(rankNeeds('3Rx8')).toBe('any');
    expect(rankNeeds('2s8rx4')).toBe('buffered');
  });

  it('does not judge a spelling it does not know', () => {
    expect(rankNeeds('dual rank')).toBeNull();
    expect(rankNeeds('')).toBeNull();
    expect(rankNeeds(null)).toBeNull();
  });
});

describe('specConflicts', () => {
  const ram = (spec: Record<string, string>) => specConflicts('RAM', spec, ALL);
  const ssd = (spec: Record<string, string>) => specConflicts('SSD', spec, ALL);

  it('ties Device to Form', () => {
    expect(ram({ classification: 'RDIMM', type: 'Laptop' })).toBe("Laptop doesn't fit RDIMM (RDIMM is Server)");
    expect(ram({ classification: 'SODIMM', type: 'Server' })).toBe("Server doesn't fit SODIMM (SODIMM is Laptop)");
    expect(ram({ classification: 'UDIMM', type: 'Laptop' })).toBe("Laptop doesn't fit UDIMM (UDIMM is Desktop or Server)");
    expect(ram({ classification: 'CAMM', type: 'Desktop', generation: 'DDR5' })).toMatch(/doesn't fit CAMM/);
    // ECC UDIMMs are real server memory.
    expect(ram({ classification: 'UDIMM', type: 'Server' })).toBeNull();
    expect(ram({ classification: 'LRDIMM', type: 'Server' })).toBeNull();
  });

  it('keeps each rank on the modules that carry it', () => {
    expect(ram({ classification: 'SODIMM', type: 'Laptop', rank: '2Rx4' }))
      .toBe("2Rx4 needs a full-size DIMM and doesn't fit SODIMM");
    expect(ram({ type: 'Laptop', rank: '4Rx8' })).toBe("4Rx8 needs a full-size DIMM and doesn't fit Laptop");
    expect(ram({ classification: 'UDIMM', type: 'Server', rank: '4DRx4' }))
      .toBe("4DRx4 is a server rank and doesn't fit UDIMM");
    expect(ram({ type: 'Desktop', rank: '4Rx4' })).toBe("4Rx4 is a server rank and doesn't fit Desktop");
    // DDR3 high-density desktop modules are 2Rx4; DDR5 CQDIMMs are 4Rx8.
    expect(ram({ classification: 'UDIMM', type: 'Desktop', rank: '2Rx4', generation: 'DDR3' })).toBeNull();
    expect(ram({ classification: 'UDIMM', type: 'Desktop', rank: '4Rx8', generation: 'DDR5' })).toBeNull();
    expect(ram({ type: 'Desktop', rank: '1Rx4' })).toBeNull();
    expect(ram({ classification: 'UDIMM', type: 'Server', rank: '2Rx4' })).toBeNull();
    expect(ram({ classification: 'RDIMM', type: 'Server', rank: '2S2Rx4' })).toBeNull();
    expect(ram({ classification: 'UDIMM', type: 'Desktop', rank: '2Rx8' })).toBeNull();
    // A legacy pair is held to the stricter of its two fields.
    expect(specConflicts('RAM', { classification: 'UDIMM', type: 'Laptop', rank: '2Rx4' }, new Set(['rank'])))
      .toBe("2Rx4 needs a full-size DIMM and doesn't fit Laptop");
  });

  it('allows CAMM only on DDR5', () => {
    expect(ram({ classification: 'CAMM', generation: 'DDR4' })).toBe('CAMM is DDR5 only, not DDR4');
    expect(ram({ classification: 'CAMM', generation: 'DDR5', type: 'Laptop' })).toBeNull();
  });

  it('ties an SSD form factor to its interface', () => {
    expect(ssd({ interface: 'SAS', formFactor: 'M.2 2280' })).toBe("M.2 2280 doesn't fit a SAS SSD");
    expect(ssd({ interface: 'SATA', formFactor: 'AIC' })).toBe("AIC doesn't fit a SATA SSD");
    expect(ssd({ interface: 'U.2', formFactor: 'M.2 2280' })).toMatch(/doesn't fit a U.2 SSD/);
    // Combinations prod actually holds.
    expect(ssd({ interface: 'NVMe', formFactor: '2.5"' })).toBeNull();
    expect(ssd({ interface: 'SATA', formFactor: 'M.2 2230' })).toBeNull();
    expect(ssd({ interface: 'SAS', formFactor: '2.5"' })).toBeNull();
    // HPE LFF SAS SSDs are sold as 3.5"; native 3.5" SATA and SAS SSDs exist.
    expect(ssd({ interface: 'SAS', formFactor: '3.5"' })).toBeNull();
    expect(ssd({ interface: 'SATA', formFactor: '3.5"' })).toBeNull();
    expect(ssd({ interface: 'NVMe', formFactor: '3.5"' })).toBe('3.5" doesn\'t fit a NVMe SSD');
    expect(ssd({ interface: 'U.2', formFactor: '3.5"' })).toMatch(/doesn't fit a U.2 SSD/);
  });

  it('passes blank and unknown values', () => {
    expect(ram({ classification: 'SODIMM' })).toBeNull();
    expect(ram({ type: 'Server', rank: '2Rx4' })).toBeNull();
    // Before 0027 `type` held the generation; those lines still exist.
    expect(ram({ classification: 'RDIMM', type: 'DDR4', rank: '2Rx4' })).toBeNull();
    expect(ram({ classification: 'ECC', type: 'Laptop', rank: 'weird' })).toBeNull();
    expect(ssd({ interface: 'SATA', formFactor: 'M.2' })).toBeNull();
    expect(ssd({ interface: 'PCIe', formFactor: 'AIC' })).toBeNull();
    // HDD shares the interface and form-factor fields but not the rule.
    expect(specConflicts('HDD', { interface: 'SAS', formFactor: 'M.2 2280' }, ALL)).toBeNull();
  });

  it('matches whatever the case', () => {
    expect(ram({ classification: 'rdimm', type: 'laptop' })).toMatch(/doesn't fit/);
    expect(ssd({ interface: 'nvme', formFactor: 'aic' })).toBeNull();
  });

  it('judges only the rules whose fields changed', () => {
    const legacy = { classification: 'SODIMM', type: 'Laptop', rank: '2Rx4' };
    expect(specConflicts('RAM', legacy, new Set(['brand', 'speed']))).toBeNull();
    expect(specConflicts('RAM', legacy, new Set(['generation']))).toBeNull();
    expect(specConflicts('RAM', legacy, new Set(['rank']))).toMatch(/needs a full-size DIMM/);
    expect(specConflicts('RAM', { classification: 'RDIMM', type: 'Laptop' }, new Set(['rank']))).toBeNull();
  });
});

describe('allowedOptions', () => {
  const FORMS = ['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM', 'CAMM'];
  const SSD_FORMS = ['2.5"', '3.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110', 'U.2', 'AIC', 'Legacy'];

  it('offers CAMM only on DDR5', () => {
    expect(allowedOptions('RAM', 'classification', { generation: 'DDR4' }, FORMS)).not.toContain('CAMM');
    expect(allowedOptions('RAM', 'classification', { generation: 'DDR5' }, FORMS)).toEqual(FORMS);
    expect(allowedOptions('RAM', 'classification', {}, FORMS)).toEqual(FORMS);
  });

  it('offers each module the ranks it carries', () => {
    expect(allowedOptions('RAM', 'rank', { classification: 'SODIMM' }, CATALOG_RANKS)).toEqual(SMALL_RANKS);
    expect(allowedOptions('RAM', 'rank', { type: 'Laptop' }, CATALOG_RANKS)).toEqual(SMALL_RANKS);
    expect(allowedOptions('RAM', 'rank', { classification: 'CAMM', generation: 'DDR5' }, CATALOG_RANKS)).toEqual(SMALL_RANKS);
    expect(allowedOptions('RAM', 'rank', { classification: 'UDIMM', type: 'Desktop' }, CATALOG_RANKS)).toEqual(UDIMM_RANKS);
    expect(allowedOptions('RAM', 'rank', { type: 'Desktop' }, CATALOG_RANKS)).toEqual(UDIMM_RANKS);
    // An ECC UDIMM is limited by the module, not by the server it goes in.
    expect(allowedOptions('RAM', 'rank', { classification: 'UDIMM', type: 'Server' }, CATALOG_RANKS)).toEqual(UDIMM_RANKS);
    expect(allowedOptions('RAM', 'rank', { classification: 'UDIMM', type: 'Laptop' }, CATALOG_RANKS)).toEqual(SMALL_RANKS);
    expect(allowedOptions('RAM', 'rank', { classification: 'RDIMM', type: 'Server' }, CATALOG_RANKS)).toEqual(CATALOG_RANKS);
    expect(allowedOptions('RAM', 'rank', {}, CATALOG_RANKS)).toEqual(CATALOG_RANKS);
  });

  it('follows the SSD interface, keeping options it does not know', () => {
    expect(allowedOptions('SSD', 'formFactor', { interface: 'SAS' }, SSD_FORMS)).toEqual(['2.5"', '3.5"', 'Legacy']);
    expect(allowedOptions('SSD', 'formFactor', { interface: 'SATA' }, SSD_FORMS))
      .toEqual(['2.5"', '3.5"', 'M.2 2230', 'M.2 2280', 'M.2 22110', 'Legacy']);
    expect(allowedOptions('SSD', 'formFactor', { interface: 'NVMe' }, SSD_FORMS))
      .toEqual(SSD_FORMS.filter(f => f !== '3.5"'));
    expect(allowedOptions('SSD', 'formFactor', { interface: 'U.2' }, SSD_FORMS)).toEqual(['2.5"', 'U.2', 'Legacy']);
    expect(allowedOptions('SSD', 'formFactor', {}, SSD_FORMS)).toEqual(SSD_FORMS);
    expect(allowedOptions('HDD', 'formFactor', { interface: 'SAS' }, SSD_FORMS)).toEqual(SSD_FORMS);
  });

  it('never filters Device or Form by each other', () => {
    const devices = ['Desktop', 'Server', 'Laptop'];
    expect(allowedOptions('RAM', 'type', { classification: 'RDIMM' }, devices)).toEqual(devices);
    expect(allowedOptions('RAM', 'classification', { type: 'Desktop' }, FORMS)).toEqual(FORMS);
  });
});

describe('cascadePatch', () => {
  const ram = (spec: Record<string, string>, patch: Record<string, string>) => cascadePatch('RAM', spec, patch);

  it('fills Class from Device when only one fits', () => {
    expect(ram({}, { type: 'Desktop' })).toEqual({ type: 'Desktop', classification: 'UDIMM' });
    expect(ram({ generation: 'DDR4' }, { type: 'Laptop' })).toEqual({ type: 'Laptop', classification: 'SODIMM' });
    // DDR5 laptops take SODIMM or CAMM, and so does a line with no generation yet.
    expect(ram({ generation: 'DDR5' }, { type: 'Laptop' })).toEqual({ type: 'Laptop' });
    expect(ram({}, { type: 'Laptop' })).toEqual({ type: 'Laptop' });
    expect(ram({}, { type: 'Server' })).toEqual({ type: 'Server' });
  });

  it('clears a Class the new Device rules out, and keeps one that fits', () => {
    expect(ram({ classification: 'SODIMM', type: 'Laptop' }, { type: 'Server' }))
      .toEqual({ type: 'Server', classification: '' });
    expect(ram({ classification: 'UDIMM', type: 'Desktop' }, { type: 'Server' })).toEqual({ type: 'Server' });
    expect(ram({ classification: 'RDIMM', type: 'Server' }, { type: 'Desktop' }))
      .toEqual({ type: 'Desktop', classification: 'UDIMM' });
  });

  it('fills or fixes Device from Class', () => {
    expect(ram({}, { classification: 'RDIMM' })).toEqual({ classification: 'RDIMM', type: 'Server' });
    expect(ram({}, { classification: 'UDIMM' })).toEqual({ classification: 'UDIMM', type: 'Desktop' });
    expect(ram({ type: 'Server' }, { classification: 'SODIMM' })).toEqual({ classification: 'SODIMM', type: 'Laptop' });
    expect(ram({ type: 'Server' }, { classification: 'UDIMM' })).toEqual({ classification: 'UDIMM' });
    expect(ram({ classification: 'UDIMM', type: 'Desktop' }, { classification: 'UDIMM' })).toEqual({ classification: 'UDIMM' });
  });

  it('clears a rank the new Form or Device rules out', () => {
    expect(ram({ classification: 'RDIMM', type: 'Server', rank: '2Rx4' }, { classification: 'SODIMM' }))
      .toEqual({ classification: 'SODIMM', type: 'Laptop', rank: '' });
    expect(ram({ type: 'Server', rank: '4Rx4' }, { type: 'Desktop' }))
      .toEqual({ type: 'Desktop', classification: 'UDIMM', rank: '' });
    // Server still fits UDIMM (ECC UDIMM), so it stays, and 2Rx8 fits both.
    expect(ram({ classification: 'RDIMM', type: 'Server', rank: '2Rx8' }, { classification: 'UDIMM' }))
      .toEqual({ classification: 'UDIMM' });
    // x4 at one or two ranks fits a full-size UDIMM too.
    expect(ram({ classification: 'RDIMM', type: 'Server', rank: '2Rx4' }, { classification: 'UDIMM' }))
      .toEqual({ classification: 'UDIMM' });
    expect(ram({ type: 'Server', rank: '2Rx4' }, { type: 'Desktop' }))
      .toEqual({ type: 'Desktop', classification: 'UDIMM' });
  });

  it('keeps or clears a full-size rank as the module changes', () => {
    const desk = { classification: 'UDIMM', type: 'Desktop', rank: '2Rx4', generation: 'DDR3' };
    expect(ram(desk, { classification: 'SODIMM' })).toEqual({ classification: 'SODIMM', type: 'Laptop', rank: '' });
    expect(ram(desk, { type: 'Laptop' })).toEqual({ type: 'Laptop', classification: 'SODIMM', rank: '' });
    expect(ram({ ...desk, generation: 'DDR5' }, { classification: 'CAMM' }))
      .toEqual({ classification: 'CAMM', type: 'Laptop', rank: '' });
    expect(ram(desk, { type: 'Server' })).toEqual({ type: 'Server' });
  });

  it('clears CAMM when the generation rules it out, then refills from Device', () => {
    expect(ram({ classification: 'CAMM', type: 'Laptop', generation: 'DDR5' }, { generation: 'DDR4' }))
      .toEqual({ generation: 'DDR4', classification: 'SODIMM' });
    // Laptop picked before the generation: the Class follows once it is known.
    expect(ram({ type: 'Laptop' }, { generation: 'DDR4' })).toEqual({ generation: 'DDR4', classification: 'SODIMM' });
    expect(ram({ type: 'Laptop', classification: 'SODIMM' }, { generation: 'DDR3' })).toEqual({ generation: 'DDR3' });
  });

  it('lets the label win when a scan sets everything at once', () => {
    expect(ram({}, { classification: 'SODIMM', type: 'Server', rank: '2Rx4', generation: 'DDR4' }))
      .toEqual({ classification: 'SODIMM', type: 'Laptop', rank: '', generation: 'DDR4' });
    expect(ram({}, { classification: 'CAMM', type: 'Laptop', generation: 'DDR4' }))
      .toEqual({ classification: 'SODIMM', type: 'Laptop', generation: 'DDR4' });
    const highDensity = { classification: 'UDIMM', type: 'Desktop', rank: '2Rx4', generation: 'DDR3' };
    expect(ram({}, highDensity)).toEqual(highDensity);
  });

  it('leaves a legacy conflict alone on an unrelated edit', () => {
    const legacy = { classification: 'SODIMM', type: 'Server', rank: '2Rx4' };
    expect(cascadePatch('RAM', legacy, { brand: 'Samsung' } as Record<string, string>)).toEqual({ brand: 'Samsung' });
    expect(ram(legacy, { speed: '3200' })).toEqual({ speed: '3200' });
  });

  it('treats null, blank and undefined as the same empty value', () => {
    const ram: CascadeSpec = { classification: null, type: 'Desktop' };
    const ssd: CascadeSpec = { interface: 'SATA', formFactor: null };
    expect(cascadePatch('RAM', ram, { classification: '' })).toEqual({ classification: '' });
    expect(cascadePatch('SSD', ssd, { formFactor: '' })).toEqual({ formFactor: '' });
  });

  it('follows the SSD interface', () => {
    // SAS fits 2.5" and 3.5", but 2.5" is the drive itself, so it is filled.
    expect(cascadePatch('SSD', {}, { interface: 'SAS' })).toEqual({ interface: 'SAS', formFactor: '2.5"' });
    expect(cascadePatch('SSD', { formFactor: '3.5"' }, { interface: 'SAS' })).toEqual({ interface: 'SAS' });
    expect(cascadePatch('SSD', { formFactor: '3.5"' }, { interface: 'NVMe' })).toEqual({ interface: 'NVMe', formFactor: '' });
    expect(cascadePatch('SSD', {}, { interface: 'SATA' })).toEqual({ interface: 'SATA' });
    expect(cascadePatch('SSD', {}, { interface: 'U.2' })).toEqual({ interface: 'U.2' });
    expect(cascadePatch('SSD', { formFactor: 'U.2' }, { interface: 'SATA' })).toEqual({ interface: 'SATA', formFactor: '' });
    expect(cascadePatch('SSD', { formFactor: 'M.2 2280' }, { interface: 'SAS' })).toEqual({ interface: 'SAS', formFactor: '2.5"' });
    expect(cascadePatch('SSD', { formFactor: '2.5"' }, { interface: 'NVMe' })).toEqual({ interface: 'NVMe' });
    expect(cascadePatch('SSD', { formFactor: 'M.2' }, { interface: 'SAS' })).toEqual({ interface: 'SAS' });
    expect(cascadePatch('HDD', { formFactor: 'M.2 2280' }, { interface: 'SAS' })).toEqual({ interface: 'SAS' });
  });

  it('never produces what the API refuses', () => {
    const starts: Record<string, string>[] = [
      {}, { classification: 'SODIMM', type: 'Laptop', rank: '2Rx8', generation: 'DDR4' },
      { classification: 'RDIMM', type: 'Server', rank: '4DRx4', generation: 'DDR5' },
      { classification: 'CAMM', type: 'Laptop', generation: 'DDR5', rank: '1Rx16' },
      { classification: 'UDIMM', type: 'Desktop', generation: 'DDR3', rank: '2Rx4' },
    ];
    const picks: Record<string, string>[] = [
      ...['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM', 'CAMM'].map(classification => ({ classification })),
      ...['Desktop', 'Server', 'Laptop'].map(type => ({ type })),
      ...['DDR3', 'DDR4', 'DDR5'].map(generation => ({ generation })),
      ...CATALOG_RANKS.map(rank => ({ rank })),
    ];
    for (const s of starts) {
      for (const p of picks) {
        const opts = p.rank !== undefined ? allowedOptions('RAM', 'rank', s, CATALOG_RANKS) : null;
        if (opts && !opts.includes(p.rank)) continue; // not offered, so not pickable
        if (p.classification && !allowedOptions('RAM', 'classification', s, [p.classification]).length) continue;
        const next = { ...s, ...cascadePatch('RAM', s, p) };
        expect(specConflicts('RAM', next, ALL), JSON.stringify([s, p])).toBeNull();
      }
    }
  });

  it('never makes a legacy line refuse a pick, judging what the pick changes', () => {
    const legacy: Record<string, string>[] = [
      { classification: 'UDIMM', type: 'Laptop', rank: '1Rx8', generation: 'DDR4' },
      { classification: 'SODIMM', type: 'Server', rank: '2Rx4', generation: 'DDR4' },
    ];
    const picks: Record<string, string>[] = [
      ...['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM', 'CAMM'].map(classification => ({ classification })),
      ...['Desktop', 'Server', 'Laptop'].map(type => ({ type })),
      ...['DDR3', 'DDR4', 'DDR5'].map(generation => ({ generation })),
      ...CATALOG_RANKS.map(rank => ({ rank })),
    ];
    for (const s of legacy) {
      for (const p of picks) {
        if (p.rank !== undefined && !allowedOptions('RAM', 'rank', s, CATALOG_RANKS).includes(p.rank)) continue;
        if (p.classification && !allowedOptions('RAM', 'classification', s, [p.classification]).length) continue;
        const out = cascadePatch('RAM', s, p) as Record<string, string>;
        // The API judges a field only when its value moves, as orderInput does.
        const changed = new Set(Object.keys(out).filter(k => (out[k] ?? '') !== (s[k] ?? '')));
        expect(specConflicts('RAM', { ...s, ...out }, changed), JSON.stringify([s, p])).toBeNull();
      }
    }
  });
});

describe('the tables know every catalog option', () => {
  beforeEach(async () => { await resetDb(); });

  it('covers RAM class, generation and rank, and SSD interface and form factor', async () => {
    const rows = await getTestDb()<{ group: string; value: string }[]>`
      SELECT "group", value FROM catalog_options
      WHERE active AND "group" IN ('RAM_CLASS', 'RAM_TYPE', 'RAM_RANK', 'SSD_INTERFACE', 'SSD_FORM')
    `;
    const of = (g: string) => rows.filter(r => r.group === g).map(r => r.value);
    expect(of('RAM_CLASS').length).toBeGreaterThan(0);
    const known = (list: readonly string[], v: string) => list.some(x => x.toUpperCase() === v.toUpperCase());
    for (const v of of('RAM_CLASS')) expect(known(CASCADE_VOCABULARY.classification, v), v).toBe(true);
    for (const v of of('RAM_TYPE')) expect(known(CASCADE_VOCABULARY.generation, v), v).toBe(true);
    for (const v of of('RAM_RANK')) expect(rankNeeds(v), v).not.toBeNull();
    for (const v of of('SSD_INTERFACE')) expect(known(CASCADE_VOCABULARY.interface, v), v).toBe(true);
    for (const v of of('SSD_FORM')) expect(known(CASCADE_VOCABULARY.formFactor, v), v).toBe(true);
  });
});

// ── The API ───────────────────────────────────────────────────────────────

type Detail = { order: { lines: Array<{ id: string; classification: string | null; type: string | null; rank: string | null; brand: string | null }> } };

const RAM_LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '16GB', generation: 'DDR4', type: 'Laptop',
  classification: 'SODIMM', rank: '2Rx8', speed: '3200', partNumber: 'M471A2K43DB1-CWE',
  condition: 'Pulled — Tested', qty: 4, unitCost: 20,
};
const SSD_LINE = {
  category: 'SSD', brand: 'Intel', capacity: '960GB', interface: 'SATA', formFactor: '2.5"',
  partNumber: 'SSDSC2KB960G8', condition: 'Pulled — Tested', qty: 2, unitCost: 70,
};

async function createPo(token: string, lines: Record<string, unknown>[]) {
  return api<{ id: string; error?: string }>('POST', '/api/orders', { token, body: { lines } });
}

async function lineOf(token: string, id: string) {
  return (await api<Detail>('GET', '/api/orders/' + id, { token })).body.order.lines[0];
}

// The rules are new; prod lines from before them break them. Plant one.
async function makeLegacy(token: string): Promise<{ id: string; lineId: string }> {
  const r = await createPo(token, [RAM_LINE]);
  expect(r.status).toBe(201);
  const lineId = (await lineOf(token, r.body.id)).id;
  await getTestDb()`UPDATE order_lines SET rank = '4DRx4' WHERE id = ${lineId}`;
  return { id: r.body.id, lineId };
}

describe('the API refuses a spec conflict', () => {
  beforeEach(async () => { await resetDb(); });

  it('on a new PO', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [SSD_LINE, { ...RAM_LINE, classification: 'RDIMM', rank: '2Rx4' }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("new product 2 (M471A2K43DB1-CWE): Laptop doesn't fit RDIMM (RDIMM is Server)");
    const ok = await createPo(token, [{ ...RAM_LINE, classification: 'RDIMM', type: 'Server', rank: '2Rx4' }]);
    expect(ok.status).toBe(201);
  });

  it('saves x4 on a desktop module and refuses it on a laptop one', async () => {
    const { token } = await loginAs(MARCUS);
    const desk = { ...RAM_LINE, generation: 'DDR3', classification: 'UDIMM', type: 'Desktop', rank: '2Rx4' };
    expect((await createPo(token, [desk])).status).toBe(201);
    const r = await createPo(token, [{ ...RAM_LINE, rank: '2Rx4' }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("new product 1 (M471A2K43DB1-CWE): 2Rx4 needs a full-size DIMM and doesn't fit SODIMM");
  });

  it('on a line added to a PO', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await createPo(token, [RAM_LINE]);
    const add = await api<{ error: string }>('PATCH', '/api/orders/' + r.body.id, {
      token, body: { addLines: [{ ...SSD_LINE, interface: 'SAS', formFactor: 'M.2 2280' }] },
    });
    expect(add.status).toBe(400);
    expect(add.body.error).toBe("new product (SSDSC2KB960G8): M.2 2280 doesn't fit a SAS SSD");
  });

  it('on a PO line edit that changes the conflicting fields, and only then', async () => {
    const { token } = await loginAs(MARCUS);
    const { id, lineId } = await makeLegacy(token);
    const patch = (l: Record<string, unknown>) =>
      api<{ error: string }>('PATCH', '/api/orders/' + id, { token, body: { lines: [{ id: lineId, ...l }] } });

    // The edit forms echo every field back; unchanged ones are not judged.
    expect((await patch({ ...RAM_LINE, rank: '4DRx4', qty: 5 })).status).toBe(200);
    expect((await patch({ brand: 'SK Hynix' })).status).toBe(200);

    const moved = await patch({ classification: 'UDIMM', type: 'Desktop' });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/4DRx4 is a server rank and doesn't fit UDIMM/);

    expect((await patch({ type: 'Server' })).status).toBe(400);
    expect((await patch({ classification: 'UDIMM', type: 'Desktop', rank: '2Rx8' })).status).toBe(200);
    const after = await lineOf(token, id);
    expect([after.classification, after.type, after.rank]).toEqual(['UDIMM', 'Desktop', '2Rx8']);
  });

  it('judges a cleared field as cleared, the way the UPDATE stores it', async () => {
    const { token } = await loginAs(MARCUS);
    const { id, lineId } = await makeLegacy(token);
    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, classification: 'RDIMM', type: 'Server', rank: null }] },
    });
    expect(r.status).toBe(200);
    expect((await lineOf(token, id)).rank).toBeNull();
  });

  it('on an inventory edit that changes the conflicting fields, and only then', async () => {
    const { token } = await loginAs(MARCUS);
    const { lineId } = await makeLegacy(token);
    const mgr = await loginAs(ALEX);
    const edit = (body: Record<string, unknown>) =>
      api<{ error: string }>('PATCH', '/api/inventory/' + lineId, { token: mgr.token, body });

    expect((await edit({ unitCost: 25 })).status).toBe(200);
    const bad = await edit({ type: 'Desktop' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Desktop doesn't fit SODIMM (SODIMM is Laptop)");
    expect((await edit({ rank: '1Rx4' })).status).toBe(400);
    expect((await edit({ rank: '2Rx8' })).status).toBe(200);

    const ssd = await createPo(token, [SSD_LINE]);
    const ssdLine = (await lineOf(token, ssd.body.id)).id;
    const r = await api<{ error: string }>('PATCH', '/api/inventory/' + ssdLine, { token: mgr.token, body: { formFactor: 'AIC' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("AIC doesn't fit a SATA SSD");
  });
});
