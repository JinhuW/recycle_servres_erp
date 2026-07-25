# `.page` silently crops tall cards, and UNION branches need parentheses

Two traps hit while building the global Activity register (v1.35.0).

## 1. A card with `overflow: hidden` inside `.page` gets cropped, not scrolled

`.page` (desktop.css) is `display: flex; flex-direction: column`. Every direct
child is therefore a flex item with the default `flex-shrink: 1`. A card that is
taller than the viewport gets **shrunk to fit** — and if it also sets
`overflow: hidden` (as any card with rounded corners over a table does), the
overflowing rows are simply clipped. No scrollbar, no visual seam.

The Activity register rendered 50 rows into a box 604px tall — about 12px per
row — and looked like a short list that happened to end early. Nothing in the
markup or the row CSS was wrong.

```css
.ac-register {
  overflow: hidden;
  flex-shrink: 0;   /* ← without this the tail of the list disappears */
}
```

**How to spot it:** measure, don't eyeball. If
`el.getBoundingClientRect().height` divided by the row count is well under the
row's `min-height`, the element is being shrunk.

**Also:** don't put `margin-bottom` on a direct child of `.page` to separate it
from the next block. `.page` already has `gap: 18px`; the margin stacks on top
of it. Delete the margin and let the gap do the spacing.

## 2. `ORDER BY` / `LIMIT` inside a UNION branch binds to the whole union

Pre-sorting and pre-limiting each branch is the right shape for a feed that
merges several ledgers — it keeps each branch on its own index instead of
materialising every table. But this is a syntax error:

```sql
SELECT … FROM a ORDER BY created_at DESC LIMIT 51
UNION ALL
SELECT … FROM b ORDER BY created_at DESC LIMIT 51   -- syntax error at or near "UNION"
```

Postgres reads the first `ORDER BY` as belonging to the union, then chokes.
Each branch has to be parenthesised:

```sql
(SELECT … LIMIT 51) UNION ALL (SELECT … LIMIT 51)
```

With postgres.js that means wrapping at compose time —
``fragments.map(f => sql`(${f})`).reduce((a, b) => sql`${a} UNION ALL ${b}`)`` —
not just concatenating the fragments.

## 3. Check the migration head *after* fetching

`ls migrations | tail` on a stale local branch showed `0076` as the head, so the
new migration was numbered `0077` — but `origin/dev` already had
`0077_upload_allowed_mime_spreadsheets.sql` and `0078_ssd_cap_1tb.sql`. Always
`git fetch` and re-check the head before picking a number.
