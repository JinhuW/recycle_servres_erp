import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  composeEvalPrompt,
  createRule,
  deleteRule,
  listRules,
  updateRule,
} from '../src/rules.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb('rules');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM rules`;
});

describe('rule CRUD', () => {
  it('creates a rule enabled by default and lists it', async () => {
    const created = await createRule(db.sql, {
      name: 'EPYC lots',
      prompt: 'Alert on bulk EPYC CPU lots.',
    });

    expect(created).toMatchObject({
      name: 'EPYC lots',
      prompt: 'Alert on bulk EPYC CPU lots.',
      enabled: true,
    });
    expect(created.id).toBeGreaterThan(0);

    const rules = await listRules(db.sql);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe(created.id);
  });

  it('updates only the provided fields and bumps updated_at', async () => {
    const created = await createRule(db.sql, {name: 'RAM', prompt: 'ECC RDIMM deals.'});

    const updated = await updateRule(db.sql, created.id, {enabled: false});

    expect(updated).toMatchObject({
      id: created.id,
      name: 'RAM',
      prompt: 'ECC RDIMM deals.',
      enabled: false,
    });
    expect(new Date(updated!.updatedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(created.updatedAt).getTime());
  });

  it('returns null when updating a rule that does not exist', async () => {
    expect(await updateRule(db.sql, 999_999, {enabled: false})).toBeNull();
  });

  it('deletes a rule and reports whether anything was deleted', async () => {
    const created = await createRule(db.sql, {name: 'X', prompt: 'Y'});

    expect(await deleteRule(db.sql, created.id)).toBe(true);
    expect(await deleteRule(db.sql, created.id)).toBe(false);
    expect(await listRules(db.sql)).toHaveLength(0);
  });
});

describe('composeEvalPrompt', () => {
  it('returns the base prompt untouched when there are no enabled rules', () => {
    expect(composeEvalPrompt('Base prompt.', [])).toBe('Base prompt.');
  });

  it('appends each enabled rule under a single instruction block', () => {
    const composed = composeEvalPrompt('Base prompt.', [
      {name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.'},
      {name: 'No consumer gear', prompt: 'Ignore RGB gaming hardware.'},
    ]);

    expect(composed).toContain('Base prompt.');
    expect(composed).toContain('EPYC lots: Alert on bulk EPYC CPU lots.');
    expect(composed).toContain('No consumer gear: Ignore RGB gaming hardware.');
    expect(composed.indexOf('Base prompt.')).toBeLessThan(composed.indexOf('EPYC lots'));
  });

  it('feeds only enabled rules from the database into the composition', async () => {
    await createRule(db.sql, {name: 'On', prompt: 'Enabled rule.'});
    const off = await createRule(db.sql, {name: 'Off', prompt: 'Disabled rule.'});
    await updateRule(db.sql, off.id, {enabled: false});

    const enabled = (await listRules(db.sql)).filter((r) => r.enabled);
    const composed = composeEvalPrompt('Base.', enabled);

    expect(composed).toContain('Enabled rule.');
    expect(composed).not.toContain('Disabled rule.');
  });
});
