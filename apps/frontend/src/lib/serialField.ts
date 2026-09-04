import { parseSerials } from '@recycle-erp/shared';

// Edits for the chip-style serial field. The field's value stays what it has
// always been — one free-text blob, newline-joined — so `parseSerials`, the
// DDR5 / count-vs-qty validators and the API see no difference. These helpers
// only decide what that blob looks like after a chip is added or removed.
//
// Every one of them returns a string, never null: both call sites mount the
// field on `typeof line.serialNumber === 'string'`, so handing back a nullish
// value would unmount the field mid-edit.

/**
 * Add every serial in `input` (which may be a pasted list) to `raw`, skipping
 * ones already there. Duplicates are dropped rather than appended: a repeated
 * serial is always a mis-scan or a double-tap, and the count-vs-qty rule would
 * reject it later with a message that doesn't say which one is the copy.
 */
export function addSerials(raw: string | null | undefined, input: string): string {
  const have = parseSerials(raw);
  const seen = new Set(have);
  for (const sn of parseSerials(input)) {
    if (seen.has(sn)) continue;
    seen.add(sn);
    have.push(sn);
  }
  return have.join('\n');
}

/** Drop one serial whole — the "delete the label, not its characters" gesture. */
export function removeSerialAt(raw: string | null | undefined, index: number): string {
  const sns = parseSerials(raw);
  if (index < 0 || index >= sns.length) return sns.join('\n');
  sns.splice(index, 1);
  return sns.join('\n');
}

/**
 * Whether the text the field thinks is still being typed is still true of
 * `value` — answered by identity, not by looking at the value's tail.
 *
 * `lastEmitted` is the value the field itself last handed to its parent. Only
 * then does its pending text still describe the last segment. Any other value
 * arrived from outside (the scanner appending a serial), and whoever wrote it
 * already folded the pending text into the blob, so there is nothing to hold
 * back.
 *
 * A suffix test — "does the value end with the pending text?" — reads true by
 * coincidence: scan `SNX0012` while `2` sits half-typed and the tail of the
 * *scanned* code answers the question, so it gets stripped and the serial is
 * stored one character short.
 */
export function readPending(value: string, pending: string, lastEmitted: string | null): string {
  return pending && value === lastEmitted ? pending : '';
}

/**
 * The committed part of the field: `value` minus the text still being typed.
 *
 * The field mirrors uncommitted input into its value so the validators see it,
 * which means the last segment is both a chip candidate and the input's
 * contents. This is what keeps it from being rendered twice.
 */
export function stripPending(value: string, pending: string): string {
  if (!pending || !value.endsWith(pending)) return value;
  return value.slice(0, value.length - pending.length);
}
