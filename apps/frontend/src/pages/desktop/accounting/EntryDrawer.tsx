import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../../../components/Modal';
import { Icon } from '../../../components/Icon';
import { RouteLink } from '../../../components/RouteLink';
import { Yuan, eventLine, recordPath } from '../../../components/AccountingBits';
import { useT } from '../../../lib/i18n';
import { handleFetchError } from '../../../lib/errorToast';
import { fmtDate, fmtMoney } from '../../../lib/format';
import { acctEntry, acctRestore, acctVoid, fmtBookDay, type AcctEntryDetail } from '../../../lib/accounting';
import { EntryDialog, TargetLine } from './EntryDialog';

type Props = {
  id: string;
  onClose: () => void;
  // Any write: the page re-reads its band and book.
  onChanged: () => void;
  onToast?: (msg: string) => void;
};

// One entry, docked to the right of the book: every fact, the record it is
// for, its history, and what can still be done to it.
export function EntryDrawer({ id, onClose, onChanged, onToast }: Props) {
  const { t, locale } = useT();
  const [entry, setEntry] = useState<AcctEntryDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    acctEntry(id)
      .then(r => setEntry(r.entry))
      .catch(e => { if ((e as { status?: number }).status === 404) setMissing(true); else handleFetchError(e); });
  }, [id]);
  useEffect(() => { setEntry(null); setMissing(false); setVoiding(false); load(); }, [load]);

  const act = async (run: () => Promise<unknown>, toast: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      onToast?.(toast);
      setVoiding(false);
      setReason('');
      load();
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  const path = entry ? recordPath(entry) : null;
  return (
    <>
      <Modal onClose={() => { if (!busy) onClose(); }} shellClassName="acct-drawer" ariaLabel={id}>
        <div className="modal-head">
          <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono">{id}</span>
            {entry?.voided && <span className="chip muted" style={{ fontSize: 10.5 }}>{t('acctVoidedChip')}</span>}
          </div>
          <button type="button" className="btn icon" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">
          {missing && <div className="acct-empty" style={{ padding: 0 }}>{t('acctNotFound')}</div>}
          {entry && (
            <>
              {entry.voided && (
                <div className="acct-banner">{t('acctVoidedBy', { name: entry.voided.by ?? '—', reason: entry.voided.reason })}</div>
              )}
              <div className="acct-hero">
                <div className="acct-hero-dir">{t('acctDir_' + entry.direction)} · {t('acctKind_' + entry.kind)}</div>
                <Yuan value={entry.amountCny} locale={locale} className={entry.direction === 'in' ? 'acct-in' : undefined} />
                {entry.currency === 'USD' && entry.fxRate !== null && (
                  <div className="acct-sub">{t('acctUsdOriginal', { usd: fmtMoney(entry.amount, 'USD', locale), rate: entry.fxRate.toFixed(4) })}</div>
                )}
              </div>
              <dl className="acct-facts">
                <dt>{t('acctFieldDate')}</dt>
                <dd>{fmtBookDay(entry.occurredOn, locale, true)}</dd>
                {entry.kind !== 'other' && (
                  <>
                    <dt>{t('acctFieldRecord')}</dt>
                    <dd>
                      {entry.target && entry.targetFacts ? (
                        <>
                          <TargetLine kind={entry.kind} target={entry.targetFacts} />
                          {path && (
                            <div style={{ marginTop: 4 }}>
                              <RouteLink to={path} className="rec-link">{t('acctOpenRecord', { id: entry.target.id })}</RouteLink>
                            </div>
                          )}
                        </>
                      ) : <span style={{ color: 'var(--fg-subtle)' }}>{t('acctRecordDeleted')}</span>}
                    </dd>
                  </>
                )}
                <dt>{t('acctFieldManager')}</dt>
                <dd>{entry.manager.name}</dd>
                <dt>{t('acctFieldMethod')}</dt>
                <dd>{t('acctMethod_' + entry.method)}</dd>
                {entry.counterparty && (<><dt>{t('acctFieldCounterparty')}</dt><dd>{entry.counterparty}</dd></>)}
                {entry.reference && (<><dt>{t('acctFieldReference')}</dt><dd className="mono">{entry.reference}</dd></>)}
                {entry.note && (<><dt>{t('acctFieldNote')}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</dd></>)}
              </dl>

              <div className="so-section-head" style={{ marginTop: 22 }}><Icon name="clock" size={14} /> {t('acctHistory')}</div>
              <div className="acct-history">
                {entry.events.map(e => (
                  <div key={e.id}>
                    <span style={{ fontWeight: 600 }}>{e.actor?.name ?? '—'}</span> {eventLine(e, t)}
                    <span className="acct-history-when">{fmtDate(e.at, locale)}</span>
                  </div>
                ))}
              </div>

              {voiding && (
                <div className="acct-void-box">
                  <label className="label" htmlFor="acct-void-reason">{t('acctVoidReason')}</label>
                  <textarea id="acct-void-reason" className="input" rows={2} value={reason} autoFocus
                            onChange={e => setReason(e.target.value)} maxLength={2000}
                            style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' }} />
                </div>
              )}
            </>
          )}
        </div>
        {entry && (
          <div className="modal-foot">
            {entry.voided ? (
              <button type="button" className="btn" disabled={busy}
                      onClick={() => act(() => acctRestore(entry.id), t('acctRestoredToast', { id: entry.id }))}>
                <Icon name="rotate" size={13} /> {t('acctRestore')}
              </button>
            ) : voiding ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => { setVoiding(false); setReason(''); }}>
                  {t('cancel')}
                </button>
                <button type="button" className="btn" style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
                        disabled={busy || !reason.trim()}
                        onClick={() => act(() => acctVoid(entry.id, reason.trim()), t('acctVoidedToast', { id: entry.id }))}>
                  {t('acctVoidConfirm')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" style={{ color: 'var(--neg)' }} onClick={() => setVoiding(true)}>
                  {t('acctVoid')}
                </button>
                <button type="button" className="btn accent" onClick={() => setEditing(true)}>
                  <Icon name="edit" size={13} /> {t('acctEdit')}
                </button>
              </>
            )}
          </div>
        )}
      </Modal>
      {/* A sibling, not a child: the edit layers above the drawer. */}
      {editing && entry && (
        <EntryDialog
          entry={entry}
          zIndex={110}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onToast?.(t('acctSavedToast', { id: entry.id }));
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}
