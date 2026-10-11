import { useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  canApply, findingSources, findingText, isOpen, isPending, openIssuesByLine,
  type AiFinding, type AiReviewResponse,
} from '../../lib/aiReview';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';

// Review mode's AI card: the run's state, what it found on the selected
// product, and which other products it found something on. Apply and
// Dismiss answer one finding; nothing here edits a line by itself.

type Props = {
  data: AiReviewResponse | null;
  selectedId: string | null;
  lineNo: (lineId: string) => number | null;
  onSelect: (lineId: string) => void;
  onRun: () => Promise<void>;
  onApply: (f: AiFinding) => Promise<void>;
  onResolve: (findingId: string, resolution: 'dismissed' | null) => Promise<void>;
  // A line a shipped sell order holds can't be edited here.
  isHeld: (lineId: string) => boolean;
  ready: boolean;
};

const TONE = { error: 'neg', warn: 'warn', info: 'muted' } as const;

export function AiReviewCard({ data, selectedId, lineNo, onSelect, onRun, onApply, onResolve, isHeld, ready }: Props) {
  const { t, locale } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const act = (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    fn().catch(handleFetchError).finally(() => setBusy(null));
  };

  const pending = isPending(data);
  const findings = data?.findings ?? [];
  const forLine = findings.filter((f) => f.lineId !== null && f.lineId === selectedId);
  const poWide = findings.filter((f) => f.lineId === null);
  const others = [...openIssuesByLine(findings).keys()].filter((id) => id !== selectedId);
  const openCount = findings.filter((f) => isOpen(f) && f.severity !== 'info').length;
  const latest = data?.latest ?? null;

  const status = !data ? t('loadingApp')
    : latest?.status === 'queued' ? t('aiRevQueued')
    : latest?.status === 'running' ? t('aiRevRunning')
    : latest?.status === 'failed' ? t('aiRevFailed', { e: latest.error ?? '' })
    : data.shown ? t('aiRevDone', { when: relTime(data.shown.finishedAt ?? data.shown.createdAt, locale), n: openCount })
    : data.enabled ? t('aiRevNone') : t('aiRevOff');

  const item = (f: AiFinding) => {
    const held = f.lineId !== null && isHeld(f.lineId);
    return (
      <li key={f.id} className={'bc-ai-item' + (isOpen(f) ? '' : ' done')}>
        <span className={'chip dot ' + TONE[f.severity]} aria-hidden="true" />
        <div className="bc-ai-text">
          <div className={f.field === 'partNumber' ? 'mono' : undefined}>{findingText(f, t, locale)}</div>
          <div className="card-sub">
            {findingSources(f, t)}
            {f.resolution === 'applied' && <> · {t('aiRevApplied')}</>}
            {f.resolution === 'dismissed' && <> · {t('aiRevDismissed', { name: f.resolvedBy ?? '' })}</>}
            {f.resolution === null && f.stale && <> · {t('aiRevStale')}</>}
            {isOpen(f) && held && <> · {t('aiRevHeld')}</>}
          </div>
        </div>
        <div className="bc-ai-actions">
          {canApply(f) && !held && (
            <button type="button" className="btn sm" disabled={!ready || busy !== null}
              onClick={() => act('apply:' + f.id, () => onApply(f))}>
              {busy === 'apply:' + f.id ? '…' : t('aiRevApply')}
            </button>
          )}
          {isOpen(f) && (
            <button type="button" className="btn ghost sm" disabled={!ready || busy !== null}
              onClick={() => act('dismiss:' + f.id, () => onResolve(f.id, 'dismissed'))}>
              {t('aiRevDismiss')}
            </button>
          )}
          {f.resolution === 'dismissed' && (
            <button type="button" className="bc-link" disabled={!ready || busy !== null}
              onClick={() => act('undo:' + f.id, () => onResolve(f.id, null))}>
              {t('aiRevUndo')}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="card bc-ai">
      <div className="card-head">
        <span className="card-title"><Icon name="sparkles" size={13} /> {t('aiRevTitle')}</span>
        <button type="button" className="btn ghost sm" disabled={!ready || pending || busy !== null}
          onClick={() => act('run', onRun)}>
          <Icon name="refresh" size={12} /> {data?.latest ? t('aiRevRerun') : t('aiRevRun')}
        </button>
      </div>
      <div className="card-body bc-ai-body">
        <p className={'card-sub' + (latest?.status === 'failed' ? ' neg' : '')} aria-live="polite">{status}</p>
        {data?.shown && (
          <>
            {selectedId && (forLine.length > 0
              ? <ul className="bc-ai-list">{forLine.map(item)}</ul>
              : <p className="card-sub">{t('aiRevLineClear')}</p>)}
            {others.length > 0 && (
              <div className="bc-ai-others">
                <span className="card-sub">{t('aiRevOtherLines')}</span>
                {others.map((id) => (
                  <button key={id} type="button" className="chip warn bc-ai-jump" onClick={() => onSelect(id)}>
                    #{lineNo(id) ?? '?'}
                  </button>
                ))}
              </div>
            )}
            {poWide.length > 0 && (
              <>
                <div className="card-sub">{t('aiRevPoWide')}</div>
                <ul className="bc-ai-list">{poWide.map(item)}</ul>
              </>
            )}
            {findings.length === 0 && <p className="card-sub">{t('aiRevAllClear')}</p>}
          </>
        )}
      </div>
    </div>
  );
}
