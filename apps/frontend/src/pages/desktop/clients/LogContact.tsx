// Logging a call. The load-bearing interaction: if this ever costs more than a
// couple of taps, purchasers will make calls and not log them, and the whole
// follow-up list starts lying.
//
// So: the kind is pre-selected, the outcome is a chip rather than a sentence,
// and the next call is already scheduled. Doing nothing is the correct action.

import { useState } from 'react';
import { api } from '../../../lib/api';
import { showErrorDialog } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { type ContactKind, KIND_KEY } from '../../../lib/clients';

const KINDS: ContactKind[] = ['call', 'text', 'visit', 'offer', 'note'];
const OUTCOMES = ['cliOutHasStock', 'cliOutNothing', 'cliOutNoAnswer', 'cliOutCallBack'] as const;

type When = 'cadence' | 'week' | 'month' | 'pick';

export function LogContact({ id, cadenceDays, onSaved }: {
  id: string; cadenceDays: number; onSaved: (nextIso: string) => void;
}) {
  const { t } = useT();
  const [kind, setKind] = useState<ContactKind>('call');
  const [body, setBody] = useState('');
  const [when, setWhen] = useState<When>('cadence');
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);

  const iso = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const nextIso =
    when === 'cadence' ? iso(cadenceDays)
    : when === 'week' ? iso(7)
    : when === 'month' ? iso(30)
    : picked;

  const save = async () => {
    if (when === 'pick' && !picked) { showErrorDialog(t('cliPickDateFirst')); return; }
    setSaving(true);
    try {
      const r = await api.post<{ nextFollowUpAt: string }>(`/api/suppliers/${id}/notes`, {
        kind, body: body.trim(), nextFollowUpAt: nextIso,
      });
      setBody('');
      setWhen('cadence');
      onSaved(r.nextFollowUpAt);
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('cliLogFailed'));
    } finally { setSaving(false); }
  };

  return (
    <div className="cli-log">
      <div className="cli-seg" role="group" aria-label={t('cliLogKindAria')}>
        {KINDS.map((k) => (
          <button
            key={k} type="button"
            className={`cli-seg-btn${kind === k ? ' on' : ''}`}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >{t(KIND_KEY[k])}</button>
        ))}
      </div>

      <textarea
        className="input cli-log-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('cliLogPh')}
        rows={2}
        aria-label={t('cliLogPh')}
      />

      <div className="cli-chips">
        {OUTCOMES.map((k) => (
          <button
            key={k} type="button" className="cli-chip-btn"
            onClick={() => setBody((b) => (b ? `${b} ${t(k)}` : t(k)))}
          >{t(k)}</button>
        ))}
      </div>

      <div className="cli-when-label">{t('cliNextCall')}</div>
      <div className="cli-when">
        <button type="button" className={`cli-when-btn${when === 'cadence' ? ' on' : ''}`}
          aria-pressed={when === 'cadence'} onClick={() => setWhen('cadence')}>
          {t('cliWhenUsual', { n: cadenceDays })}
          <span className="cli-when-date">{fmtShort(iso(cadenceDays))}</span>
        </button>
        <button type="button" className={`cli-when-btn${when === 'week' ? ' on' : ''}`}
          aria-pressed={when === 'week'} onClick={() => setWhen('week')}>{t('cliWhenWeek')}</button>
        <button type="button" className={`cli-when-btn${when === 'month' ? ' on' : ''}`}
          aria-pressed={when === 'month'} onClick={() => setWhen('month')}>{t('cliWhenMonth')}</button>
        <button type="button" className={`cli-when-btn${when === 'pick' ? ' on' : ''}`}
          aria-pressed={when === 'pick'} onClick={() => setWhen('pick')}>{t('cliWhenPick')}</button>
        {when === 'pick' && (
          <input type="date" className="input cli-date" value={picked}
            onChange={(e) => setPicked(e.target.value)} aria-label={t('cliWhenPick')} />
        )}
      </div>

      <div className="cli-log-foot">
        <span className="cli-log-hint">{t('cliLogHint', { n: cadenceDays })}</span>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('cliSaving') : t('cliSave')}
        </button>
      </div>
    </div>
  );
}

function fmtShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
