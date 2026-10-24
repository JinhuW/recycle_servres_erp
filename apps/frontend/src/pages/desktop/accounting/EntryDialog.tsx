import { ACCOUNTING_KINDS, ACCOUNTING_METHODS, KIND_TARGET, type AccountingKind, type AccountingMethod } from '@recycle-erp/shared';
import { Modal } from '../../../components/Modal';
import { Icon } from '../../../components/Icon';
import { FIGURE_KEY, Yuan, recordActionKey, targetStatusLabel } from '../../../components/AccountingBits';
import { AcctPendingAttachments } from '../../../components/AcctAttachments';
import { useT } from '../../../lib/i18n';
import { fmtMoney } from '../../../lib/format';
import type { AcctEntryDetail, AcctTarget } from '../../../lib/accounting';
import type { EntryPreset, FormTarget } from '../../../lib/accountingForm';
import { useAccountingEntryForm, type AccountingEntryForm, type SavedEntry } from '../../../lib/useAccountingEntryForm';

const PICK_LABEL = { po: 'acctFieldPo', so: 'acctFieldSo', as: 'acctFieldAs' } as const;

// Record or edit one entry. Opened from the Accounting page, from an entry's
// drawer (Edit, layered above it), or from a record's card with that record
// fixed.
export function EntryDialog({ preset, entry, onClose, onSaved, zIndex }: {
  preset?: EntryPreset;
  entry?: AcctEntryDetail;
  onClose: () => void;
  onSaved: (r: SavedEntry) => void;
  zIndex?: number;
}) {
  const { t } = useT();
  const f = useAccountingEntryForm({ preset, entry, onSaved });
  const action = t(recordActionKey(f.form.kind, f.form.direction));
  const title = entry ? t('acctEditTitle', { id: entry.id }) : f.form.targetLocked ? action : t('acctRecord');
  return (
    <Modal onClose={() => { if (!f.busy) onClose(); }} shellStyle={{ maxWidth: 560 }} zIndex={zIndex}>
      <div className="modal-head">
        <div className="modal-title">{title}</div>
        <button type="button" className="btn icon" onClick={onClose} disabled={f.busy} aria-label={t('close')}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <form
        id="acct-entry-form"
        className="modal-body"
        onSubmit={e => { e.preventDefault(); void f.submit(); }}
        // A screenshot is usually on the clipboard already. A paste with no
        // image in it is left to the field it lands in.
        onPaste={e => {
          if (f.editing || f.busy) return;
          const images = [...e.clipboardData.files].filter(x => x.type.startsWith('image/'));
          if (images.length) { e.preventDefault(); f.addFiles(images); }
        }}
      >
        {entry?.review?.state === 'reviewed' && (
          <div className="acct-banner">{t('acctEditClearsReview', { name: entry.review.by?.name ?? '—' })}</div>
        )}
        <EntryFields f={f} />
      </form>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose} disabled={f.busy}>{t('cancel')}</button>
        <button type="submit" form="acct-entry-form" className="btn accent" disabled={f.busy || f.payerLocked}>
          {f.busy ? '…' : entry ? t('acctSaveEdit') : action}
        </button>
      </div>
    </Modal>
  );
}

export function TargetLine({ kind, target }: { kind: Exclude<AccountingKind, 'other'>; target: FormTarget }) {
  const { t, locale } = useT();
  return (
    <span style={{ minWidth: 0 }}>
      <span className="mono" style={{ fontWeight: 600 }}>{target.id}</span>
      {target.party && <span style={{ marginLeft: 8 }}>{target.party}</span>}
      <span className="acct-sub">
        {[
          target.status ? targetStatusLabel(KIND_TARGET[kind]!, target.status, t) : null,
          target.amount != null && target.currency
            ? `${t(FIGURE_KEY[kind])} ${fmtMoney(target.amount, target.currency, locale)}` : null,
          // Who the record says paid: the Business Account (a Mercury/PayPal
          // payment, not a manager's money) or the person.
          target.payerBusiness ? t('payBusiness')
            : target.payerName ? t('acctPickPaidBy', { name: target.payerName }) : null,
        ].filter(Boolean).join(' · ')}
        {target.recordedCny ? <> · {t('acctPickRecorded')} <Yuan value={target.recordedCny} locale={locale} /></> : null}
      </span>
    </span>
  );
}

function EntryFields({ f }: { f: AccountingEntryForm }) {
  const { t } = useT();
  const { form } = f;
  const id = (k: string) => 'acct-dlg-' + k;
  return (
    <div className="acct-form">
      <div className="seg" role="group" aria-label={t('acctFieldDirection')} style={{ justifySelf: 'start' }}>
        {(['out', 'in'] as const).map(d => (
          <button key={d} type="button" className={form.direction === d ? 'active' : ''} aria-pressed={form.direction === d}
                  onClick={() => f.setDirection(d)}>
            {t('acctDir_' + d)}
          </button>
        ))}
      </div>

      {!form.targetLocked && (
        <div>
          <div className="label" id={id('kind')}>{t('acctFieldKind')}</div>
          <div className="acct-kinds" role="group" aria-labelledby={id('kind')}>
            {ACCOUNTING_KINDS.map(k => (
              <button key={k} type="button" aria-pressed={form.kind === k} onClick={() => f.setKind(k)}>
                {t('acctKind_' + k)}
              </button>
            ))}
          </div>
        </div>
      )}

      {f.targetType && <TargetPicker f={f} />}
      {f.orphan && <div className="acct-banner">{t('acctOrphanNote')}</div>}

      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor={id('amount')}>{t('acctFieldAmount')}</label>
          <div className="acct-amount-row">
            <input id={id('amount')} className="input" type="number" inputMode="decimal" min="0" step="0.01"
                   value={form.amount} onChange={e => f.set({ amount: e.target.value })} autoFocus={!f.editing} />
            <div className="seg" role="group" aria-label={t('acctFieldCurrency')}>
              {(['CNY', 'USD'] as const).map(c => (
                <button key={c} type="button" className={form.currency === c ? 'active' : ''} aria-pressed={form.currency === c}
                        onClick={() => f.set({ currency: c })}>
                  {c === 'CNY' ? '¥ CNY' : '$ USD'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {form.currency === 'USD' && (
          <div className="field">
            <label className="label" htmlFor={id('rate')}>{t('acctFieldRate')}</label>
            <input id={id('rate')} className="input" type="number" inputMode="decimal" min="0" step="0.0001"
                   value={form.fxRate} onChange={e => f.set({ fxRate: e.target.value })}
                   placeholder={f.rate ? t('acctRatePh', { rate: f.rate.toFixed(4) }) : ''} />
          </div>
        )}
      </div>
      {form.currency === 'USD' && f.preview != null && (
        <PreviewLine value={f.preview} />
      )}

      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor={id('date')}>{t('acctFieldDate')}</label>
          <input id={id('date')} className="input" type="date" value={form.occurredOn}
                 onChange={e => f.set({ occurredOn: e.target.value })} />
        </div>
        <div className="field">
          <label className="label" htmlFor={id('method')}>{t('acctFieldMethod')}</label>
          <select id={id('method')} className="select" value={form.method}
                  onChange={e => f.set({ method: e.target.value as AccountingMethod })}>
            {ACCOUNTING_METHODS.map(m => <option key={m} value={m}>{t('acctMethod_' + m)}</option>)}
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor={id('manager')}>{t('acctFieldPaidBy')}</label>
          <select id={id('manager')} className="select" value={form.managerId} disabled={f.payerPickLocked}
                  onChange={e => f.set({ managerId: e.target.value })}>
            {f.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {f.payerLocked && <div className="acct-sub">{t('acctPaidFromBusiness')}</div>}
        </div>
        <div className="field">
          <label className="label" htmlFor={id('party')}>{t('acctFieldCounterparty')}</label>
          <input id={id('party')} className="input" value={form.counterparty} maxLength={200}
                 placeholder={t('acctCounterpartyPh')} onChange={e => f.setCounterparty(e.target.value)} />
        </div>
      </div>

      {!f.editing && (
        <AcctPendingAttachments files={f.files} onAdd={f.addFiles} onRemove={f.removeFile} busy={f.busy} paste />
      )}
      <div className="field">
        <label className="label" htmlFor={id('note')}>{t('acctFieldNote')}</label>
        <textarea id={id('note')} className="input" rows={2} value={form.note} maxLength={2000}
                  onChange={e => f.set({ note: e.target.value })}
                  style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' }} />
      </div>
      {f.error && <div className="acct-error" role="alert">{t(f.error)}</div>}
    </div>
  );
}

function PreviewLine({ value }: { value: number }) {
  const { t, locale } = useT();
  const [before, after] = t('acctPreview').split('{amount}');
  return <div className="acct-hint" style={{ marginTop: -6 }}>{before}<Yuan value={value} locale={locale} />{after}</div>;
}

function TargetPicker({ f }: { f: AccountingEntryForm }) {
  const { t } = useT();
  const { form } = f;
  const label = t(PICK_LABEL[f.targetType!]);
  if (form.target) {
    return (
      <div>
        <div className="label">{label}</div>
        <div className="acct-picked">
          <TargetLine kind={form.kind as Exclude<AccountingKind, 'other'>} target={form.target} />
          {!form.targetLocked && (
            <button type="button" className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => f.choose(null)}>
              {t('acctPickChange')}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <label className="label" htmlFor="acct-dlg-pick">{label}</label>
      <input id="acct-dlg-pick" className="input" value={f.query} placeholder={t('acctPickPh')}
             onChange={e => f.setQuery(e.target.value)} autoComplete="off" />
      {f.candidates && (
        <div className="acct-pick-list" role="listbox" aria-label={label}>
          {f.candidates.length === 0
            ? <div className="acct-empty" style={{ padding: '10px 12px' }}>{t('acctPickNone')}</div>
            : f.candidates.map((c: AcctTarget) => (
              <button key={c.id} type="button" role="option" aria-selected={false} className="acct-pick-row"
                      onClick={() => f.choose(c)}>
                <TargetLine kind={form.kind as Exclude<AccountingKind, 'other'>} target={c} />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
