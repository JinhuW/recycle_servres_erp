// AI review: what the background reviewer (services/poAiReview.ts) found on
// a PO, and the manager's answer to each finding. Manager-only, like the box
// check it sits beside.
//
// Applying a finding is the client's ordinary line PATCH, so every rule a
// line edit obeys — the audit event, the derived category and goods total,
// the serial checks — holds for it too. The `resolve` call afterwards only
// records the answer, and refuses `applied` unless the line now holds the
// suggested value.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { UUID_RE } from '../../lib/pagination';
import type { SqlLike } from '../../services/orderAudit';
import { poAiReviewSetting, queuePoAiReviewTx } from '../../services/poAiReview';
import { findingIsCurrent } from '../../services/poReviewChecks';
import { type OrdersEnv } from './shared';

const aiReviewRoutes = new Hono<OrdersEnv>();

type ReviewRow = {
  id: string; status: string; trigger: string; model: string | null; cost_usd: number;
  error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};
type FindingRow = {
  id: string; review_id: string; line_id: string | null; severity: string; code: string;
  field: string | null; current_value: string | null; suggested_value: string | null;
  message: string; confidence: number | null; sources: unknown;
  resolution: string | null; resolved_at: Date | null; resolved_by_name: string | null;
};

// Line columns a finding can name, under the LineFields keys findings use.
async function currentLines(sql: SqlLike, id: string): Promise<Map<string, Record<string, unknown>>> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT id, brand, capacity, generation, type, classification, rank, speed, interface,
           form_factor AS "formFactor", rpm, part_number AS "partNumber", unit_cost::float AS "unitCost"
    FROM order_lines WHERE order_id = ${id}`;
  return new Map(rows.map((r) => [r.id as string, r]));
}

async function readAiReview(sql: SqlLike, id: string) {
  // The newest run, and the newest finished one: a re-run in flight — or any
  // number of failed or superseded ones — leaves the last finished review's
  // findings on screen.
  const reviews = await sql<ReviewRow[]>`
    (SELECT id, status, trigger, model, cost_usd::float AS cost_usd, error,
            created_at, started_at, finished_at
       FROM po_ai_reviews WHERE order_id = ${id}
      ORDER BY created_at DESC LIMIT 1)
    UNION
    (SELECT id, status, trigger, model, cost_usd::float AS cost_usd, error,
            created_at, started_at, finished_at
       FROM po_ai_reviews WHERE order_id = ${id} AND status = 'done'
      ORDER BY created_at DESC LIMIT 1)
    ORDER BY created_at DESC`;
  const latest = reviews[0] ?? null;
  const shown = reviews.find((r) => r.status === 'done') ?? null;
  const findings = shown ? await sql<FindingRow[]>`
    SELECT f.id, f.review_id, f.line_id, f.severity, f.code, f.field, f.current_value,
           f.suggested_value, f.message, f.confidence, f.sources, f.resolution, f.resolved_at,
           u.name AS resolved_by_name
    FROM po_ai_findings f LEFT JOIN users u ON u.id = f.resolved_by
    WHERE f.review_id = ${shown.id}
    ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, f.created_at, f.id` : [];
  const lines = findings.length > 0 ? await currentLines(sql, id) : new Map();
  const review = (r: ReviewRow | null) => r && {
    id: r.id, status: r.status, trigger: r.trigger, model: r.model, costUsd: r.cost_usd,
    error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  };
  return {
    enabled: (await poAiReviewSetting(sql)).enabled,
    latest: review(latest),
    shown: review(shown),
    findings: findings.map((f) => ({
      id: f.id, lineId: f.line_id, severity: f.severity, code: f.code, field: f.field,
      currentValue: f.current_value, suggestedValue: f.suggested_value, message: f.message,
      confidence: f.confidence, sources: f.sources, resolution: f.resolution,
      resolvedAt: f.resolved_at, resolvedBy: f.resolved_by_name,
      // The line moved since the review read it: applying would overwrite that edit.
      stale: f.line_id !== null && !findingIsCurrent(
        { field: f.field, code: f.code, currentValue: f.current_value }, lines.get(f.line_id)),
    })),
  };
}

type OrderRow = { id: string; archived_at: Date | null };
async function reviewOrder(sql: SqlLike, id: string): Promise<OrderRow | undefined> {
  return (await sql<OrderRow[]>`SELECT id, archived_at FROM orders WHERE id = ${id} LIMIT 1`)[0];
}

aiReviewRoutes.get('/:id/ai-review', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!await reviewOrder(sql, id)) return c.json({ error: 'Not found' }, 404);
  return c.json(await readAiReview(sql, id));
});

// A re-run runs whether or not the automatic review is switched on: asking
// for one is the manager's own decision to spend.
aiReviewRoutes.post('/:id/ai-review/run', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const order = await reviewOrder(sql, id);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);
  const queued = await queuePoAiReviewTx(sql, id, 'manual', u.id);
  return c.json({ queued, ...await readAiReview(sql, id) }, queued ? 202 : 200);
});

aiReviewRoutes.post('/:id/ai-review/findings/:findingId/resolve', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const findingId = c.req.param('findingId');
  if (!UUID_RE.test(findingId)) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { resolution?: unknown } | null;
  const resolution = body?.resolution;
  if (resolution !== 'applied' && resolution !== 'dismissed' && resolution !== null) {
    return c.json({ error: 'resolution must be applied, dismissed or null' }, 400);
  }
  const f = (await sql<{ line_id: string | null; field: string | null; suggested_value: string | null; resolution: string | null }[]>`
    SELECT line_id, field, suggested_value, resolution FROM po_ai_findings
    WHERE id = ${findingId} AND order_id = ${id}`)[0];
  if (!f) return c.json({ error: 'Not found' }, 404);
  if (resolution === 'applied') {
    if (!f.line_id || !f.field || f.suggested_value === null) {
      return c.json({ error: 'This finding has nothing to apply' }, 400);
    }
    const lines = await currentLines(sql, id);
    if (!findingIsCurrent({ field: f.field, currentValue: f.suggested_value }, lines.get(f.line_id))) {
      return c.json({ error: 'The line does not hold the suggested value' }, 409);
    }
  }
  await sql`
    UPDATE po_ai_findings
    SET resolution = ${resolution as string | null},
        resolved_by = ${resolution ? u.id : null},
        resolved_at = ${resolution ? sql`NOW()` : null}
    WHERE id = ${findingId}`;
  return c.json(await readAiReview(sql, id));
});

export default aiReviewRoutes;
