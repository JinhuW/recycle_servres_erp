import { useState } from 'react';
import { ACCOUNTING_KINDS, ACCOUNTING_METHODS, KIND_TARGET, type AccountingKind, type AccountingMethod } from '@recycle-erp/shared';
import { PhSheet } from './PhSheet';
import { FIGURE_KEY, Yuan, recordActionKey, targetStatusLabel } from './AccountingBits';
import { useT } from '../lib/i18n';
import { fmtMoney } from '../lib/format';
import { BUSINESS_PAYER, type AcctEntryDetail, type AcctTarget } from '../lib/accounting';
import type { EntryPreset, FormTarget } from '../lib/accountingForm';
import { useAccountingEntryForm, type SavedEntry } from '../lib/useAccountingEntryForm';
import '../styles/accounting.css';

const PICK_LABEL = { po: 'acctFieldPo', so: 'acctFieldSo', as: 'acctFieldAs' } as const;

function PhTarget({ kind, target }: { kind: Exclude<AccountingKind, 'other'>; target: FormTarget }) {
  const { t, locale } = useT();
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div>
        <span className="mono" style={{ fontWeight: 600 }}>{target.id}</span>
        {target.party ? ' · ' + target.party : ''}
        {target.payerBusiness ? ' · ' + t('acctPickBusiness') : target.payerName ? ' · ' + t('acctPickPaidBy', { name: target.payerName }) : ''}
      </div>
      <div className="acct-sub" style={{ whiteSpace: 'normal' }}>
        {[
          target.status ? targetStatusLabel(KIND_TARGET[kind]!, target.status, t) : null,
          target.amount != null && target.currency ? `${t(FIGURE_KEY[kind])} ${fmtMoney(target.amount, target.currency, locale)}` : null,
        ].filter(Boolean).join(' · ')}
        {target.recordedCny ? <> · {t('acctPickRecorded')} <Yuan value={target.recordedCny} locale={locale} /></> : null}
      </div>
    </div>
  );
}

// The phone's record form: the desktop dialog's fields, one column, in a
// sheet. Mounted by the screen that owns it — a sheet sits inside the phone
// frame, so one opened from inside a fold would be clipped.
export function PhAccountingSheet({ preset, entry, onClose, onSaved }: {
  preset?: EntryPreset;
  entry?: AcctEntryDetail;
  onClose: () => void;
  onSaved: (r: SavedEntry) => void;
}) {
  const { t } = useT();
  const f = useAccountingEntryForm({ preset, entry, onSaved });
  const { form } = f;
  const action = t(recordActionKey(form.kind, form.direction));
  const kind = form.kind as Exclude<AccountingKind, 'other'>;
  const id = (k: string) => 'ph-acct-' + k;
  return (
    <PhSheet onBackdrop={() => { if (!f.busy) onClose(); }} className="ph-ho-sheet" aria-labelledby={id('title')}>
      <div className="ph-ho-head">
        <div id={id('title')} className="ph-ho-title">
          {entry ? t('acctEditTitle', { id: entry.id }) : form.targetLocked ? action : t('acctRecord')}
        </div>
        <button type="button" className="ph-ho-close" onClick={onClose} disabled={f.busy}>{t('cancel')}</button>
      </div>
      <form className="acct-form" onSubmit={e => { e.preventDefault(); void f.submit(); }}>
        <div className="seg" role="group" aria-label={t('acctFieldDirection')} style={{ width: '100%' }}>
          {(['out', 'in'] as const).map(d => (
            <button key={d} type="button" style={{ flex: 1 }} className={form.direction === d ? 'active' : ''}
                    aria-pressed={form.direction === d} onClick={() => f.setDirection(d)}>
              {t('acctDir_' + d)}
            </button>
          ))}
        </div>

        {!form.targetLocked && (
          <div className="ph-chip-scroller" role="group" aria-label={t('acctFieldKind')} style={{ margin: '0 -16px' }}>
            {ACCOUNTING_KINDS.map(k => (
              <button key={k} type="button" className={'ph-chip-btn ' + (form.kind === k ? 'active' : '')}
                      aria-pressed={form.kind === k} onClick={() => f.setKind(k)}>
                {t('acctKind_' + k)}
              </button>
            ))}
          </div>
        )}

        {f.targetType && (form.target ? (
          <div className="acct-picked">
            <PhTarget kind={kind} target={form.target} />
            {!form.targetLocked && (
              <button type="button" className="ph-ho-close" onClick={() => f.choose(null)}>{t('acctPickChange')}</button>
            )}
          </div>
        ) : (
          <div className="ph-field">
            <label htmlFor={id('pick')}>{t(PICK_LABEL[f.targetType])}</label>
            <input id={id('pick')} className="input" value={f.query} placeholder={t('acctPickPh')}
                   onChange={e => f.setQuery(e.target.value)} autoComplete="off" />
            {f.candidates && (
              <div className="acct-pick-list">
                {f.candidates.length === 0
                  ? <div className="acct-empty" style={{ padding: '10px 12px' }}>{t('acctPickNone')}</div>
                  : f.candidates.map((c: AcctTarget) => (
                    <button key={c.id} type="button" className="acct-pick-row" style={{ display: 'flex' }} onClick={() => f.choose(c)}>
                      <PhTarget kind={kind} target={c} />
                    </button>
                  ))}
              </div>
            )}
          </div>
        ))}
        {f.orphan && <div className="acct-banner">{t('acctOrphanNote')}</div>}

        <div className="ph-field">
          <label htmlFor={id('amount')}>{t('acctFieldAmount')}</label>
          <div className="acct-amount-row">
            <input id={id('amount')} className="input mono" type="number" inputMode="decimal" min="0" step="0.01"
                   value={form.amount} onChange={e => f.set({ amount: e.target.value })} />
            <div className="seg" role="group" aria-label={t('acctFieldCurrency')}>
              {(['CNY', 'USD'] as const).map(c => (
                <button key={c} type="button" className={form.currency === c ? 'active' : ''} aria-pressed={form.currency === c}
                        onClick={() => f.set({ currency: c })}>
                  {c === 'CNY' ? '¥' : '$'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {form.currency === 'USD' && (
          <div className="ph-field">
            <label htmlFor={id('rate')}>{t('acctFieldRate')}</label>
            <input id={id('rate')} className="input mono" type="number" inputMode="decimal" min="0" step="0.0001"
                   value={form.fxRate} onChange={e => f.set({ fxRate: e.target.value })}
                   placeholder={f.rate ? t('acctRatePh', { rate: f.rate.toFixed(4) }) : ''} />
            {f.preview != null && <PhPreview value={f.preview} />}
          </div>
        )}

        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={id('date')}>{t('acctFieldDate')}</label>
            <input id={id('date')} className="input" type="date" value={form.occurredOn}
                   onChange={e => f.set({ occurredOn: e.target.value })} />
          </div>
          <div className="ph-field">
            <label htmlFor={id('method')}>{t('acctFieldMethod')}</label>
            <select id={id('method')} className="select" value={form.method}
                    onChange={e => f.set({ method: e.target.value as AccountingMethod })}>
              {ACCOUNTING_METHODS.map(m => <option key={m} value={m}>{t('acctMethod_' + m)}</option>)}
            </select>
          </div>
        </div>
        <div className="ph-field">
          <label htmlFor={id('manager')}>{t('acctFieldPaidBy')}</label>
          <select id={id('manager')} className="select" value={form.managerId} disabled={!!f.payerLocked}
                  onChange={e => f.set({ managerId: e.target.value })}>
            {f.businessOffered && <option value={BUSINESS_PAYER}>{t('payBusiness')}</option>}
            {f.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {f.payerLocked && (
            <div className="acct-sub" style={{ whiteSpace: 'normal' }}>
              {t(f.payerLocked === 'linked' ? 'acctPaidByLockedLinked' : 'acctPaidByLockedCompany')}
            </div>
          )}
        </div>
        <div className="ph-field">
          <label htmlFor={id('party')}>{t('acctFieldCounterparty')}</label>
          <input id={id('party')} className="input" value={form.counterparty} maxLength={200}
                 placeholder={t('acctCounterpartyPh')} onChange={e => f.setCounterparty(e.target.value)} />
        </div>
        <div className="ph-field">
          <label htmlFor={id('ref')}>{t('acctFieldReference')}</label>
          <input id={id('ref')} className="input" value={form.reference} maxLength={200}
                 placeholder={t('acctReferencePh')} onChange={e => f.set({ reference: e.target.value })} />
        </div>
        <div className="ph-field">
          <label htmlFor={id('note')}>{t('acctFieldNote')}</label>
          <textarea id={id('note')} className="input" rows={2} value={form.note} maxLength={2000}
                    onChange={e => f.set({ note: e.target.value })} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        {f.error && <div className="acct-error" role="alert">{t(f.error)}</div>}
        <button type="submit" className="ph-btn dark" style={{ width: '100%', height: 46 }} disabled={f.busy}>
          {f.busy ? '…' : entry ? t('acctSaveEdit') : action}
        </button>
      </form>
    </PhSheet>
  );
}

function PhPreview({ value }: { value: number }) {
  const { t, locale } = useT();
  const [before, after] = t('acctPreview').split('{amount}');
  return <div className="acct-hint">{before}<Yuan value={value} locale={locale} />{after}</div>;
}

/** Asks why before an entry leaves the book. */
export function PhVoidSheet({ busy, onClose, onConfirm }: {
  busy: boolean; onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  return (
    <PhSheet onBackdrop={() => { if (!busy) onClose(); }} className="ph-ho-sheet" aria-labelledby="ph-acct-void-title">
      <div className="ph-ho-head">
        <div id="ph-acct-void-title" className="ph-ho-title">{t('acctVoidConfirm')}</div>
        <button type="button" className="ph-ho-close" onClick={onClose} disabled={busy}>{t('cancel')}</button>
      </div>
      <div className="ph-field">
        <label htmlFor="ph-acct-void-reason">{t('acctVoidReason')}</label>
        <textarea id="ph-acct-void-reason" className="input" rows={3} value={reason} maxLength={2000}
                  onChange={e => setReason(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
      </div>
      <button type="button" className="ph-btn dark" style={{ width: '100%', height: 46, marginTop: 14 }}
              disabled={busy || !reason.trim()} onClick={() => onConfirm(reason.trim())}>
        {busy ? '…' : t('acctVoidConfirm')}
      </button>
    </PhSheet>
  );
}
