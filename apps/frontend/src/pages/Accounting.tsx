import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PhHeader } from '../components/PhHeader';
import { Icon } from '../components/Icon';
import { RouteLink } from '../components/RouteLink';
import { HistoryLine, Yuan, recordPath } from '../components/AccountingBits';
import { AcctAttachments } from '../components/AcctAttachments';
import { PhAccountingSheet, PhVoidSheet } from '../components/PhAccountingSheet';
import { useT } from '../lib/i18n';
import { handleFetchError } from '../lib/errorToast';
import { fmtMoney } from '../lib/format';
import { forEachKeysetPage } from '../lib/keysetPages';
import { usePhScrolled } from '../lib/usePhScrolled';
import { useEffectiveUser } from '../lib/tweaks';
import { accountingEntryPath, matchAccountingEntry, navigateBack, replaceRoute, useRoute } from '../lib/route';
import {
  PHONE_PERIODS, acctEntries, acctEntry, acctRestore, acctSummary, acctVoid, fmtBookDay, localToday,
  phonePeriod, signedCny,
  type AcctEntryDetail, type AcctRow, type AcctSummary, type PhonePeriod,
} from '../lib/accounting';
import '../styles/accounting.css';

type Props = { showToast: (msg: string) => void };

// The managers' RMB book on the phone: the period as a tape that adds up,
// then the entries day by day. `/accounting/:id` is one entry, full screen.
export function Accounting({ showToast }: Props) {
  const { path } = useRoute();
  const user = useEffectiveUser();
  const entryId = matchAccountingEntry(path);
  const allowed = user?.role === 'manager';
  // Manager-only, like the API: anyone else is sent home.
  useEffect(() => { if (user && !allowed) replaceRoute('/'); }, [user, allowed]);
  if (!allowed) return null;
  return entryId ? <EntryScreen id={entryId} showToast={showToast} /> : <BookScreen showToast={showToast} />;
}

function BookScreen({ showToast }: Props) {
  const { t, locale } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
  const today = useMemo(() => localToday(), []);
  const [period, setPeriod] = useState<PhonePeriod>('month');
  const [managerId, setManagerId] = useState('');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [summary, setSummary] = useState<AcctSummary | null>(null);
  const [rows, setRows] = useState<AcctRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [gen, setGen] = useState(0);
  const [recording, setRecording] = useState(false);
  const win = useMemo(() => phonePeriod(period, today), [period, today]);

  useEffect(() => {
    let alive = true;
    acctSummary({ ...win, managerId: managerId || undefined })
      .then(r => { if (alive) setSummary(r); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [win, managerId, gen]);

  const loadGen = useRef(0);
  useEffect(() => {
    const g = ++loadGen.current;
    const p = new URLSearchParams({ from: win.from, to: win.to, limit: '200' });
    if (managerId) p.set('managerId', managerId);
    if (direction) p.set('direction', direction);
    forEachKeysetPage<AcctRow>(
      cursor => acctEntries(p.toString() + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
        .then(r => ({ items: r.rows, nextCursor: r.nextCursor })),
      (items, { first }) => {
        if (g !== loadGen.current) return false;
        setRows(prev => (first ? items : [...prev, ...items]));
        setLoaded(true);
      },
    ).catch(handleFetchError);
  }, [win, managerId, direction, gen]);

  const days = useMemo(() => {
    const out: { day: string; rows: AcctRow[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.day === r.occurredOn) last.rows.push(r); else out.push({ day: r.occurredOn, rows: [r] });
    }
    return out;
  }, [rows]);

  return (
    <>
      <PhHeader
        title={t('acctTitle')}
        sub={t('acctPhPeriod_' + period)}
        scrolled={scrolled}
        leading={(
          <button className="ph-icon-btn" onClick={() => navigateBack('/')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        )}
        trailing={(
          <button className="ph-icon-btn" onClick={() => setRecording(true)} aria-label={t('acctRecord')}>
            <Icon name="plus" size={16} />
          </button>
        )}
      />
      <div className="ph-scroll" ref={scrollRef}>
        <div className="ph-chip-scroller">
          {PHONE_PERIODS.map(p => (
            <button key={p} className={'ph-chip-btn ' + (period === p ? 'active' : '')} aria-pressed={period === p}
                    onClick={() => setPeriod(p)}>
              {t('acctPhPeriod_' + p)}
            </button>
          ))}
        </div>
        {summary && summary.managers.length > 1 && (
          <div className="ph-chip-scroller" style={{ marginTop: 0 }}>
            <button className={'ph-chip-btn ' + (!managerId ? 'active' : '')} aria-pressed={!managerId} onClick={() => setManagerId('')}>
              {t('acctAllManagers')}
            </button>
            {summary.managers.map(m => (
              <button key={m.id} className={'ph-chip-btn ' + (managerId === m.id ? 'active' : '')} aria-pressed={managerId === m.id}
                      onClick={() => setManagerId(managerId === m.id ? '' : m.id)}>
                {m.name.split(' ')[0]}
              </button>
            ))}
          </div>
        )}

        {summary && <Tape summary={summary} />}

        <div className="seg" role="group" aria-label={t('acctFieldDirection')} style={{ width: '100%', marginTop: 14 }}>
          {(['', 'in', 'out'] as const).map(d => (
            <button key={d || 'all'} style={{ flex: 1 }} className={direction === d ? 'active' : ''} aria-pressed={direction === d}
                    onClick={() => setDirection(d)}>
              {d ? t('acctDir_' + d) : t('acctAllDirections')}
            </button>
          ))}
        </div>

        {loaded && rows.length === 0 && (
          <div className="ph-card" style={{ marginTop: 14, padding: 16, fontSize: 13, color: 'var(--fg-subtle)' }}>
            {direction ? t('acctEmptyFiltered') : t('acctEmpty')}
          </div>
        )}
        {days.map(d => (
          <div key={d.day} className="acct-ph-day">
            <div className="ph-section-h" style={{ paddingTop: 0 }}><span>{fmtBookDay(d.day, locale)}</span></div>
            <div className="acct-ph-list">
              {d.rows.map(r => (
                <RouteLink key={r.id} to={accountingEntryPath(r.id)} className="acct-ph-row">
                  <span className="acct-ph-row-what">
                    {t('acctKind_' + r.kind)}{r.target ? ' · ' + r.target.id : ''}
                  </span>
                  <Yuan value={signedCny(r)} locale={locale} signed className={r.direction === 'in' ? 'acct-in' : undefined} />
                  <span className="acct-ph-row-sub">
                    {[r.counterparty, r.manager.name.split(' ')[0], t('acctMethod_' + r.method)].filter(Boolean).join(' · ')}
                  </span>
                </RouteLink>
              ))}
            </div>
          </div>
        ))}
        <div style={{ height: 24 }} />
      </div>
      {recording && (
        <PhAccountingSheet
          preset={managerId ? { kind: 'other', managerId } : undefined}
          onClose={() => setRecording(false)}
          onSaved={r => { setRecording(false); showToast(t('acctRecordedToast', { id: r.id })); setGen(g => g + 1); }}
        />
      )}
    </>
  );
}

// The band, as a till roll: each figure on its own line and the total ruled
// off underneath, which reads down the narrow screen the way a sum is done.
function Tape({ summary }: { summary: AcctSummary }) {
  const { t, locale } = useT();
  const row = (op: string, label: string, value: number, cls?: string) => (
    <div className="acct-ph-tape-row">
      <span><span className="acct-op" aria-hidden="true">{op}</span>{label}</span>
      <Yuan value={value} locale={locale} className={cls} />
    </div>
  );
  return (
    <section className="acct-ph-tape" aria-label={t('acctBandLabel')}>
      {row('', t('acctOpening'), summary.opening, summary.opening < 0 ? 'acct-neg' : undefined)}
      {row('+', t('acctReceived'), summary.received, 'acct-in')}
      {row('−', t('acctPaid'), summary.paid)}
      <div className="acct-ph-tape-row acct-ph-tape-total">
        <span><span className="acct-op" aria-hidden="true">=</span>{t('acctClosing')}</span>
        <Yuan value={summary.closing} locale={locale} className={summary.closing < 0 ? 'acct-neg' : undefined} />
      </div>
      {summary.managers.length > 0 && (
        <div className="acct-ph-held">
          <div style={{ color: 'var(--fg-subtle)' }}>{t('acctHeldBy')}</div>
          {summary.managers.map(m => (
            <div key={m.id}>
              <span>{m.name}</span>
              <Yuan value={m.balance} locale={locale} className={m.balance < 0 ? 'acct-neg' : undefined} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EntryScreen({ id, showToast }: { id: string } & Props) {
  const { t, locale } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
  const [entry, setEntry] = useState<AcctEntryDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    acctEntry(id).then(r => setEntry(r.entry)).catch(handleFetchError);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (run: () => Promise<unknown>, toast: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      showToast(toast);
      setVoiding(false);
      load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  // The phone has a PO page but no sell-order or case page.
  const poPath = entry?.target?.type === 'po' ? recordPath(entry) : null;
  const fact = (label: string, value: ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  return (
    <>
      <PhHeader
        title={id}
        scrolled={scrolled}
        leading={(
          <button className="ph-icon-btn" onClick={() => navigateBack('/accounting')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        )}
      />
      <div className="ph-scroll" ref={scrollRef}>
        {entry && (
          <>
            {entry.voided && (
              <div className="acct-banner" style={{ marginTop: 10 }}>
                {t('acctVoidedBy', { name: entry.voided.by ?? '—', reason: entry.voided.reason })}
              </div>
            )}
            <div className="acct-ph-hero">
              <div className="acct-hero-dir">{t('acctDir_' + entry.direction)} · {t('acctKind_' + entry.kind)}</div>
              <Yuan value={entry.amountCny} locale={locale} className={entry.direction === 'in' ? 'acct-in' : undefined} />
              {entry.currency === 'USD' && entry.fxRate !== null && (
                <div className="acct-sub">{t('acctUsdOriginal', { usd: fmtMoney(entry.amount, 'USD', locale), rate: entry.fxRate.toFixed(4) })}</div>
              )}
            </div>
            <div className="ph-card" style={{ padding: 14 }}>
              <dl className="acct-facts" style={{ gridTemplateColumns: '96px minmax(0, 1fr)' }}>
                {fact(t('acctFieldDate'), fmtBookDay(entry.occurredOn, locale, true))}
                {entry.kind !== 'other' && fact(t('acctFieldRecord'), entry.target ? (
                  <>
                    {poPath
                      ? <RouteLink to={poPath} className="mono rec-link">{entry.target.id}</RouteLink>
                      : <span className="mono">{entry.target.id}</span>}
                    {entry.targetFacts?.party && <span className="acct-sub">{entry.targetFacts.party}</span>}
                  </>
                ) : <span style={{ color: 'var(--fg-subtle)' }}>{t('acctRecordDeleted')}</span>)}
                {fact(t('acctFieldPaidBy'), entry.manager.name)}
                {fact(t('acctFieldMethod'), t('acctMethod_' + entry.method))}
                {entry.counterparty && fact(t('acctFieldCounterparty'), entry.counterparty)}
                {entry.reference && fact(t('acctFieldReference'), <span className="mono">{entry.reference}</span>)}
                {entry.note && fact(t('acctFieldNote'), <span style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</span>)}
              </dl>
            </div>

            {(!entry.voided || entry.attachments.length > 0) && (
              <>
                <div className="ph-section-h"><span>{t('acctScreenshots')}</span></div>
                <div className="ph-card" style={{ padding: 14, marginTop: 0 }}>
                  <AcctAttachments key={entry.id} entryId={entry.id} initial={entry.attachments} readOnly={!!entry.voided} onChanged={load} />
                </div>
              </>
            )}

            <div className="ph-section-h"><span>{t('acctHistory')}</span></div>
            <div className="ph-card acct-history" style={{ padding: 14, marginTop: 0 }}>
              {entry.events.map(e => <HistoryLine key={e.id} e={e} t={t} locale={locale} />)}
            </div>

            <div className="acct-ph-actions">
              {entry.voided ? (
                <button className="ph-btn dark" disabled={busy}
                        onClick={() => act(() => acctRestore(entry.id), t('acctRestoredToast', { id: entry.id }))}>
                  {t('acctRestore')}
                </button>
              ) : (
                <>
                  <button className="ph-btn ghost" style={{ color: 'var(--neg)' }} onClick={() => setVoiding(true)}>{t('acctVoid')}</button>
                  <button className="ph-btn dark" onClick={() => setEditing(true)}>{t('acctEdit')}</button>
                </>
              )}
            </div>
            <div style={{ height: 24 }} />
          </>
        )}
      </div>
      {editing && entry && (
        <PhAccountingSheet
          entry={entry}
          onClose={() => setEditing(false)}
          onAttachmentsChanged={load}
          onSaved={() => { setEditing(false); showToast(t('acctSavedToast', { id: entry.id })); load(); }}
        />
      )}
      {voiding && entry && (
        <PhVoidSheet
          busy={busy}
          onClose={() => setVoiding(false)}
          onConfirm={reason => act(() => acctVoid(entry.id, reason), t('acctVoidedToast', { id: entry.id }))}
        />
      )}
    </>
  );
}
