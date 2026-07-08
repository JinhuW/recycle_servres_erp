// Auto-add new inventory parts to the market-tracking board (ref_prices) on
// PO intake. Skips lines without a part_number, dedupes within the batch by
// the canonical form (same rule the rest of the codebase uses for "is this
// the same part"), and only inserts the ones not already tracked. Price
// columns are left NULL — the scraper fills them on its next pass via
// applyMarketWrites, which matches by case-insensitive part_number.
//
// Must run inside a sql.begin tx so a failed insert rolls back the order.

import type { Sql, TransactionSql } from 'postgres';

type SqlLike = Sql | TransactionSql;

export type TrackablePart = {
  category: string;
  partNumber: string | null | undefined;
  brand?: string | null;
  capacity?: string | null;
  type?: string | null;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  interface?: string | null;
  formFactor?: string | null;
  description?: string | null;
  label?: string | null;
  subLabel?: string | null;
  health?: number | null;
  rpm?: number | null;
};

function synthLabel(p: TrackablePart, partNumber: string): string {
  const parts = [p.brand, p.capacity, p.type, p.classification, p.rank, p.speed]
    .map(s => (s ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' ') : partNumber;
}

function canonClient(pn: string): string {
  return pn
    .replace(/^\s*(?:P\s*\/?\s*N|S\s*\/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export async function autoTrackParts(
  tx: SqlLike,
  parts: TrackablePart[],
): Promise<{ inserted: number; skipped: number }> {
  // 1. Bucket each input under its canonical PN; first occurrence wins so the
  //    inserted row carries the specs from the earliest line in the batch.
  const byCanon = new Map<string, { raw: string; part: TrackablePart }>();
  let skipped = 0;
  for (const p of parts) {
    const raw = (p.partNumber ?? '').trim();
    if (!raw) { skipped++; continue; }
    const canon = canonClient(raw);
    if (!canon) { skipped++; continue; }
    if (!byCanon.has(canon)) byCanon.set(canon, { raw, part: p });
  }
  if (byCanon.size === 0) return { inserted: 0, skipped };

  // 2. Find which canonical PNs already have a ref_prices row. The SQL
  //    canonicaliser must match canonClient() above and the rule in
  //    lib/part-number.ts — strip P/N|S/N prefix, drop whitespace, upper-case.
  const canons = Array.from(byCanon.keys());
  const PREFIX_RE =
    '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*';
  const existing = await tx<{ canon: string }[]>`
    SELECT UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) AS canon
    FROM ref_prices
    WHERE UPPER(REGEXP_REPLACE(
             REGEXP_REPLACE(COALESCE(part_number, ''), ${PREFIX_RE}, '', 'i'),
             '[[:space:]]+', '', 'g'
           )) = ANY(${canons}::text[])
  `;
  const taken = new Set(existing.map(r => r.canon));

  // 3. Insert the missing rows. One INSERT per row (the batch is bounded by
  //    the order's line count — POs in this system are tens of lines, not
  //    thousands) keeps the SQL readable and lets postgres.js handle the
  //    parameter binding without a custom unnest.
  let inserted = 0;
  for (const [canon, { raw, part }] of byCanon) {
    if (taken.has(canon)) continue;
    await tx`
      INSERT INTO ref_prices (
        id, category, brand, capacity, type, classification, rank, speed,
        interface, form_factor, description, part_number,
        label, sub_label, samples, source, updated_at, health, rpm
      ) VALUES (
        gen_random_uuid()::text, ${part.category},
        ${part.brand ?? null}, ${part.capacity ?? null}, ${part.type ?? null},
        ${part.classification ?? null}, ${part.rank ?? null}, ${part.speed ?? null},
        ${part.interface ?? null}, ${part.formFactor ?? null}, ${part.description ?? null},
        ${raw}, ${(part.label ?? '').trim() || synthLabel(part, raw)}, ${(part.subLabel ?? '').trim() || null},
        0, 'auto-intake', NOW(),
        ${part.health ?? null}, ${part.rpm ?? null}
      )
    `;
    inserted++;
  }
  return { inserted, skipped };
}
