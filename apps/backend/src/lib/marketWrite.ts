import type postgres from 'postgres';
import { marketWritesTotal } from '../metrics';

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

function parseNum(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Validation errors push to `errors` and continue inside the transaction so a
// single bad row doesn't roll back the rest of the batch — the scraper sees
// the partial-success report and can retry just the failing rows.
export async function applyMarketWrites(
  sql: postgres.Sql,
  values: WriteValue[],
): Promise<WriteResult> {
  return sql.begin<WriteResult>(async (tx) => {
    const out: WriteResult = { updated: 0, notFound: 0, errors: [] };
    for (const v of values) {
      const low = parseNum(v.low), high = parseNum(v.high), avg = parseNum(v.avgSell);
      if (low === null || high === null || avg === null) {
        out.errors.push({ selector: v.selector, error: 'non-numeric low/high/avgSell' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (low < 0 || high < 0 || avg < 0) {
        out.errors.push({ selector: v.selector, error: 'negative price' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (!(low <= avg && avg <= high)) {
        out.errors.push({ selector: v.selector, error: 'low <= avgSell <= high required' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      if (!Number.isInteger(v.samples) || v.samples < 0) {
        out.errors.push({ selector: v.selector, error: 'samples must be a non-negative integer' });
        marketWritesTotal.inc({ outcome: 'error' });
        continue;
      }
      const idRow = (await tx<{ id: string; prev_avg: number | null; history: unknown }[]>`
        SELECT id, avg_sell AS prev_avg, history
        FROM ref_prices
        WHERE (${v.selector.id ?? null}::text IS NOT NULL AND id::text = ${v.selector.id ?? null})
           OR (${v.selector.partNumber ?? null}::text IS NOT NULL
               AND LOWER(COALESCE(part_number,'')) = LOWER(${v.selector.partNumber ?? ''}))
        LIMIT 1
      `)[0];
      if (!idRow) {
        out.notFound++;
        marketWritesTotal.inc({ outcome: 'notfound' });
        continue;
      }
      const trend = idRow.prev_avg === null ? null : +(avg - idRow.prev_avg).toFixed(2);
      const newPoint = { ts: new Date().toISOString(), avg };
      await tx`
        UPDATE ref_prices SET
          low_price = ${low},
          high_price = ${high},
          avg_sell = ${avg},
          samples = ${v.samples},
          source = ${v.source},
          trend = ${trend},
          history = COALESCE(history, '[]'::jsonb) || ${JSON.stringify([newPoint])}::jsonb,
          updated_at = NOW()
        WHERE id = ${idRow.id}
      `;
      out.updated++;
      marketWritesTotal.inc({ outcome: 'updated' });
    }
    return out;
  });
}
