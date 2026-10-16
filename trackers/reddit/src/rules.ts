// Named buying rules. Each rule is a plain-English instruction; the enabled
// set is appended to the eval_prompt setting at evaluation time, so a post is
// still judged by exactly one LLM call however many rules exist.

import type {Sql} from './db.ts';

export interface Rule {
  id: number;
  name: string;
  prompt: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RuleRow {
  id: number;
  name: string;
  prompt: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const RULE_COLUMNS = ['id', 'name', 'prompt', 'enabled', 'created_at', 'updated_at'] as const;

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRules(sql: Sql): Promise<Rule[]> {
  const rows = await sql<RuleRow[]>`
    SELECT ${sql(RULE_COLUMNS as unknown as string[])} FROM rules ORDER BY id`;
  return rows.map(toRule);
}

export async function createRule(
  sql: Sql,
  input: {name: string; prompt: string},
): Promise<Rule> {
  const [row] = await sql<RuleRow[]>`
    INSERT INTO rules (name, prompt)
    VALUES (${input.name}, ${input.prompt})
    RETURNING ${sql(RULE_COLUMNS as unknown as string[])}`;
  return toRule(row!);
}

export async function updateRule(
  sql: Sql,
  id: number,
  patch: {name?: string; prompt?: string; enabled?: boolean},
): Promise<Rule | null> {
  const [row] = await sql<RuleRow[]>`
    UPDATE rules
       SET name = COALESCE(${patch.name ?? null}, name),
           prompt = COALESCE(${patch.prompt ?? null}, prompt),
           enabled = COALESCE(${patch.enabled ?? null}, enabled),
           updated_at = NOW()
     WHERE id = ${id}
    RETURNING ${sql(RULE_COLUMNS as unknown as string[])}`;
  return row ? toRule(row) : null;
}

export async function deleteRule(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`DELETE FROM rules WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/**
 * Appends enabled rules to the base evaluator prompt. With no rules the base
 * prompt passes through untouched, so a fleet with an empty rules table
 * behaves exactly as it did before rules existed.
 */
export function composeEvalPrompt(
  basePrompt: string,
  enabledRules: ReadonlyArray<Pick<Rule, 'name' | 'prompt'>>,
): string {
  if (enabledRules.length === 0) return basePrompt;
  const lines = enabledRules.map((r) => `- ${r.name}: ${r.prompt}`);
  return `${basePrompt}\n\nApply each of these additional buying rules:\n${lines.join('\n')}`;
}
