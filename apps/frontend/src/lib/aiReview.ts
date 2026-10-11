import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import { fmtUSD } from './format';
import type { Translate } from './orderPresentation';

// The AI review of a PO: what the background reviewer found, and the
// manager's answer to each finding. The page applies a finding through the
// ordinary line PATCH, then records the answer.

export type AiReviewStatus = 'queued' | 'running' | 'done' | 'failed' | 'superseded';

export type AiFindingSource =
  | { kind: 'decoder'; partNumber: string; readAs?: string; value?: string }
  | { kind: 'label'; read: 'scan' | 'reread'; url: string | null; value?: string }
  | { kind: 'web'; urls: string[]; value?: string }
  | { kind: 'market'; value: number; label: string };

export type AiFinding = {
  id: string;
  lineId: string | null;
  severity: 'error' | 'warn' | 'info';
  code: string;
  field: string | null;
  currentValue: string | null;
  suggestedValue: string | null;
  message: string;
  confidence: number | null;
  sources: AiFindingSource[];
  resolution: 'applied' | 'dismissed' | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  stale: boolean;
};

export type AiReviewRun = {
  id: string; status: AiReviewStatus; trigger: 'stage' | 'manual'; model: string | null;
  costUsd: number; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
};

export type AiReviewResponse = {
  enabled: boolean;
  latest: AiReviewRun | null;
  shown: AiReviewRun | null;
  findings: AiFinding[];
};

/** Still waiting on an answer from the manager, and still true of the line. */
export function isOpen(f: AiFinding): boolean {
  return f.resolution === null && !f.stale;
}

/** Whether Apply can do anything: a field to write and a value to write there. */
export function canApply(f: AiFinding): boolean {
  return isOpen(f) && f.lineId !== null && f.field !== null && f.suggestedValue !== null;
}

/** Open error and warning findings per line — what the row chip counts. */
export function openIssuesByLine(findings: readonly AiFinding[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) {
    if (!f.lineId || !isOpen(f) || f.severity === 'info') continue;
    out.set(f.lineId, (out.get(f.lineId) ?? 0) + 1);
  }
  return out;
}

/** The line PATCH body that applies `f`. RPM is the one numeric field a finding names. */
export function applyPatch(f: AiFinding): { id: string } & Record<string, string | number> {
  const v = f.field === 'rpm' ? Number(f.suggestedValue) : f.suggestedValue!;
  return { id: f.lineId!, [f.field!]: v };
}

export function isPending(r: AiReviewResponse | null): boolean {
  return r?.latest?.status === 'queued' || r?.latest?.status === 'running';
}

/** One finding, worded for the page. */
export function findingText(f: AiFinding, t: Translate, locale: string): string {
  const market = f.sources.find((s) => s.kind === 'market');
  const current = f.code === 'above_market' ? fmtUSD(Number(f.currentValue), locale) : f.currentValue ?? '';
  return t('aiRevCode_' + f.code, {
    field: f.field ? t('aiRevField_' + f.field) : '',
    current,
    suggested: f.suggestedValue ?? '',
    market: market && market.kind === 'market' ? fmtUSD(market.value, locale) : '',
  });
}

/** Which witnesses back a finding: "via part #, label". */
export function findingSources(f: AiFinding, t: Translate): string {
  const kinds = [...new Set(f.sources.map((s) => s.kind))];
  return kinds.length ? t('aiRevVia', { sources: kinds.map((k) => t('aiRevSrc_' + k)).join(', ') }) : '';
}

const POLL_MS = 5_000;

/** The PO's AI review, re-read every few seconds while one is queued or running. */
export function useAiReview(orderId: string) {
  const [data, setData] = useState<AiReviewResponse | null>(null);
  const reload = useCallback(
    () => api.get<AiReviewResponse>(`/api/orders/${orderId}/ai-review`).then(setData),
    [orderId],
  );
  useEffect(() => { reload().catch(handleFetchError); }, [reload]);
  const pending = isPending(data);
  useEffect(() => {
    if (!pending) return;
    const h = setInterval(() => { reload().catch(() => {}); }, POLL_MS);
    return () => clearInterval(h);
  }, [pending, reload]);

  const run = useCallback(async () => {
    setData(await api.post<AiReviewResponse>(`/api/orders/${orderId}/ai-review/run`, {}));
  }, [orderId]);
  const resolve = useCallback(async (findingId: string, resolution: 'applied' | 'dismissed' | null) => {
    setData(await api.post<AiReviewResponse>(
      `/api/orders/${orderId}/ai-review/findings/${findingId}/resolve`, { resolution }));
  }, [orderId]);
  return { data, reload, run, resolve };
}
