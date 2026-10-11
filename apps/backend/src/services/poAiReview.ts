// AI review of a PO: queued when the order moves into Reviewing, run by a
// background loop, read and acted on in Review mode (routes/orders/aiReview.ts).
//
// The queue is the po_ai_reviews table. The move that enqueues runs in the
// advance transaction, so a committed move always has its review; the loop
// claims rows with SKIP LOCKED, so two backend instances never run the same
// one. The model calls happen outside any transaction, and only the result
// is written in one.
//
// The review suggests; it never writes a line. Each finding is applied or
// dismissed by a manager.

import { createHash } from 'node:crypto';
import { canonicalPartNumber, isRealPhotoUrl } from '@recycle-erp/shared';
import type { Sql } from 'postgres';
import type { SqlLike } from '../db';
import type { Env, LineCategory } from '../types';
import { pickProvider } from '../ai';
import { aiModel, type AiUsage } from '../ai/openrouter';
import { lookUpPartNumber, rereadLabel } from '../ai/poReview';
import { allLimited } from '../lib/concurrency';
import { getWorkspaceSetting } from '../lib/settings';
import { log } from '../lib/log';
import { notify, notifyManagers } from '../lib/notify';
import { canonPartCol } from '../lib/part-number';
import { writeOrderEvent } from './orderAudit';
import {
  checkLine, isDisputed, needsWebLookup,
  type Finding, type LabelRead, type LineEvidence, type MarketRef, type ReviewLine, type WebSpec,
} from './poReviewChecks';

const reviewLog = log.child({ module: 'po-ai-review' });

export type PoAiReviewSetting = {
  enabled: boolean;
  /** OpenRouter model; null → OPENROUTER_OCR_MODEL. */
  model: string | null;
  webLookup: boolean;
  maxCostPerPoUsd: number;
};

const DEFAULT_SETTING: PoAiReviewSetting = {
  enabled: false, model: null, webLookup: true, maxCostPerPoUsd: 0.5,
};

export async function poAiReviewSetting(sql: SqlLike): Promise<PoAiReviewSetting> {
  const v = await getWorkspaceSetting<Partial<PoAiReviewSetting>>(sql, 'po_ai_review', {});
  return { ...DEFAULT_SETTING, ...v };
}

export function isPoAiReviewSetting(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (o.enabled === undefined || typeof o.enabled === 'boolean')
    && (o.webLookup === undefined || typeof o.webLookup === 'boolean')
    && (o.model === undefined || o.model === null
      || (typeof o.model === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(o.model)))
    && (o.maxCostPerPoUsd === undefined
      || (typeof o.maxCostPerPoUsd === 'number' && o.maxCostPerPoUsd > 0 && o.maxCostPerPoUsd <= 10));
}

/**
 * Queues a review of `orderId`; false when one is already queued or running.
 * Runs inside the caller's transaction.
 */
export async function queuePoAiReviewTx(
  tx: SqlLike, orderId: string, trigger: 'stage' | 'manual', requestedBy: string | null,
): Promise<boolean> {
  const rows = await tx`
    INSERT INTO po_ai_reviews (order_id, trigger, requested_by)
    VALUES (${orderId}, ${trigger}, ${requestedBy})
    ON CONFLICT (order_id) WHERE status IN ('queued','running') DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

/** The order left review backwards: a pending review would read a version nobody will review. */
export async function supersedePoAiReviewsTx(tx: SqlLike, orderId: string): Promise<void> {
  await tx`
    UPDATE po_ai_reviews SET status = 'superseded', finished_at = NOW()
    WHERE order_id = ${orderId} AND status IN ('queued','running')
  `;
}

// ── Running one review ────────────────────────────────────────────────────

type LineRow = {
  id: string; product_no: number | null; category: string;
  brand: string | null; capacity: string | null; generation: string | null; type: string | null;
  classification: string | null; rank: string | null; speed: string | null; interface: string | null;
  form_factor: string | null; rpm: number | null; part_number: string | null;
  qty: number; unit_cost: number;
  scan_url: string | null; scan_fields: Record<string, string> | null; photo_url: string | null;
};

async function loadLines(sql: SqlLike, orderId: string): Promise<LineRow[]> {
  return sql<LineRow[]>`
    SELECT ol.id, ol.product_no, ol.category, ol.brand, ol.capacity, ol.generation, ol.type,
           ol.classification, ol.rank, ol.speed, ol.interface, ol.form_factor, ol.rpm,
           ol.part_number, ol.qty, ol.unit_cost::float AS unit_cost,
           ls.delivery_url AS scan_url, ls.extracted AS scan_fields,
           (SELECT p.delivery_url FROM order_line_photos p WHERE p.order_line_id = ol.id
             ORDER BY p.position, p.uploaded_at LIMIT 1) AS photo_url
    FROM order_lines ol
    LEFT JOIN LATERAL (
      SELECT delivery_url, extracted FROM label_scans
      WHERE cf_image_id = ol.scan_image_id ORDER BY created_at DESC LIMIT 1
    ) ls ON TRUE
    WHERE ol.order_id = ${orderId} AND ol.qty > 0
    ORDER BY ol.product_no NULLS LAST, ol.position, ol.id
  `;
}

function toReviewLine(r: LineRow): ReviewLine {
  return {
    id: r.id, productNo: r.product_no, category: r.category,
    brand: r.brand, capacity: r.capacity, generation: r.generation, type: r.type,
    classification: r.classification, rank: r.rank, speed: r.speed, interface: r.interface,
    formFactor: r.form_factor, rpm: r.rpm, partNumber: r.part_number,
    qty: r.qty, unitCost: r.unit_cost,
  };
}

/** What the review read, so a write can tell the lines moved under it. */
export function linesHash(rows: readonly ReviewLine[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function marketRefs(sql: SqlLike, lines: readonly ReviewLine[]): Promise<Map<string, MarketRef>> {
  const canons = [...new Set(lines.map((l) => canonicalPartNumber(l.partNumber ?? '')).filter(Boolean))];
  if (canons.length === 0) return new Map();
  const rows = await sql<{ canon: string; value: number; label: string }[]>`
    SELECT canon, value, label FROM (
      SELECT ${canonPartCol(sql, sql`rp.part_number`)} AS canon,
             COALESCE(rp.avg_sell, rp.target)::float AS value, rp.label
      FROM ref_prices rp WHERE rp.part_number IS NOT NULL AND rp.part_number <> ''
    ) x
    WHERE canon = ANY(${canons}::text[]) AND value IS NOT NULL AND value > 0
  `;
  return new Map(rows.map((r) => [r.canon, { value: r.value, label: r.label }]));
}

async function cachedLookup(sql: SqlLike, canon: string): Promise<WebSpec | null> {
  const row = (await sql<{ specs: Record<string, string>; source_urls: string[] }[]>`
    SELECT specs, source_urls FROM part_number_lookups WHERE canon_pn = ${canon}
  `)[0];
  return row ? { specs: row.specs, sourceUrls: row.source_urls } : null;
}

/** Spend so far on one review, and whether the next model call still fits. */
class Budget {
  promptTokens = 0;
  completionTokens = 0;
  costUsd = 0;
  skipped = 0;
  constructor(private readonly capUsd: number) {}
  add = (u: AiUsage) => {
    this.promptTokens += u.promptTokens;
    this.completionTokens += u.completionTokens;
    this.costUsd += u.costUsd;
  };
  canSpend(): boolean {
    if (this.costUsd < this.capUsd) return true;
    this.skipped++;
    return false;
  }
}

type ReviewOutcome = { findings: Finding[]; hash: string; lineCount: number };

async function reviewLines(
  sql: SqlLike, env: Env, orderId: string, setting: PoAiReviewSetting, budget: Budget,
): Promise<ReviewOutcome> {
  const rows = await loadLines(sql, orderId);
  const lines = rows.map(toReviewLine);
  const market = await marketRefs(sql, lines);
  const llm = pickProvider(env) === 'openrouter';
  const model = aiModel(env, { model: setting.model ?? undefined });
  const callOpts = { model, onUsage: budget.add };

  const perLine = rows.map((r, i) => async (): Promise<Finding[]> => {
    const line = lines[i]!;
    const category = r.category as LineCategory;
    const canon = canonicalPartNumber(line.partNumber ?? '');
    const scanLabel: LabelRead | null = r.scan_fields && Object.keys(r.scan_fields).length > 0
      ? { fields: r.scan_fields, read: 'scan', url: isRealPhotoUrl(r.scan_url) ? r.scan_url : null }
      : null;
    const ev: LineEvidence = { label: scanLabel, market: canon ? market.get(canon) ?? null : null };

    if (setting.webLookup && needsWebLookup(line, !!scanLabel)) {
      ev.web = await cachedLookup(sql, canon);
      if (!ev.web && llm && budget.canSpend()) {
        try {
          ev.web = await lookUpPartNumber(env, category, line.partNumber!, callOpts);
          if (ev.web) {
            await sql`
              INSERT INTO part_number_lookups (canon_pn, category, specs, source_urls, model)
              VALUES (${canon}, ${category}, ${sql.json(ev.web.specs)}, ${sql.json(ev.web.sourceUrls)}, ${model})
              ON CONFLICT (canon_pn) DO NOTHING
            `;
          }
        } catch (e) {
          reviewLog.warn('part lookup failed', { orderId, lineId: line.id, error: (e as Error).message });
        }
      }
    }

    let findings = checkLine(line, ev);
    // The photo settles a dispute, or stands in for a scan the line never had.
    const photo = [r.scan_url, r.photo_url].find(isRealPhotoUrl);
    if (llm && photo && category !== 'Other' && (!scanLabel || findings.some(isDisputed)) && budget.canSpend()) {
      try {
        const fields = await rereadLabel(env, category, photo, callOpts);
        if (fields) findings = checkLine(line, { ...ev, label: { fields, read: 'reread', url: photo } });
      } catch (e) {
        reviewLog.warn('label reread failed', { orderId, lineId: line.id, error: (e as Error).message });
      }
    }
    return findings;
  });

  const findings = (await allLimited(perLine, 4)).flat();
  return { findings, hash: linesHash(lines), lineCount: lines.length };
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const;

/** Runs a claimed review to completion: findings written, event logged, manager told. */
export async function runPoAiReview(
  sql: Sql<{}>, env: Env, review: { id: string; order_id: string },
): Promise<void> {
  const setting = await poAiReviewSetting(sql);
  const budget = new Budget(setting.maxCostPerPoUsd);
  let outcome = await reviewLines(sql, env, review.order_id, setting, budget);
  // Edited while the review read it: read once more, then write what that saw.
  if (linesHash((await loadLines(sql, review.order_id)).map(toReviewLine)) !== outcome.hash) {
    outcome = await reviewLines(sql, env, review.order_id, setting, budget);
  }
  const findings = [...outcome.findings];
  if (budget.skipped > 0) {
    findings.push({
      lineId: null, severity: 'info', code: 'budget_exhausted', field: null,
      currentValue: null, suggestedValue: null,
      message: `Cost cap of $${setting.maxCostPerPoUsd} reached; ${budget.skipped} check(s) skipped`,
      confidence: null, sources: [],
    });
  }
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const model = pickProvider(env) === 'openrouter' ? aiModel(env, { model: setting.model ?? undefined }) : 'stub';

  await sql.begin(async (tx) => {
    const cur = (await tx<{ status: string }[]>`
      SELECT status FROM po_ai_reviews WHERE id = ${review.id} FOR UPDATE`)[0];
    // Superseded while it ran: the order left review, and nobody wants these.
    if (cur?.status !== 'running') return;

    if (findings.length > 0) {
      const rows = findings.map((f) => ({
        review_id: review.id, order_id: review.order_id, line_id: f.lineId,
        severity: f.severity, code: f.code, field: f.field,
        current_value: f.currentValue, suggested_value: f.suggestedValue,
        message: f.message, confidence: f.confidence,
        sources: tx.json(f.sources as never),
      }));
      await tx`INSERT INTO po_ai_findings ${tx(rows)}`;
      // A finding a manager already dismissed stays dismissed on a re-run.
      await tx`
        UPDATE po_ai_findings f
        SET resolution = 'dismissed', resolved_by = p.resolved_by, resolved_at = p.resolved_at
        FROM po_ai_findings p
        WHERE f.review_id = ${review.id}
          AND p.order_id = ${review.order_id} AND p.review_id <> ${review.id}
          AND p.resolution = 'dismissed'
          AND p.line_id IS NOT DISTINCT FROM f.line_id
          AND p.code = f.code
          AND p.field IS NOT DISTINCT FROM f.field
          AND p.current_value IS NOT DISTINCT FROM f.current_value
          AND p.suggested_value IS NOT DISTINCT FROM f.suggested_value
      `;
    }
    await tx`
      UPDATE po_ai_reviews
      SET status = 'done', finished_at = NOW(), model = ${model}, lines_hash = ${outcome.hash},
          prompt_tokens = ${budget.promptTokens}, completion_tokens = ${budget.completionTokens},
          cost_usd = ${budget.costUsd}, error = NULL
      WHERE id = ${review.id}
    `;
    const count = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length;
    const errors = count('error');
    const warnings = count('warn');
    await writeOrderEvent(tx, review.order_id, null, 'ai_review_done', {
      reviewId: review.id, lines: outcome.lineCount, errors, warnings, infos: count('info'),
    });
    const issues = errors + warnings;
    const n = {
      kind: 'ai_review',
      tone: issues > 0 ? 'warn' as const : 'pos' as const,
      icon: 'inventory',
      title: issues > 0
        ? `AI review: ${issues} issue${issues === 1 ? '' : 's'} on ${review.order_id}`
        : `AI review: ${review.order_id} looks right`,
      body: `${outcome.lineCount} line${outcome.lineCount === 1 ? '' : 's'} checked`,
    };
    const manager = (await tx<{ id: string }[]>`
      SELECT u.id FROM orders o JOIN users u ON u.id = o.manager_id
      WHERE o.id = ${review.order_id} AND u.role = 'manager' AND u.active`)[0];
    if (manager) await notify(tx, { ...n, userId: manager.id });
    else await notifyManagers(tx, n);
  });
}

// ── The loop ──────────────────────────────────────────────────────────────

const TICK_MS = 15_000;
// A run longer than this died with its process; the row is taken again.
const STALE_AFTER = '10 minutes';
const MAX_ATTEMPTS = 3;
const MAX_PER_TICK = 5;

/** Takes the oldest waiting review, or one whose runner died. */
export async function claimPoAiReview(sql: SqlLike): Promise<{ id: string; order_id: string } | null> {
  await sql`
    UPDATE po_ai_reviews SET status = 'failed', finished_at = NOW(),
           error = 'gave up after ' || attempts || ' attempts'
    WHERE status = 'running' AND started_at < NOW() - ${STALE_AFTER}::interval
      AND attempts >= ${MAX_ATTEMPTS}
  `;
  const row = (await sql<{ id: string; order_id: string }[]>`
    UPDATE po_ai_reviews SET status = 'running', started_at = NOW(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM po_ai_reviews
      WHERE status = 'queued'
         OR (status = 'running' AND started_at < NOW() - ${STALE_AFTER}::interval)
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, order_id
  `)[0];
  return row ?? null;
}

/** Claims and runs reviews until the queue is empty or the tick's share is spent. */
export async function drainPoAiReviews(sql: Sql<{}>, env: Env, max = MAX_PER_TICK): Promise<number> {
  let ran = 0;
  for (; ran < max; ran++) {
    const review = await claimPoAiReview(sql);
    if (!review) break;
    try {
      await runPoAiReview(sql, env, review);
    } catch (e) {
      reviewLog.error('po ai review failed', { reviewId: review.id, orderId: review.order_id, error: e });
      await sql`
        UPDATE po_ai_reviews SET status = 'failed', finished_at = NOW(),
               error = ${String((e as Error).message ?? e).slice(0, 500)}
        WHERE id = ${review.id} AND status = 'running'
      `;
    }
  }
  return ran;
}

export function startPoAiReviewLoop(sql: Sql<{}>, env: Env): { stop(): void } {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await drainPoAiReviews(sql, env);
    } catch (e) {
      reviewLog.error('po ai review loop failed', e);
    } finally {
      busy = false;
    }
  };
  const handle = setInterval(() => void tick(), TICK_MS);
  handle.unref?.();
  return { stop() { stopped = true; clearInterval(handle); } };
}
