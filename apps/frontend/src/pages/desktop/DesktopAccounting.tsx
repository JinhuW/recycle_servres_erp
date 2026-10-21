import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCOUNTING_KINDS, ACCOUNTING_METHODS, resolvePreset,
  type AccountingDirection, type AccountingKind, type AccountingMethod,
} from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { RouteLink } from '../../components/RouteLink';
import { Yuan, recordPath } from '../../components/AccountingBits';
import { useT } from '../../lib/i18n';
import { handleFetchError } from '../../lib/errorToast';
import { fmtMoney } from '../../lib/format';
import { forEachKeysetPage } from '../../lib/keysetPages';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { accountingEntryPath, match, navigate, useRoute } from '../../lib/route';
import {
  acctEntries, acctSummary, fmtBookDay, localToday, markDayStarts,
  type AcctRow, type AcctSummary,
} from '../../lib/accounting';
import { RangeChip, type RangeValue } from './DashboardRange';
import { EntryDialog } from './accounting/EntryDialog';
import { EntryDrawer } from './accounting/EntryDrawer';
import '../../styles/accounting.css';

type Props = { onToast?: (msg: string, kind?: 'success' | 'error') => void };

// The managers' RMB book. The period and the manager are the book's scope;
// the band states it (opening + received − paid = closing) and the table is
// the book itself. Filters on the table only hide rows: a balance is what
// the manager held after that entry, whatever else is on screen.
export function DesktopAccounting({ onToast }: Props) {
  const { t, locale } = useT();
  const { path } = useRoute();
  const openId = match('/accounting/:id', path)?.id ?? null;
  const today = useMemo(() => localToday(), []);
  const [range, setRange] = useState<RangeValue>(() => ({ ...resolvePreset('mtd', today, null), preset: 'mtd' }));
  const [managerId, setManagerId] = useState('');
  const [direction, setDirection] = useState<'' | AccountingDirection>('');
  const [kind, setKind] = useState<'' | AccountingKind>('');
  const [method, setMethod] = useState<'' | AccountingMethod>('');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const [showVoided, setShowVoided] = useState(false);
  const [summary, setSummary] = useState<AcctSummary | null>(null);
  const [rows, setRows] = useState<AcctRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Bumped by every write, so the band and the book re-read together.
  const [gen, setGen] = useState(0);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let alive = true;
    acctSummary({ from: range.from, to: range.to, managerId: managerId || undefined })
      .then(r => { if (alive) setSummary(r); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [range.from, range.to, managerId, gen]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to, limit: '200' });
    if (managerId) p.set('managerId', managerId);
    if (direction) p.set('direction', direction);
    if (kind) p.set('kind', kind);
    if (method) p.set('method', method);
    if (q) p.set('q', q);
    if (showVoided) p.set('voided', '1');
    return p.toString();
  }, [range.from, range.to, managerId, direction, kind, method, q, showVoided]);

  // Bumped per load, so a superseded walk's pages never land on the new list.
  const loadGen = useRef(0);
  useEffect(() => {
    const g = ++loadGen.current;
    forEachKeysetPage<AcctRow>(
      cursor => acctEntries(query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
        .then(r => ({ items: r.rows, nextCursor: r.nextCursor })),
      (items, { first }) => {
        if (g !== loadGen.current) return false;
        setRows(prev => (first ? items : [...prev, ...items]));
        setLoaded(true);
      },
    ).catch(handleFetchError);
  }, [query, gen]);

  const changed = () => setGen(g => g + 1);
  const filtered = !!(direction || kind || method || q);
  const dayStarts = markDayStarts(rows);
  const managerName = summary?.managers.find(m => m.id === managerId)?.name;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('acctTitle')}</h1>
          <div className="page-sub">{t('acctSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn accent" onClick={() => setRecording(true)}>
            <Icon name="plus" size={14} /> {t('acctRecord')}
          </button>
        </div>
      </div>

      <div className="acct-scope">
        <RangeChip value={range} today={today} first={summary?.first ?? null} locale={locale} onChange={setRange} />
        <select className="select" value={managerId} aria-label={t('acctFieldManager')}
                onChange={e => setManagerId(e.target.value)}>
          <option value="">{t('acctAllManagers')}</option>
          {summary?.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {summary && <span className="acct-rate">{t('acctRateNote', { rate: summary.fx.rate.toFixed(4) })}</span>}
      </div>

      {summary && <IdentityBand summary={summary} managerId={managerId} onManager={setManagerId} />}

      <div className="card">
        <div className="card-head acct-filters">
          <div className="seg" role="group" aria-label={t('acctFieldDirection')}>
            {(['', 'in', 'out'] as const).map(d => (
              <button key={d || 'all'} type="button" className={direction === d ? 'active' : ''} aria-pressed={direction === d}
                      onClick={() => setDirection(d)}>
                {d ? t('acctDir_' + d) : t('acctAllDirections')}
              </button>
            ))}
          </div>
          <select className="select" value={kind} aria-label={t('acctFieldKind')}
                  onChange={e => setKind(e.target.value as '' | AccountingKind)}>
            <option value="">{t('acctAnyKind')}</option>
            {ACCOUNTING_KINDS.map(k => <option key={k} value={k}>{t('acctKind_' + k)}</option>)}
          </select>
          <select className="select" value={method} aria-label={t('acctFieldMethod')}
                  onChange={e => setMethod(e.target.value as '' | AccountingMethod)}>
            <option value="">{t('acctAnyMethod')}</option>
            {ACCOUNTING_METHODS.map(m => <option key={m} value={m}>{t('acctMethod_' + m)}</option>)}
          </select>
          <div className="acct-search">
            <Icon name="search" size={13} />
            <input className="input" placeholder={t('acctSearchPh')} value={search} aria-label={t('acctSearchPh')}
                   onChange={e => setSearch(e.target.value)} />
          </div>
          <label className="acct-voided-toggle">
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
            {t('acctShowVoided')}
          </label>
        </div>

        {loaded && rows.length === 0 ? (
          <div className="acct-empty">
            {filtered ? t('acctEmptyFiltered') : (
              <>
                <div>{managerName ? t('acctEmptyManager', { name: managerName }) : t('acctEmpty')}</div>
                <button className="btn" onClick={() => setRecording(true)}><Icon name="plus" size={13} /> {t('acctRecord')}</button>
              </>
            )}
          </div>
        ) : (
          <div className="acct-book-wrap">
            <table className="data-table acct-book">
              <thead>
                <tr>
                  <th>{t('acctColDate')}</th>
                  <th>{t('acctColEntry')}</th>
                  <th>{t('acctFieldKind')}</th>
                  <th>{t('acctFieldManager')}</th>
                  <th>{t('acctFieldMethod')}</th>
                  <th className="acct-num">{t('acctReceived')}</th>
                  <th className="acct-num">{t('acctPaid')}</th>
                  <th className="acct-num" title={t('acctBalanceHint')}>{t('acctBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const rec = recordPath(r);
                  const open = () => navigate(accountingEntryPath(r.id));
                  return (
                    <tr
                      key={r.id}
                      className={(dayStarts[i] ? 'acct-day-start' : '') + (r.voided ? ' acct-voided' : '')}
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={e => { if (e.key === 'Enter') open(); }}
                    >
                      <td className="acct-date">{dayStarts[i] ? fmtBookDay(r.occurredOn, locale) : ''}</td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                        {r.id}
                        {r.voided && <span className="chip muted" style={{ fontSize: 10, marginLeft: 6 }}>{t('acctVoidedChip')}</span>}
                      </td>
                      <td style={{ maxWidth: 420 }}>
                        <div className="acct-for">
                          <span className="acct-for-kind">{t('acctKind_' + r.kind)}</span>
                          {r.target && rec && (
                            // onLinkClick stops the click here, so the row
                            // doesn't open the entry as well.
                            <RouteLink to={rec} className="mono rec-link">{r.target.id}</RouteLink>
                          )}
                          {!r.target && r.kind !== 'other' && <span className="acct-for-party">{t('acctRecordDeleted')}</span>}
                          {r.counterparty && <span className="acct-for-party">{r.counterparty}</span>}
                        </div>
                        {r.note && <span className="acct-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.note}</span>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.manager.name}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t('acctMethod_' + r.method)}</td>
                      <td className="acct-num">
                        {r.direction === 'in' && <Amount row={r} locale={locale} />}
                      </td>
                      <td className="acct-num">
                        {r.direction === 'out' && <Amount row={r} locale={locale} />}
                      </td>
                      <td className="acct-num acct-bal">
                        {r.balance != null && (
                          <Yuan value={r.balance} locale={locale} className={r.balance < 0 ? 'acct-neg' : undefined} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openId && (
        <EntryDrawer
          id={openId}
          onClose={() => navigate('/accounting')}
          onChanged={changed}
          onToast={msg => onToast?.(msg)}
        />
      )}
      {recording && (
        <EntryDialog
          preset={managerId ? { kind: 'other', managerId } : undefined}
          onClose={() => setRecording(false)}
          onSaved={r => {
            setRecording(false);
            onToast?.(t('acctRecordedToast', { id: r.id }));
            changed();
          }}
        />
      )}
    </>
  );
}

function Amount({ row, locale }: { row: AcctRow; locale: string }) {
  return (
    <>
      <Yuan value={row.amountCny} locale={locale} className={row.direction === 'in' && !row.voided ? 'acct-in' : undefined} />
      {row.currency === 'USD' && row.fxRate !== null && (
        <span className="acct-sub">{fmtMoney(row.amount, 'USD', locale)} @ {row.fxRate.toFixed(2)}</span>
      )}
    </>
  );
}

// The period as an identity, the way a book carries one page to the next.
function IdentityBand({ summary, managerId, onManager }: {
  summary: AcctSummary; managerId: string; onManager: (id: string) => void;
}) {
  const { t, locale } = useT();
  const ofKinds = (side: 'received' | 'paid') => ACCOUNTING_KINDS
    .map(k => ({ k, v: summary.byKind[k][side] }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v);
  // Each term owns one grid column across the three rows (label, figure, its
  // kinds); the operators sit between them on the figures' row.
  const term = (col: number, label: string, value: number, cls?: string, of?: { k: AccountingKind; v: number }[]) => (
    <div className="acct-term" style={{ ['--col' as string]: col }}>
      <div className="acct-term-label">{label}</div>
      <Yuan value={value} locale={locale} className={'acct-term-fig' + (cls ? ' ' + cls : '')} />
      <div className="acct-term-of">
        {of?.map(x => (
          <div key={x.k}><span>{t('acctKind_' + x.k)}</span><Yuan value={x.v} locale={locale} /></div>
        ))}
      </div>
    </div>
  );
  return (
    <section className="acct-band" aria-label={t('acctBandLabel')}>
      <div className="acct-sum">
        {term(1, t('acctOpening'), summary.opening, summary.opening < 0 ? 'acct-neg' : undefined)}
        <span className="acct-op" style={{ gridColumn: 2 }} aria-hidden="true">+</span>
        {term(3, t('acctReceived'), summary.received, 'acct-in', ofKinds('received'))}
        <span className="acct-op" style={{ gridColumn: 4 }} aria-hidden="true">−</span>
        {term(5, t('acctPaid'), summary.paid, undefined, ofKinds('paid'))}
        <span className="acct-op" style={{ gridColumn: 6 }} aria-hidden="true">=</span>
        {term(7, t('acctClosing'), summary.closing, 'acct-closing' + (summary.closing < 0 ? ' acct-neg' : ''))}
      </div>
      {summary.managers.length > 0 && (
        <div className="acct-held">
          <span className="acct-held-label" title={t('acctHeldByHint')}>{t('acctHeldBy')}</span>
          {summary.managers.map(m => (
            <button key={m.id} type="button" aria-pressed={managerId === m.id}
                    onClick={() => onManager(managerId === m.id ? '' : m.id)}>
              <span>{m.name}</span>
              <Yuan value={m.balance} locale={locale} className={m.balance < 0 ? 'acct-neg' : undefined} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
