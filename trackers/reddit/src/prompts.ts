// Prompt versions and how each one scores. A version is the exact model and
// system prompt a post was judged with; joining verdicts to the reactions on
// the alerts they produced is what lets a prompt change be proven better
// instead of argued for.

import {createHash} from 'node:crypto';
import type {Sql} from './db.ts';
import {RESPONSE_SCHEMA_ID, type Evaluation} from './llm.ts';
import {composeEvalPrompt, type Rule} from './rules.ts';
import type {Settings} from './settings.ts';
import type {VerdictNote} from './telegram.ts';

export interface PromptConfig {
  model: string;
  systemPrompt: string;
}

/** Includes the response schema, so verdicts from two schemas never share a version. */
export function promptHash(config: PromptConfig): string {
  return createHash('sha256')
    .update(`${RESPONSE_SCHEMA_ID}\0${config.model}\0${config.systemPrompt}`)
    .digest('hex');
}

/** What the fleet judges with right now: the base prompt plus enabled rules. */
export function liveConfig(
  settings: Settings,
  enabledRules: ReadonlyArray<Pick<Rule, 'name' | 'prompt'>>,
): PromptConfig {
  return {
    model: settings.llmModel,
    systemPrompt: composeEvalPrompt(settings.evalPrompt, enabledRules),
  };
}

/**
 * The prompt on trial, or null when there is none. It is judged exactly as
 * written — rules are not appended — so promoting it with the rules disabled
 * reproduces the same version.
 */
export function candidateConfig(settings: Settings): PromptConfig | null {
  if (settings.candidateEvalPrompt.trim() === '') return null;
  return {
    model: settings.candidateLlmModel || settings.llmModel,
    systemPrompt: settings.candidateEvalPrompt,
  };
}

/** Returns the version id for a config, recording it the first time it runs. */
export async function ensurePromptVersion(sql: Sql, config: PromptConfig): Promise<number> {
  const hash = promptHash(config);
  // Update first: an INSERT … ON CONFLICT draws an identity value on every
  // call, so running it once per batch would number versions in the
  // thousands. The insert below only runs the first time a prompt is seen.
  const [known] = await sql<Array<{id: number}>>`
    UPDATE prompt_versions SET last_used_at = NOW() WHERE hash = ${hash} RETURNING id`;
  if (known) return known.id;
  const [row] = await sql<Array<{id: number}>>`
    INSERT INTO prompt_versions (hash, model, system_prompt, response_schema)
    VALUES (${hash}, ${config.model}, ${config.systemPrompt}, ${RESPONSE_SCHEMA_ID})
    ON CONFLICT (hash) DO UPDATE SET last_used_at = NOW()
    RETURNING id`;
  return row!.id;
}

export async function recordCandidateVerdict(
  sql: Sql,
  redditId: string,
  promptVersionId: number,
  evaluation: Evaluation,
): Promise<void> {
  await sql`
    INSERT INTO candidate_verdicts
      (reddit_id, prompt_version_id, is_target, summary, price, reasoning, raw)
    VALUES (${redditId}, ${promptVersionId}, ${evaluation.isTarget}, ${evaluation.summary},
            ${evaluation.price}, ${evaluation.reasoning}, ${sql.json(evaluation.raw as never)})
    ON CONFLICT (reddit_id, prompt_version_id) DO UPDATE
      SET is_target = EXCLUDED.is_target, summary = EXCLUDED.summary, price = EXCLUDED.price,
          reasoning = EXCLUDED.reasoning, raw = EXCLUDED.raw, created_at = NOW()`;
}

/** The live verdict, then the latest candidate verdict if there is one. */
export async function verdictNotes(sql: Sql, redditId: string): Promise<VerdictNote[]> {
  const rows = await sql<Array<{
    label: 'Live' | 'Candidate';
    version_id: number | null;
    model: string | null;
    is_target: boolean;
    reasoning: string | null;
  }>>`
    SELECT 'Live' AS label, p.prompt_version_id AS version_id, pv.model,
           p.is_target, p.llm_raw->>'reasoning' AS reasoning
      FROM posts p
      LEFT JOIN prompt_versions pv ON pv.id = p.prompt_version_id
     WHERE p.reddit_id = ${redditId} AND p.is_target IS NOT NULL
    UNION ALL
    (SELECT 'Candidate', cv.prompt_version_id, pv.model, cv.is_target, cv.reasoning
       FROM candidate_verdicts cv
       JOIN prompt_versions pv ON pv.id = cv.prompt_version_id
      WHERE cv.reddit_id = ${redditId}
      ORDER BY cv.created_at DESC
      LIMIT 1)`;
  return rows.map((r) => ({
    label: r.label,
    promptVersionId: r.version_id,
    model: r.model,
    isTarget: r.is_target,
    reasoning: r.reasoning ?? '',
  }));
}

export type PromptRole = 'live' | 'candidate' | 'retired';

/** Reaction outcomes for the posts a version flagged that reached one audience. */
export interface AudienceScore {
  /** Flagged posts that went out to this audience. */
  sent: number;
  /** …that got any reaction other than 👎. */
  leads: number;
  /** …that got only 👎. */
  notLeads: number;
  /** leads / sent: how often an alert turned into a lead. */
  leadRate: number | null;
}

export interface VsLiveCell {
  posts: number;
  leads: number;
  notLeads: number;
}

export interface PromptVersionStats {
  id: number;
  role: PromptRole;
  model: string;
  systemPrompt: string;
  /** 'verdict-first' for every version made before the reasoning moved ahead. */
  responseSchema: string;
  firstUsedAt: Date;
  lastUsedAt: Date;
  evaluated: number;
  targets: number;
  targetRate: number | null;
  buyers: AudienceScore;
  dev: AudienceScore;
  /**
   * Candidates only: the same posts as the live prompt judged them. Leads in
   * `candidateOnly` are what the candidate would gain, leads in `liveOnly`
   * what it would lose, and notLeads in `liveOnly` the junk it would drop.
   */
  vsLive?: {both: VsLiveCell; liveOnly: VsLiveCell; candidateOnly: VsLiveCell; neither: VsLiveCell};
}

/** A prompt as configured now; its version id is null until it has judged a post. */
export interface ConfiguredPrompt extends PromptConfig {
  promptVersionId: number | null;
}

export interface PromptStats {
  versions: PromptVersionStats[];
  /** Reactions on messages the ledger has no record of, e.g. alerts sent before it existed. */
  unmatchedReactions: number;
  /**
   * What is configured right now, so a trial shows up the moment it starts —
   * before its version has any verdicts to appear in `versions`.
   */
  config: {
    live: ConfiguredPrompt;
    candidate: ConfiguredPrompt | null;
    /** What promoting would disable. */
    enabledRules: number;
  };
}

const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function score(sent: number, leads: number, notLeads: number): AudienceScore {
  return {sent, leads, notLeads, leadRate: rate(leads, sent)};
}

/**
 * Scores every prompt version: posts it judged (discovered since `since`, when
 * given), what it flagged, and how the alerts it flagged were received.
 */
export async function promptStats(
  sql: Sql,
  options: {
    since: Date | null;
    live: PromptConfig;
    candidate: PromptConfig | null;
    enabledRules: number;
  },
): Promise<PromptStats> {
  const liveHash = promptHash(options.live);
  const candidateHash = options.candidate ? promptHash(options.candidate) : null;

  // Fragments are built per query rather than shared across the parallel ones.
  const since = () => (options.since ? sql`AND p.discovered_at >= ${options.since}` : sql``);

  // A post is a lead for an audience when any message it went out as there
  // got a positive reaction, and a not-lead when its only reactions are 👎.
  const postLabels = () => sql`
    SELECT am.reddit_id, am.audience,
           COALESCE(bool_or(ml.positive), FALSE) AS positive,
           COALESCE(bool_or(ml.negative), FALSE) AS negative
      FROM alert_messages am
      LEFT JOIN message_labels ml ON ml.chat_id = am.chat_id AND ml.message_id = am.message_id
     GROUP BY am.reddit_id, am.audience`;

  const [versions, scores, cells, unmatched] = await Promise.all([
    sql<Array<{
      id: number;
      hash: string;
      model: string;
      system_prompt: string;
      response_schema: string;
      first_used_at: Date;
      last_used_at: Date;
    }>>`
      SELECT id, hash, model, system_prompt, response_schema, first_used_at, last_used_at
        FROM prompt_versions ORDER BY id DESC`,
    sql<Array<{
      version_id: number;
      evaluated: number;
      targets: number;
      buyers_sent: number;
      buyers_leads: number;
      buyers_not_leads: number;
      dev_sent: number;
      dev_leads: number;
      dev_not_leads: number;
    }>>`
      -- UNION, not UNION ALL: a candidate identical to the live prompt judges
      -- each post twice under one version, and that is still one verdict.
      WITH verdicts AS (
        SELECT p.prompt_version_id AS version_id, p.reddit_id, p.is_target
          FROM posts p
         WHERE p.prompt_version_id IS NOT NULL AND p.is_target IS NOT NULL ${since()}
        UNION
        SELECT cv.prompt_version_id, cv.reddit_id, cv.is_target
          FROM candidate_verdicts cv JOIN posts p ON p.reddit_id = cv.reddit_id
         WHERE TRUE ${since()}
      ),
      labels AS (${postLabels()})
      SELECT v.version_id,
             COUNT(*)::int AS evaluated,
             COUNT(*) FILTER (WHERE v.is_target)::int AS targets,
             COUNT(b.reddit_id) FILTER (WHERE v.is_target)::int AS buyers_sent,
             COUNT(*) FILTER (WHERE v.is_target AND b.positive)::int AS buyers_leads,
             COUNT(*) FILTER (WHERE v.is_target AND b.negative AND NOT b.positive)::int
               AS buyers_not_leads,
             COUNT(d.reddit_id) FILTER (WHERE v.is_target)::int AS dev_sent,
             COUNT(*) FILTER (WHERE v.is_target AND d.positive)::int AS dev_leads,
             COUNT(*) FILTER (WHERE v.is_target AND d.negative AND NOT d.positive)::int
               AS dev_not_leads
        FROM verdicts v
        LEFT JOIN labels b ON b.reddit_id = v.reddit_id AND b.audience = 'buyers'
        LEFT JOIN labels d ON d.reddit_id = v.reddit_id AND d.audience = 'dev'
       GROUP BY v.version_id`,
    // Head-to-head: each candidate verdict against the live verdict on the
    // same post, labelled by a reaction from either audience.
    sql<Array<{
      version_id: number;
      live: boolean;
      candidate: boolean;
      posts: number;
      leads: number;
      not_leads: number;
    }>>`
      WITH labels AS (${postLabels()}),
      post_label AS (
        SELECT reddit_id, bool_or(positive) AS positive, bool_or(negative) AS negative
          FROM labels GROUP BY reddit_id
      )
      SELECT cv.prompt_version_id AS version_id, p.is_target AS live, cv.is_target AS candidate,
             COUNT(*)::int AS posts,
             COUNT(*) FILTER (WHERE l.positive)::int AS leads,
             COUNT(*) FILTER (WHERE l.negative AND NOT l.positive)::int AS not_leads
        FROM candidate_verdicts cv
        JOIN posts p ON p.reddit_id = cv.reddit_id
        LEFT JOIN post_label l ON l.reddit_id = cv.reddit_id
       WHERE p.is_target IS NOT NULL ${since()}
       GROUP BY cv.prompt_version_id, p.is_target, cv.is_target`,
    sql<Array<{n: number}>>`
      SELECT COUNT(*)::int AS n FROM message_labels ml
       WHERE NOT EXISTS (
         SELECT 1 FROM alert_messages am
          WHERE am.chat_id = ml.chat_id AND am.message_id = ml.message_id)`,
  ]);

  const scoreById = new Map(scores.map((s) => [s.version_id, s]));
  const cellsById = new Map<number, Array<(typeof cells)[number]>>();
  for (const cell of cells) {
    cellsById.set(cell.version_id, [...(cellsById.get(cell.version_id) ?? []), cell]);
  }

  const idByHash = new Map(versions.map((v) => [v.hash, v.id]));
  return {
    unmatchedReactions: unmatched[0]?.n ?? 0,
    config: {
      live: {...options.live, promptVersionId: idByHash.get(liveHash) ?? null},
      candidate: options.candidate
        ? {...options.candidate, promptVersionId: idByHash.get(candidateHash!) ?? null}
        : null,
      enabledRules: options.enabledRules,
    },
    versions: versions.map((v) => {
      const s = scoreById.get(v.id);
      const role: PromptRole = v.hash === liveHash
        ? 'live'
        : v.hash === candidateHash ? 'candidate' : 'retired';
      const stats: PromptVersionStats = {
        id: v.id,
        role,
        model: v.model,
        systemPrompt: v.system_prompt,
        responseSchema: v.response_schema,
        firstUsedAt: v.first_used_at,
        lastUsedAt: v.last_used_at,
        evaluated: s?.evaluated ?? 0,
        targets: s?.targets ?? 0,
        targetRate: rate(s?.targets ?? 0, s?.evaluated ?? 0),
        buyers: score(s?.buyers_sent ?? 0, s?.buyers_leads ?? 0, s?.buyers_not_leads ?? 0),
        dev: score(s?.dev_sent ?? 0, s?.dev_leads ?? 0, s?.dev_not_leads ?? 0),
      };
      const versionCells = cellsById.get(v.id);
      if (versionCells) {
        const cell = (live: boolean, candidate: boolean): VsLiveCell => {
          const c = versionCells.find((x) => x.live === live && x.candidate === candidate);
          return {posts: c?.posts ?? 0, leads: c?.leads ?? 0, notLeads: c?.not_leads ?? 0};
        };
        stats.vsLive = {
          both: cell(true, true),
          liveOnly: cell(true, false),
          candidateOnly: cell(false, true),
          neither: cell(false, false),
        };
      }
      return stats;
    }),
  };
}
