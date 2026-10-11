// The model-backed witnesses of a PO review (services/poAiReview.ts): a fresh
// read of a line's label photo, and a web lookup of a part number no scheme
// decodes. Each returns normalised fields keyed like LineFields, or null when
// there is nothing usable — a review carries on without the witness rather
// than failing the PO over one photo.

import type { Env, LineCategory } from '../types';
import { openRouterJson, openRouterScan, type AiCallOptions } from './openrouter';
import { EXPECTED_FIELDS_BY_CATEGORY, partLookupPrompt } from './prompts';
import { normalizeFields } from './normalize';

const IMAGE_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
// A web-search turn reads pages before it answers.
const LOOKUP_TIMEOUT_MS = 40_000;
// Below this the label read is no witness at all.
const MIN_LABEL_CONFIDENCE = 0.5;

function keep(category: LineCategory, fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(normalizeFields(category, fields))
      .filter(([k]) => EXPECTED_FIELDS_BY_CATEGORY[category].includes(k)),
  );
}

async function fetchImage(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength > 0 && buf.byteLength <= IMAGE_MAX_BYTES ? buf : null;
}

/** The label photo at `url`, read again with the scan prompt for `category`. */
export async function rereadLabel(
  env: Env, category: LineCategory, url: string, opts: AiCallOptions,
): Promise<Record<string, string> | null> {
  const bytes = await fetchImage(url);
  if (!bytes) return null;
  const r = await openRouterScan(env, category, bytes, opts);
  if (r.confidence < MIN_LABEL_CONFIDENCE) return null;
  return keep(category, r.fields);
}

/** What the web says `partNumber` is, through the `:online` variant of the review's model. */
export async function lookUpPartNumber(
  env: Env, category: LineCategory, partNumber: string, opts: AiCallOptions & { model: string },
): Promise<{ specs: Record<string, string>; sourceUrls: string[] } | null> {
  const json = await openRouterJson(env, partLookupPrompt(category, partNumber), [], {
    ...opts,
    model: opts.model.endsWith(':online') ? opts.model : `${opts.model}:online`,
    timeoutMs: LOOKUP_TIMEOUT_MS,
  });
  const raw = json.specs && typeof json.specs === 'object' ? json.specs as Record<string, unknown> : {};
  const strs = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]),
  );
  // A lookup that cites nothing is the model's memory, not the web.
  const sourceUrls = Array.isArray(json.sourceUrls)
    ? json.sourceUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5)
    : [];
  const specs = category === 'Other' ? strs : keep(category, strs);
  if (sourceUrls.length === 0 || Object.keys(specs).length === 0) return null;
  return { specs, sourceUrls };
}
