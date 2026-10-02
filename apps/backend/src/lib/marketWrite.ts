import type postgres from 'postgres';
import { marketWritesTotal } from '../metrics';
import { appendPriceEvent } from './refPriceEvents';
import { canonPartArg, canonPartCol } from './part-number';

export type WriteSelector = { id?: string; partNumber?: string };
export type WriteValue = {
  selector: WriteSelector;
  low: string;
  high: string;
  avgSell: string;
  samples: number;
  source: string;
};
export type WriteResult = {
  updated: number;
  notFound: number;
  errors: { selector: WriteSelector; error: string }[];
};

// The wire spells prices as strings; a bare number is accepted too. Number()
// alone is not a parser here: it reads null, '' and [] as 0, which would write
// a zero price for a field the scraper never sent.
function parseNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

// What the error report echoes back: only the string fields, so a malformed
// selector can't reflect arbitrary JSON into the response.
function echoSelector(raw: unknown): WriteSelector {
  if (!isRecord(raw)) return {};
  return {
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    ...(typeof raw.partNumber === 'string' ? { partNumber: raw.partNumber } : {}),
  };
}

// The body is the scraper's JSON, unchecked. An element that is not the shape
// becomes an error row like any other bad value: a null element or a missing
// `source` reaching the queries below would throw, and a throw rolls back
// every good row in the batch with it.
function shapeError(v: unknown): string | null {
  if (!isRecord(v)) return 'value must be an object';
  if (!isRecord(v.selector)) return 'selector must be an object';
  const hasId = v.selector.id !== undefined;
  const hasPart = v.selector.partNumber !== undefined;
  if (hasId === hasPart) return 'selector needs exactly one of id or partNumber';
  if (hasId ? !nonBlank(v.selector.id) : !nonBlank(v.selector.partNumber)) {
    return 'selector id/partNumber must be a non-empty string';
  }
  if (!nonBlank(v.source)) return 'source must be a non-empty string';
  return null;
}

// Validation errors push to `errors` and continue inside the transaction so a
// single bad row doesn't roll back the rest of the batch — the scraper sees
// the partial-success report and can retry just the failing rows.
export async function applyMarketWrites(
  sql: postgres.Sql,
  values: readonly unknown[],
): Promise<WriteResult> {
  return sql.begin<WriteResult>(async (tx) => {
    const out: WriteResult = { updated: 0, notFound: 0, errors: [] };
    const fail = (raw: unknown, error: string) => {
      out.errors.push({ selector: echoSelector(isRecord(raw) ? raw.selector : undefined), error });
      marketWritesTotal.inc({ outcome: 'error' });
    };
    for (const raw of values) {
      const bad = shapeError(raw);
      if (bad) {
        fail(raw, bad);
        continue;
      }
      const v = raw as WriteValue;
      const low = parseNum(v.low), high = parseNum(v.high), avg = parseNum(v.avgSell);
      if (low === null || high === null || avg === null) {
        fail(v, 'non-numeric low/high/avgSell');
        continue;
      }
      if (low < 0 || high < 0 || avg < 0) {
        fail(v, 'negative price');
        continue;
      }
      if (!(low <= avg && avg <= high)) {
        fail(v, 'low <= avgSell <= high required');
        continue;
      }
      if (!Number.isInteger(v.samples) || v.samples < 0) {
        fail(v, 'samples must be a non-negative integer');
        continue;
      }
      // Nothing makes a canonical part number unique, so when two rows share
      // one the row written is chosen rather than whichever the planner
      // reaches first: the most recently maintained, then a stable tiebreak.
      const idRow = (await tx<{ id: string; prev_avg: number | null }[]>`
        SELECT id, avg_sell AS prev_avg
        FROM ref_prices
        WHERE (${v.selector.id ?? null}::text IS NOT NULL AND id::text = ${v.selector.id ?? null})
           OR (${v.selector.partNumber ?? null}::text IS NOT NULL
               AND ${canonPartCol(tx, tx`part_number`)} = ${canonPartArg(tx, v.selector.partNumber ?? '')})
        ORDER BY updated_at DESC, id
        LIMIT 1
      `)[0];
      if (!idRow) {
        out.notFound++;
        marketWritesTotal.inc({ outcome: 'notfound' });
        continue;
      }
      const trend = idRow.prev_avg === null ? null : +(avg - idRow.prev_avg).toFixed(2);
      // Keep the legacy columns (low_price/high_price/avg_sell/samples/source/trend)
      // in sync — MCP + market.ts read them. last_price* + events are handled by
      // appendPriceEvent below.
      await tx`
        UPDATE ref_prices SET
          low_price = ${low},
          high_price = ${high},
          avg_sell = ${avg},
          samples = ${v.samples},
          source = ${v.source},
          trend = ${trend}
        WHERE id = ${idRow.id}
      `;
      await appendPriceEvent(tx, {
        refPriceId: idRow.id,
        price: avg,
        source: 'scraper:' + v.source,
        note: null,
        actorUserId: null,
      });
      out.updated++;
      marketWritesTotal.inc({ outcome: 'updated' });
    }
    return out;
  });
}
