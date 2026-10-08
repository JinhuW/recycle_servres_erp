import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { SellOrderSignoff } from '../../lib/types';

type Props = {
  orderId: string;
  signoff: SellOrderSignoff;
  // Draft, Shipped or Awaiting payment — the statuses a sign-off can change in.
  open: boolean;
  // On the edit page signing waits for the save: a sign-off approves the order
  // as saved, not the draft on screen.
  editing: boolean;
  // Unsaved edits that will void the sign-offs once saved.
  voidsOnSave: boolean;
  onChanged: () => void;
};

// Every active manager signs a sell order before it can be marked Done.
export function SellOrderSignoffCard({ orderId, signoff, open, editing, voidsOnSave, onChanged }: Props) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const required = signoff.managers.filter(m => m.required);
  const signedCount = required.filter(m => m.signedAt !== null && !m.stale).length;

  const act = async (sign: boolean) => {
    setBusy(true);
    try {
      if (sign) await api.post(`/api/sell-orders/${orderId}/signoff`, { fingerprint: signoff.fingerprint });
      else await api.delete(`/api/sell-orders/${orderId}/signoff`);
      onChanged();
    } catch (e) {
      handleFetchError(e);
      // Most likely the order changed under the reviewer: show them what it is now.
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card so-page-card">
      <div className="so-section-head">
        <Icon name="check" size={14} /> {t('soSignoffSection')}
        <span className={'chip so-signoff-count ' + (signoff.complete ? 'pos' : 'warn')}>
          {t('soSignoffCount', { n: signedCount, total: required.length })}
        </span>
      </div>
      <ul className="so-signoff-list">
        {signoff.managers.map(m => {
          const state = m.signedAt === null ? 'waiting' : m.stale ? 'stale' : 'signed';
          const mine = m.id === user?.id;
          return (
            <li key={m.id} className={'so-signoff-row ' + state}>
              <span className="so-signoff-mark">
                {state === 'signed' && <Icon name="check" size={11} />}
              </span>
              <span className="so-signoff-who">
                <span className="so-signoff-name">
                  {m.name}
                  {mine && <span className="so-signoff-you"> · {t('soSignoffYou')}</span>}
                </span>
                <span className="so-signoff-state" title={m.signedAt ? fmtDate(m.signedAt, locale) : undefined}>
                  {state === 'signed'
                    ? t('soSignoffSigned', { when: relTime(m.signedAt!, locale) })
                    : state === 'stale' ? t('soSignoffStale') : t('soSignoffWaiting')}
                </span>
              </span>
              {mine && open && !editing && (
                <span className="so-signoff-actions">
                  {state !== 'signed' && (
                    <button type="button" className="btn sm accent" disabled={busy} onClick={() => void act(true)}>
                      {state === 'stale' ? t('soSignoffSignAgain') : t('soSignoffSign')}
                    </button>
                  )}
                  {state === 'signed' && (
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void act(false)}>
                      {t('soSignoffWithdraw')}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {open && (
        <div className={'so-signoff-foot' + (voidsOnSave ? ' warn' : '')}>
          {voidsOnSave
            ? t('soSignoffVoidOnSave')
            : signoff.complete ? t('soSignoffReady') : t('soSignoffPending')}
        </div>
      )}
    </div>
  );
}
