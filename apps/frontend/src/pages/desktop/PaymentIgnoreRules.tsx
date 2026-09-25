import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { ConfirmDialog } from './settings/dialogs';

// The taught form of Ignore. A rule is a case-insensitive "contains" on the
// counterparty or description, optionally pinned to one source; the backend
// applies the whole set after every sync and on every edit here.

type RuleSource = 'mercury' | 'paypal' | null;

type Rule = {
  id: string;
  source: RuleSource;
  pattern: string;
  label: string;
  createdAt: string;
  createdByName: string | null;
  matched: number;
};

type Preview = {
  count: number;
  sample: { id: string; source: string; amount: number; counterparty: string | null; description: string | null }[];
};

type Draft = { id: string | null; label: string; source: RuleSource; pattern: string };

const EMPTY: Draft = { id: null, label: '', source: null, pattern: '' };

const SOURCE_NAME: Record<Exclude<RuleSource, null>, string> = { mercury: 'Mercury', paypal: 'PayPal' };

export function PaymentIgnoreRules({ onClose, onChanged, onToast }: {
  onClose: () => void;
  // The Payments page refetches the feed and the tiles: a rule moves rows
  // between Unlinked and Ignored, and the list may not show them all.
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  useEscapeKey(onClose, !deleting);

  const load = useCallback(() => {
    api.get<{ rules: Rule[] }>('/api/bank-transactions/ignore-rules')
      .then(r => setRules(r.rules))
      .catch(handleFetchError);
  }, []);
  useEffect(() => { load(); }, [load]);

  // What the rule would take, asked as it is typed. Debounced: every keystroke
  // is a scan of the open queue, and the answer to the last one is the only
  // one that matters.
  const pattern = draft.pattern.trim();
  useEffect(() => {
    if (!pattern) { setPreview(null); return; }
    let live = true;
    const h = setTimeout(() => {
      const qs = new URLSearchParams({ pattern });
      if (draft.source) qs.set('source', draft.source);
      api.get<Preview>(`/api/bank-transactions/ignore-rules/preview?${qs}`)
        .then(p => { if (live) setPreview(p); })
        .catch(() => { if (live) setPreview(null); });
    }, 300);
    return () => { live = false; clearTimeout(h); };
  }, [pattern, draft.source]);

  const save = async () => {
    if (!pattern || saving) return;
    setSaving(true);
    try {
      const body = { label: draft.label.trim(), source: draft.source, pattern };
      const r = draft.id
        ? await api.patch<{ rule: Rule; ignored: number }>(`/api/bank-transactions/ignore-rules/${draft.id}`, body)
        : await api.post<{ rule: Rule; ignored: number }>('/api/bank-transactions/ignore-rules', body);
      onToast(t('payRuleSaved', { n: r.ignored }));
      setDraft(EMPTY);
      load();
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (rule: Rule) => {
    setDeleting(null);
    try {
      const r = await api.delete<{ ok: boolean; restored: number }>(`/api/bank-transactions/ignore-rules/${rule.id}`);
      onToast(t('payRuleDeleted', { n: r.restored }));
      if (draft.id === rule.id) setDraft(EMPTY);
      load();
      onChanged();
    } catch (e) {
      handleFetchError(e);
    }
  };

  const edit = (rule: Rule) => setDraft({ id: rule.id, label: rule.label, source: rule.source, pattern: rule.pattern });

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 720 }}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('payIgnoreRules')}</div>
            <div className="modal-sub">{t('payIgnoreRulesSub')}</div>
          </div>
          <button type="button" className="btn icon" onClick={onClose} aria-label={t('close')}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <form onSubmit={e => { e.preventDefault(); void save(); }}>
            <div className="field-row">
              <div className="field" style={{ flex: '0 0 160px' }}>
                <label className="label">{t('payRuleLabel')}</label>
                <input
                  className="input" value={draft.label} maxLength={60}
                  onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
                  placeholder={t('payRuleLabelPh')}
                />
              </div>
              <div className="field" style={{ flex: '0 0 140px' }}>
                <label className="label">{t('payRuleSource')}</label>
                <select
                  className="select" value={draft.source ?? ''}
                  onChange={e => setDraft(d => ({ ...d, source: (e.target.value || null) as RuleSource }))}
                >
                  <option value="">{t('payRuleSourceAny')}</option>
                  <option value="mercury">Mercury</option>
                  <option value="paypal">PayPal</option>
                </select>
              </div>
              <div className="field">
                <label className="label">{t('payRulePattern')}</label>
                <input
                  className="input" value={draft.pattern} maxLength={120}
                  onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))}
                  placeholder={t('payRulePatternPh')}
                  autoFocus
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, minHeight: 28 }}>
              <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)', flex: 1 }}>
                {!pattern ? null
                  : !preview ? '…'
                  : preview.count === 0 ? t('payRulePreviewNone')
                  : (
                    <>
                      {t('payRulePreview', { n: preview.count })}
                      {' — '}
                      {preview.sample.map(s => `${s.counterparty || s.description || s.source} ${fmtUSD(s.amount, locale)}`).join(', ')}
                      {preview.count > preview.sample.length ? ', …' : ''}
                    </>
                  )}
              </span>
              {draft.id && (
                <button type="button" className="btn sm ghost" onClick={() => setDraft(EMPTY)}>{t('cancel')}</button>
              )}
              <button type="submit" className="btn sm primary" disabled={!pattern || saving}>
                {draft.id ? t('payRuleSave') : t('payRuleAdd')}
              </button>
            </div>
          </form>

          {rules === null ? null : rules.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, padding: '8px 0' }}>{t('payRuleEmpty')}</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('payRuleLabel')}</th>
                  <th>{t('payRuleSource')}</th>
                  <th>{t('payRulePattern')}</th>
                  <th style={{ textAlign: 'right' }}>{t('payRuleMatched')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id} className={draft.id === r.id ? 'active' : ''}>
                    <td>{r.label || <span className="muted">—</span>}</td>
                    <td>{r.source ? SOURCE_NAME[r.source] : t('payRuleSourceAny')}</td>
                    <td className="mono">{r.pattern}</td>
                    <td style={{ textAlign: 'right' }}>{r.matched}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn sm ghost" onClick={() => edit(r)}>{t('payRuleEdit')}</button>
                      <button type="button" className="btn sm ghost" onClick={() => setDeleting(r)}>{t('payRuleDelete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>{t('close')}</button>
        </div>
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('payRuleDeleteTitle')}
          message={t('payRuleDeleteConfirm', { n: deleting.matched })}
          confirmLabel={t('payRuleDelete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </div>
  );
}
