import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ListSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, fmtDateShort, fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { navigate } from '../../lib/route';

// The records that explain internal money movement — a Mercury→PayPal
// transfer, a card-funding chain — and the note that says why. A row expands in
// place (this page has no drawer, matching Payments) into the member list, the
// editable note, and the search that grows the group: a transfer's second leg
// is found by amount, which is a search, not a suggestion.

type Leg = {
  id: string;
  source: string;
  externalId: string;
  postedAt: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypalTxnId: string | null;
};

type Member = {
  id: string;
  source: 'mercury' | 'paypal' | 'paired';
  postedAt: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  legs: Leg[];
};

type RecordRow = {
  id: string;
  title: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  memberCount: number;
  totalIn: number;
  totalOut: number;
  net: number;
};

type RecordDetail = RecordRow & { updatedAt: string; members: Member[] };

type Feed = { rows: RecordRow[]; nextCursor: string | null };

const SOURCE_LABEL: Record<Member['source'], string> = {
  mercury: 'Mercury',
  paypal: 'PayPal',
  paired: 'PayPal + Mercury',
};

// The sign carries meaning here (out of one account, into another), so it is
// always explicit rather than fmtUSD's "$-5,000.00".
function fmtSigned(n: number, locale: string): string {
  return (n < 0 ? '−' : '+') + fmtUSD(Math.abs(n), locale);
}

export function DesktopInternalTxns({ onToast }: { onToast: (msg: string) => void }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [q, setQ] = usePersisted('desktop.internaltx.q', '');
  const [openId, setOpenId] = usePersisted<string | null>('desktop.internaltx.open', null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [creating, setCreating] = useState(false);
  const reqId = useRef(0);

  const reload = useCallback(() => {
    const mine = ++reqId.current;
    const p = q ? `?q=${encodeURIComponent(q)}` : '';
    api.get<Feed>(`/api/internal-transactions${p}`)
      .then(r => { if (mine === reqId.current) setFeed(r); })
      .catch(handleFetchError);
  }, [q]);

  useEffect(() => { reload(); }, [reload]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post<{ id: string }>('/api/internal-transactions', {});
      setOpenId(r.id);
      reload();
    } catch (e) { handleFetchError(e); }
    finally { setCreating(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('payIntTitle')}</h1>
          <div className="page-sub">{t('payIntSub')}</div>
        </div>
        <div className="page-actions" style={{ alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn ghost" onClick={() => navigate('/payments')}>
            <Icon name="chevronRight" size={13} style={{ transform: 'rotate(180deg)' }} />
            {t('payIntBack')}
          </button>
          <button type="button" className="btn primary" onClick={create} disabled={creating}>
            <Icon name="plus" size={13} />
            {t('payIntNew')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              className="input"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('payIntSearch')}
              style={{ paddingLeft: 30, paddingTop: 0, paddingBottom: 0, height: 32, fontSize: 12.5, width: 260 }}
            />
          </div>
        </div>

        {!feed ? (
          <ListSkeleton rows={5} />
        ) : feed.rows.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--fg-subtle)' }}>
            <div>{t('payIntEmpty')}</div>
            <div style={{ fontSize: 12.5, marginTop: 6 }}>{t('payIntEmptySub')}</div>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th>{t('payIntColCreated')}</th>
                  <th>{t('payIntColTitle')}</th>
                  <th>{t('payIntColMembers')}</th>
                  <th className="num">{t('payIntColIn')}</th>
                  <th className="num">{t('payIntColOut')}</th>
                  <th className="num">{t('payIntColNet')}</th>
                </tr>
              </thead>
              <tbody>
                {feed.rows.map(row => (
                  <RecordTr
                    key={row.id}
                    row={row}
                    open={openId === row.id}
                    onToggle={() => setOpenId(openId === row.id ? null : row.id)}
                    locale={locale}
                    onChanged={reload}
                    onToast={onToast}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function RecordTr({ row, open, onToggle, locale, onChanged, onToast }: {
  row: RecordRow;
  open: boolean;
  onToggle: () => void;
  locale: string;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useT();
  return (
    <>
      <tr className="row-hover" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <td style={{ paddingRight: 0 }}>
          <Icon
            name="chevronRight" size={13}
            style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms', color: 'var(--fg-subtle)' }}
          />
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(row.createdAt, locale)}</td>
        <td>
          <span style={{ fontWeight: 500 }}>{row.title || t('payIntUntitled')}</span>
          {row.note && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{row.note}</span>
          )}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {row.memberCount === 1 ? t('payIntMembersOne') : t('payIntMembers', { n: row.memberCount })}
        </td>
        <td className="num mono" style={{ color: row.totalIn ? 'var(--pos)' : undefined, whiteSpace: 'nowrap' }}>
          {row.totalIn ? fmtSigned(row.totalIn, locale) : '—'}
        </td>
        <td className="num mono" style={{ whiteSpace: 'nowrap' }}>
          {row.totalOut ? fmtSigned(row.totalOut, locale) : '—'}
        </td>
        <td className="num mono" style={{ whiteSpace: 'nowrap' }}>{fmtSigned(row.net, locale)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--bg-soft)', padding: '10px 16px 12px' }}>
            <RecordDetailPanel id={row.id} locale={locale} onChanged={onChanged} onToast={onToast} />
          </td>
        </tr>
      )}
    </>
  );
}

// Fetched when the row opens rather than with the feed: the list needs the
// totals, and most records are never expanded.
function RecordDetailPanel({ id, locale, onChanged, onToast }: {
  id: string;
  locale: string;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useT();
  const [rec, setRec] = useState<RecordDetail | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.get<RecordDetail>(`/api/internal-transactions/${id}`)
      .then(r => {
        setRec(r);
        setTitle(r.title ?? '');
        setNote(r.note ?? '');
        setDirty(false);
      })
      .catch(handleFetchError);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/internal-transactions/${id}`, { title, note });
      setDirty(false);
      onToast(t('payIntSaved'));
      onChanged();
    } catch (e) { handleFetchError(e); }
    finally { setSaving(false); }
  };

  const removeMember = async (txnId: string) => {
    try {
      await api.delete(`/api/internal-transactions/${id}/members/${txnId}`);
      onToast(t('payIntRemovedToast'));
      load();
      onChanged();
    } catch (e) { handleFetchError(e); }
  };

  const addMember = async (txnId: string) => {
    try {
      await api.post(`/api/internal-transactions/${id}/members`, { txnIds: [txnId] });
      setAdding(false);
      load();
      onChanged();
    } catch (e) { handleFetchError(e); }
  };

  const destroy = async () => {
    try {
      await api.delete(`/api/internal-transactions/${id}`);
      onToast(t('payIntDeletedToast'));
      onChanged();
    } catch (e) { handleFetchError(e); }
  };

  if (!rec) return <ListSkeleton rows={2} />;

  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 12.5 }}>
      <div style={{ display: 'grid', gap: 6, maxWidth: 620 }}>
        <input
          className="input"
          value={title}
          placeholder={t('payIntNamePh')}
          onChange={e => { setTitle(e.target.value); setDirty(true); }}
          style={{ height: 32, fontSize: 13 }}
        />
        <textarea
          className="input"
          value={note}
          placeholder={t('payIntNotePh')}
          rows={3}
          onChange={e => { setNote(e.target.value); setDirty(true); }}
          style={{ fontSize: 12.5, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="btn sm primary" onClick={save} disabled={!dirty || saving}>
            {t('payIntSaveNote')}
          </button>
          <span className="muted">
            {fmtDate(rec.createdAt, locale)}
            {rec.createdByName ? ` · ${t('payIntCreatedBy', { name: rec.createdByName })}` : ''}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {rec.members.length === 0 ? (
          <span className="muted">{t('payIntNoMembers')}</span>
        ) : rec.members.map(m => (
          <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className={'chip ' + (m.source === 'paired' ? 'accent' : m.source === 'mercury' ? 'info' : '')} style={{ fontSize: 10.5 }}>
              {SOURCE_LABEL[m.source]}
            </span>
            <span className="mono muted">{fmtDate(m.postedAt, locale)}</span>
            <span className="mono">{fmtSigned(m.amount, locale)}</span>
            <span>{m.counterparty ?? '—'}</span>
            {m.description && <span className="muted">{m.description}</span>}
            <button type="button" className="btn sm ghost" onClick={() => removeMember(m.id)}>
              {t('payIntRemoveMember')}
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn sm ghost" onClick={() => setAdding(a => !a)}>
          {t('payIntAddTxn')}
        </button>
        <button type="button" className="btn sm ghost" onClick={destroy}>
          {t('payIntDelete')}
        </button>
      </div>
      {adding && <TxnSearch onPick={addMember} onClose={() => setAdding(false)} locale={locale} />}
    </div>
  );
}

// Searching the feed rather than offering candidates: the counterpart of a
// transfer has the opposite sign, which the existing pair matcher — built on
// equal signed amounts — cannot rank.
function TxnSearch({ onPick, onClose, locale }: {
  onPick: (id: string) => void;
  onClose: () => void;
  locale: string;
}) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Member[] | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      const p = new URLSearchParams({ status: 'all', direction: 'all', limit: '15' });
      if (q.trim()) p.set('q', q.trim());
      api.get<{ rows: Member[] }>(`/api/bank-transactions?${p}`)
        .then(r => setRows(r.rows))
        .catch(handleFetchError);
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: 8,
      background: 'var(--bg)', display: 'grid', gap: 6, maxWidth: 620,
    }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input" autoFocus value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('payIntAddSearch')}
          style={{ height: 30, fontSize: 12.5 }}
        />
        <button type="button" className="btn sm ghost" onClick={onClose}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {rows === null ? (
        <ListSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <span className="muted">{t('payIntAddNone')}</span>
      ) : rows.map(r => (
        <button
          key={r.id}
          type="button"
          className="btn sm ghost"
          style={{ justifyContent: 'flex-start', gap: 10 }}
          onClick={() => onPick(r.id)}
        >
          <span className="mono muted">{fmtDateShort(r.postedAt, locale)}</span>
          <span className="mono">{fmtSigned(r.amount, locale)}</span>
          <span>{r.counterparty ?? '—'}</span>
        </button>
      ))}
    </div>
  );
}
