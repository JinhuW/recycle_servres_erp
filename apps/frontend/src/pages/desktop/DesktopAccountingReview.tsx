import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCOUNTING_QUERY_MAX, ACCOUNTING_REVIEW_TABS, hasAccountingWarning, type AccountingReviewTab,
} from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { RouteLink } from '../../components/RouteLink';
import { Yuan, recordPath } from '../../components/AccountingBits';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, fmtMoney } from '../../lib/format';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useManagerOptions, useMemberNames } from '../../lib/useManagers';
import { navigate } from '../../lib/route';
import {
  ACCT_BULK_MAX, acctAnswer, acctAsk, acctBulkReview, acctMarkReviewed, acctReviewQueue, acctWithdrawQuery, acctWithdrawReview,
  fmtBookDay, fmtCny, markDayStarts, reviewActions, type AcctReviewQueue, type AcctReviewRow,
} from '../../lib/accounting';
import { ChangeList, ReviewMark, checkLines, rowChip } from './accounting/reviewBits';
import { EntryDrawer } from './accounting/EntryDrawer';
import '../../styles/accounting.css';

type Props = { onToast?: (msg: string, kind?: 'success' | 'error') => void };

// What an action did, so the page's own toast can put it back.
type Undo = { text: string; run: () => Promise<unknown> };

// Review mode for the RMB book: the PO's Review mode, pointed at entries. The
// list is a queue, oldest first and not scoped by period; the side panel says
// what the selected entry is weighed against; a sign-off sinks the row under
// "Reviewed in this visit" with an Undo. Every rule the buttons follow is the
// API's, through reviewActions.
export function DesktopAccountingReview({ onToast }: Props) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const me = user?.id ?? '';
  const managers = useManagerOptions();
  const people = useMemberNames();
  const [tab, setTab] = useState<AccountingReviewTab>('mine');
  const [managerId, setManagerId] = useState('');
  // The For you list is always loaded: the tally and the tab counts read it
  // whatever tab is up. Another tab's list is kept with the tab it is for.
  const [mine, setMine] = useState<AcctReviewQueue | null>(null);
  const [other, setOther] = useState<{ tab: AccountingReviewTab; queue: AcctReviewQueue } | null>(null);
  // Signed off in this visit, newest first; questions asked in it.
  const [done, setDone] = useState<AcctReviewRow[]>([]);
  const [asked, setAsked] = useState<AcctReviewRow[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'query' | 'answer'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // For you depends on the filter alone, so a tab switch reads just the tab.
  const genMine = useRef(0);
  const genOther = useRef(0);
  const loadMine = useCallback(() => {
    const g = ++genMine.current;
    acctReviewQueue('mine', managerId || undefined)
      .then(m => { if (g === genMine.current) setMine(m); })
      .catch(handleFetchError);
  }, [managerId]);
  const loadOther = useCallback(() => {
    const g = ++genOther.current;
    if (tab === 'mine') return;
    acctReviewQueue(tab, managerId || undefined, { counts: false })
      .then(q => { if (g === genOther.current) setOther({ tab, queue: q }); })
      .catch(handleFetchError);
  }, [tab, managerId]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadOther(); }, [loadOther]);
  const load = useCallback(() => { loadMine(); loadOther(); }, [loadMine, loadOther]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  // The Undo toast outlives the render that made it: its action re-reads the
  // lists the page shows now, and a second press while one runs does nothing.
  const loadRef = useRef(load);
  loadRef.current = load;
  const busyRef = useRef(false);

  const queue = tab === 'mine' ? mine : other?.tab === tab ? other.queue : null;
  const rows = useMemo(() => queue?.rows ?? [], [queue]);

  // What the lists, the tally and the bulk dialog show, worked out once per
  // change rather than on every keystroke in the question box.
  const view = useMemo(() => {
    const rowIds = new Set(rows.map(r => r.id));
    const doneIds = new Set(done.map(d => d.id));
    // Rows signed off here stay on the page until it is left, under the divider.
    const doneRows = tab === 'mine' ? done.filter(d => !rowIds.has(d.id)) : [];
    // The tally counts this visit's For you queue: what is left in it, plus
    // what was signed off or queried from it.
    const pending = mine?.rows ?? [];
    const pendingIds = new Set(pending.map(p => p.id));
    const tallied = [...pending, ...done.filter(d => !pendingIds.has(d.id)),
      ...asked.filter(a => !pendingIds.has(a.id) && !doneIds.has(a.id))];
    // Bulk: from the For you queue whatever tab is up — To review, never
    // changed or queried, no warning, and not the viewer's.
    const bulk = pending
      .filter(r => r.review?.state === 'open' && !hasAccountingWarning(r.checks) && reviewActions(r, me).review);
    const bulkIds = new Set(bulk.map(r => r.id));
    const cny = (list: AcctReviewRow[]) => list.reduce((a, r) => a + r.amountCny, 0);
    return {
      doneIds, doneRows, visible: [...rows, ...doneRows], tallied, bulk,
      held: pending.filter(r => !bulkIds.has(r.id)),
      sum: {
        done: done.length,
        queried: asked.filter(a => !doneIds.has(a.id)).length,
        changed: pending.filter(r => r.review?.state === 'changed').length,
        open: pending.filter(r => r.review?.state === 'open').length,
      },
      cnyTotal: cny(tallied),
      cnyDone: cny(done),
      leftIn: cny(pending.filter(r => r.direction === 'in')),
      leftOut: cny(pending.filter(r => r.direction === 'out')),
    };
  }, [rows, tab, done, asked, mine, me]);
  const { doneRows, visible, tallied, bulk, held, sum, cnyTotal, cnyDone, leftIn, leftOut } = view;
  const sel = visible.find(r => r.id === selId) ?? rows[0] ?? doneRows[0] ?? null;
  // A question or an answer is about the entry it was opened on: moving off
  // it, by click or key, drops what was typed rather than sending it elsewhere.
  const selKey = sel?.id ?? null;
  useEffect(() => { setForm(null); setText(''); }, [selKey]);

  const flash = (u: Undo) => {
    setUndo(u);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };

  // The row after `id` in the list as it stands, for the selection to move on to.
  const nextAfter = (id: string) => {
    const i = rows.findIndex(r => r.id === id);
    return rows[i + 1]?.id ?? rows[i - 1]?.id ?? null;
  };

  // Every write re-reads the lists: a refusal usually means the entry moved
  // under the reviewer, and they should see what it is now.
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      setForm(null);
      setText('');
      after?.();
      return true;
    } catch (e) {
      handleFetchError(e);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      loadRef.current();
    }
  };

  // A row signed off here, as it now stands, for the divider below the queue.
  const signed = (row: AcctReviewRow): AcctReviewRow => ({
    ...row,
    review: row.review && {
      ...row.review, state: 'reviewed', by: user ? { id: user.id, name: user.name } : null,
      at: new Date().toISOString(), query: null,
    },
  });

  const mark = (row: AcctReviewRow) => {
    if (!row.review || !reviewActions(row, me).review) return;
    const next = nextAfter(row.id);
    void run(() => acctMarkReviewed(row.id, row.review!.version), () => {
      if (tab === 'mine') setDone(d => [signed(row), ...d.filter(x => x.id !== row.id)]);
      setSelId(tab === 'mine' ? next : row.id);
      flash({ text: t('acctReviewedToast', { id: row.id }), run: () => unmark(row) });
    });
  };

  const unmark = (row: AcctReviewRow) => run(() => acctWithdrawReview(row.id), () => {
    setDone(d => d.filter(x => x.id !== row.id));
    setSelId(row.id);
    setUndo(null);
  });

  const ask = (row: AcctReviewRow, question: string) => {
    const name = row.review?.author?.name ?? row.manager.name;
    const next = nextAfter(row.id);
    void run(() => acctAsk(row.id, question), () => {
      setAsked(a => [row, ...a]);
      setSelId(next);
      flash({
        text: t('acctQueriedToast', { name }),
        run: () => run(() => acctWithdrawQuery(row.id), () => { setAsked(a => a.filter(x => x.id !== row.id)); setUndo(null); }),
      });
    });
  };

  const confirmBulk = () => {
    const ids = new Set(bulk.map(r => r.id));
    void run(async () => {
      let reviewedN = 0;
      let skippedN = 0;
      // Each batch lands on the page as it goes, so a refusal part-way keeps
      // what was already signed off.
      for (let i = 0; i < bulk.length; i += ACCT_BULK_MAX) {
        const part = bulk.slice(i, i + ACCT_BULK_MAX);
        const res = await acctBulkReview(part.map(r => ({ id: r.id, version: r.review!.version })));
        const reviewed = new Set(res.reviewed);
        setDone(d => [...part.filter(r => reviewed.has(r.id)).map(signed), ...d]);
        reviewedN += res.reviewed.length;
        skippedN += res.skipped.length;
      }
      setTab('mine');
      setBulkOpen(false);
      onToast?.(skippedN
        ? t('acctBulkSkippedToast', { n: reviewedN, skipped: skippedN })
        : t('acctBulkToast', { n: reviewedN }));
    }, () => setSelId(rows.find(r => !ids.has(r.id))?.id ?? null));
  };

  const exit = () => navigate('/accounting');
  // The drawer and the bulk dialog sit above on the Escape stack, so they
  // close first; the page leaves only when it is the top layer.
  useEscapeKey(() => {
    if (form) { setForm(null); setText(''); } else exit();
  });

  // ── Keyboard, ignored while typing or under a dialog. One listener for the
  // page's life, reading the render it fires in through the ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  onKey.current = (e: KeyboardEvent) => {
    if (openEntry || bulkOpen || document.querySelector('[aria-modal="true"]')) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const i = visible.findIndex(r => r.id === sel?.id);
    const move = (d: number) => {
      const n = visible[Math.max(0, Math.min(visible.length - 1, i + d))];
      if (!n) return;
      setSelId(n.id);
      requestAnimationFrame(() => document.getElementById('arv-row-' + n.id)?.scrollIntoView({ block: 'nearest' }));
    };
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); move(1); break;
      case 'ArrowUp': case 'k': e.preventDefault(); move(-1); break;
      case ' ':
        if (target?.closest('button') && !target.closest('.arv-rows')) return;
        e.preventDefault();
        if (target?.closest('button')) target.blur();
        if (sel) mark(sel);
        break;
      case 'q': if (sel && reviewActions(sel, me).query) { e.preventDefault(); setForm('query'); } break;
      case 'e': if (sel) { e.preventDefault(); setOpenEntry(sel.id); } break;
      case 'u': if (undo) { e.preventDefault(); void undo.run(); } break;
    }
  };

  const can = sel ? reviewActions(sel, me) : null;
  const addressee = sel ? (sel.review?.query?.to?.name ?? sel.review?.author?.name ?? sel.manager.name) : '';
  const counts = mine?.counts;
  const tabCount = (k: AccountingReviewTab) => counts?.[k] ?? 0;
  const bulkTitle = t('acctRmBulkTitle', { n: bulk.length });

  return (
    <div className="bc-page arv-page">
      <div className="page-head">
        <div>
          <button type="button" className="bc-back" onClick={exit}>
            <Icon name="chevronLeft" size={12} /> {t('acctTitle')}
          </button>
          <div className="bc-title-row">
            <h1 className="page-title">{t('acctReviewMode')}</h1>
            <span className="bc-id">{t('acctTitle')}</span>
            {user && <span className="chip muted">{t('acctRmAs', { name: user.name })}</span>}
          </div>
          <div className="page-sub">{t('acctRmSub')}</div>
        </div>
        <div className="arv-head-right">
          <RouteLink to="/activity?area=acct" className="btn sm" title={t('acctLogHint')}>
            <Icon name="note" size={13} /> {t('acctLog')}
          </RouteLink>
          <div className="bc-keys" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> {t('acctRmKeyMove')}</span>
            <span><kbd>{t('bcKeySpace')}</kbd> {t('acctMarkReviewed')}</span>
            <span><kbd>Q</kbd> {t('acctRmKeyQuery')}</span>
            <span><kbd>E</kbd> {t('acctRmKeyOpen')}</span>
            <span><kbd>U</kbd> {t('undo')}</span>
            <span><kbd>Esc</kbd> {t('acctRmKeyLeave')}</span>
          </div>
        </div>
      </div>

      <div className="card bc-tally">
        <div className="bc-tally-half">
          <div className="bc-tally-num">
            <span className="mono"><b>{sum.done}</b><span className="muted"> / {tallied.length}</span></span>
            <span className="card-sub">{t('acctRmReviewedCount', { n: tallied.length })}</span>
          </div>
          <div className="bc-tally-meter">
            <div className="bc-meter" role="img" aria-label={`${sum.done} / ${tallied.length}`}>
              <i className="bc-m-done" style={{ flexGrow: sum.done }} />
              <i className="bc-m-part" style={{ flexGrow: sum.changed }} />
              <i className="bc-m-query" style={{ flexGrow: sum.queried }} />
              <i className="bc-m-open" style={{ flexGrow: sum.open }} />
            </div>
            <div className="bc-legend">
              <span className="chip pos dot">{t('acctRmLegendReviewed', { n: sum.done })}</span>
              <span className="chip warn dot">{t('acctRmLegendChanged', { n: sum.changed })}</span>
              <span className="chip info dot">{t('acctRmLegendQueried', { n: sum.queried })}</span>
              <span className="chip muted dot">{t('acctRmLegendOpen', { n: sum.open })}</span>
            </div>
          </div>
          <span />
        </div>
        <div className="bc-tally-half bc-tally-money">
          <div className="bc-tally-num">
            <span className="mono"><b>{fmtCny(cnyDone, locale)}</b></span>
            <span className="card-sub">{t('acctRmOfMoney', { total: fmtCny(cnyTotal, locale) })}</span>
          </div>
          <div className="bc-tally-meter">
            <div className="bc-meter" role="img" aria-label={t('acctRmOfMoney', { total: fmtCny(cnyTotal, locale) })}>
              <i className="bc-m-done" style={{ flexGrow: cnyDone }} />
              <i className="bc-m-open" style={{ flexGrow: Math.max(0, cnyTotal - cnyDone) }} />
            </div>
            <div className="arv-left">
              {t('acctRmLeft', { in: fmtCny(leftIn, locale), out: fmtCny(leftOut, locale) })}
            </div>
          </div>
          <div className="bc-tally-actions arv-bulk">
            <button type="button" className="btn" disabled={busy || bulk.length === 0} onClick={() => setBulkOpen(true)}>
              <Icon name="check2" size={13} /> {t('acctRmBulk', { n: bulk.length })}
            </button>
            <span className="arv-hint">{t('acctRmBulkHint')}</span>
          </div>
        </div>
      </div>

      <div className="bc-grid arv-grid">
        <div className="card">
          <div className="card-head arv-list-head">
            <div className="seg" role="group" aria-label={t('acctReviewMode')}>
              {ACCOUNTING_REVIEW_TABS.map(k => (
                <button key={k} type="button" className={tab === k ? 'active' : ''} aria-pressed={tab === k}
                        onClick={() => { setTab(k); setSelId(null); setForm(null); }}>
                  {t('acctRmTab_' + k)} <span className="arv-seg-n">{tabCount(k)}</span>
                </button>
              ))}
            </div>
            <select className="select arv-mgr" value={managerId} aria-label={t('acctFieldPaidBy')}
                    onChange={e => setManagerId(e.target.value)}>
              <option value="">{t('acctAllManagers')}</option>
              {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>

          {queue && rows.length === 0 && (
            <div className="arv-empty">
              {tab === 'mine' && <span className="arv-empty-mark"><Icon name="check" size={18} /></span>}
              <b>{t('acctRmEmpty_' + tab)}</b>
              <span>{t('acctRmEmptyHint_' + tab)}</span>
            </div>
          )}

          {(rows.length > 0 || doneRows.length > 0) && (
            <div className="arv-scroll">
              {rows.length > 0 && (
                <>
                  <div className="arv-hdr" aria-hidden="true">
                    <span /><span>{t('acctColDate')}</span><span>{t('acctColEntry')}</span><span>{t('acctFieldKind')}</span>
                    <span className="acct-num">{t('acctReceived')}</span><span className="acct-num">{t('acctPaid')}</span>
                    <span>{t('acctRmColChecks')}</span>
                  </div>
                  <div className="arv-rows">{renderRows(rows)}</div>
                </>
              )}
              {doneRows.length > 0 && (
                <>
                  <div className="arv-divider"><Icon name="check" size={12} /> {t('acctRmDoneDivider', { n: doneRows.length })}</div>
                  <div className="arv-rows">{renderRows(doneRows, true)}</div>
                </>
              )}
              {queue?.truncated && <div className="arv-truncated">{t('acctRmTruncated', { n: rows.length })}</div>}
            </div>
          )}
        </div>

        <aside className="bc-side" aria-label={sel?.id}>
          {!sel && queue && rows.length > 0 && <div className="card arv-none">{t('acctRmNoSelection')}</div>}
          {sel && can && (
            <>
              <div className="card">
                <div className="card-head">
                  <span className="card-title mono">{sel.id}</span>
                  {sel.review && (
                    <span className={'chip dot ' + ({ open: 'muted', changed: 'warn', queried: 'info', reviewed: 'pos' }[sel.review.state])}>
                      {can.own && sel.review.state !== 'queried' ? t('acctRvYours') : t('acctReviewState_' + sel.review.state)}
                    </span>
                  )}
                </div>
                <div className="arv-side-body">
                  <div className="acct-hero">
                    <div className="acct-hero-dir">{t('acctDir_' + sel.direction)} · {t('acctKind_' + sel.kind)}</div>
                    <Yuan value={sel.amountCny} locale={locale} className={sel.direction === 'in' ? 'acct-in' : undefined} />
                    {sel.currency === 'USD' && sel.fxRate !== null && (
                      <div className="acct-sub">{t('acctUsdOriginal', { usd: fmtMoney(sel.amount, 'USD', locale), rate: sel.fxRate.toFixed(4) })}</div>
                    )}
                  </div>
                  <dl className="acct-facts arv-facts">
                    <dt>{t('acctFieldDate')}</dt><dd>{fmtBookDay(sel.occurredOn, locale, true)}</dd>
                    {sel.kind !== 'other' && (
                      <>
                        <dt>{t('acctFieldRecord')}</dt>
                        <dd>
                          {sel.target && recordPath(sel)
                            ? <RouteLink to={recordPath(sel)!} className="mono rec-link">{sel.target.id}</RouteLink>
                            : t('acctRecordDeleted')}
                          {sel.targetFacts?.party && <span className="acct-sub">{sel.targetFacts.party}</span>}
                        </dd>
                      </>
                    )}
                    <dt>{t('acctFieldPaidBy')}</dt><dd>{sel.manager.name}</dd>
                    <dt>{t('acctFieldMethod')}</dt><dd>{t('acctMethod_' + sel.method)}</dd>
                    {sel.counterparty && <><dt>{t('acctFieldCounterparty')}</dt><dd>{sel.counterparty}</dd></>}
                    {sel.reference && <><dt>{t('acctFieldReference')}</dt><dd className="mono">{sel.reference}</dd></>}
                    {sel.note && <><dt>{t('acctFieldNote')}</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{sel.note}</dd></>}
                    <dt>{t('acctRmRecorded')}</dt>
                    <dd>{sel.review?.author?.name ?? t('acctRmBackfilled')} · {fmtDate(sel.createdAt, locale)}</dd>
                  </dl>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title"><Icon name="shield" size={14} /> {t('acctRmChecks')}</span>
                  <span className="card-sub">{t('acctRmChecksSub')}</span>
                </div>
                <div className="arv-checks">
                  {sel.checks.map((c, i) => {
                    const l = checkLines(c, sel, t, locale);
                    return (
                      <div key={i} className={'arv-check ' + c.tone}>
                        <Icon name={c.tone === 'ok' ? 'check' : c.tone === 'warn' ? 'alert' : 'minus'} size={14} />
                        <span><b>{l.head}</b> {l.text}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {sel.review?.state === 'changed' && sel.cleared && (
                <div className="card">
                  <div className="card-head">
                    <span className="card-title">
                      {sel.cleared.reviewer ? t('acctRmChangedSince', { name: sel.cleared.reviewer.name }) : t('acctTickChangedNobody')}
                    </span>
                    <span className="card-sub">{fmtDate(sel.cleared.at, locale)}</span>
                  </div>
                  <ChangeList changes={sel.cleared.changes} people={people} t={t} locale={locale} className="arv-diff" />
                </div>
              )}

              {sel.review?.query && (
                <div className="card">
                  <div className="card-head"><span className="card-title"><Icon name="chats" size={14} /> {t('acctRmQuestion')}</span></div>
                  <div className="arv-qa">
                    <div>
                      <span className="arv-qa-who">{sel.review.query.by?.name ?? '—'}</span>
                      <span className="arv-qa-when">{fmtDate(sel.review.query.at, locale)}</span>
                      <div className="arv-qa-text">{sel.review.query.text}</div>
                    </div>
                    {sel.review.query.answer ? (
                      <div>
                        <span className="arv-qa-who">
                          {sel.review.query.answer.text === null
                            ? t('acctRvAnsweredByEdit', { name: sel.review.query.answer.by?.name ?? '—' })
                            : sel.review.query.answer.by?.name ?? '—'}
                        </span>
                        <span className="arv-qa-when">{fmtDate(sel.review.query.answer.at, locale)}</span>
                        {sel.review.query.answer.text && <div className="arv-qa-text">{sel.review.query.answer.text}</div>}
                      </div>
                    ) : (
                      <div className="arv-qa-wait">
                        {can.answer ? t('acctRvQueriedFoot') : t('acctRmWaitingAnswer', { name: addressee })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="card arv-act">
                {form ? (
                  <div className="arv-form">
                    <label className="label" htmlFor="arv-text">
                      {form === 'query' ? t('acctQueryLabel', { name: addressee }) : t('acctAnswerLabel', { name: sel.review?.query?.by?.name ?? '—' })}
                    </label>
                    <textarea id="arv-text" className="input" rows={3} autoFocus maxLength={ACCOUNTING_QUERY_MAX}
                              placeholder={form === 'query' ? t('acctQueryPh') : undefined}
                              value={text} onChange={e => setText(e.target.value)} />
                    <div className="arv-act-row">
                      <button type="button" className="btn" disabled={busy} onClick={() => { setForm(null); setText(''); }}>{t('cancel')}</button>
                      <button type="button" className="btn accent" disabled={busy || !text.trim()}
                              onClick={() => (form === 'query'
                                ? ask(sel, text.trim())
                                : void run(() => acctAnswer(sel.id, text.trim()), () => onToast?.(t('acctAnsweredToast'))))}>
                        {form === 'query' ? t('acctSendQuery') : t('acctSendAnswer')}
                      </button>
                    </div>
                  </div>
                ) : can.own ? (
                  // The author's own entry: nothing to sign, but a question to them is theirs to answer.
                  <div className="arv-own">
                    <div className="arv-own-line"><ReviewMark state="open" own size={20} /> {t('acctRmOwn')}</div>
                    <div className="arv-note">{t('acctRmOwnNote')}</div>
                    <div className="arv-act-row">
                      <button type="button" className="btn" onClick={() => setOpenEntry(sel.id)}>
                        <Icon name="edit" size={13} /> {t('acctRmKeyOpen')}
                      </button>
                      {can.answer && (
                        <button type="button" className="btn accent" disabled={busy} onClick={() => setForm('answer')}>
                          <Icon name="chats" size={13} /> {t('acctAnswerBtn')}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {sel.review?.state === 'reviewed' && (
                      <div className="arv-own-line">
                        <ReviewMark state="reviewed" size={20} />
                        {sel.review.by?.id === me ? t('acctRvReviewedByYou') : t('acctRvReviewedBy', { name: sel.review.by?.name ?? '—' })}
                        {sel.review.at && <span className="arv-qa-when">{fmtDate(sel.review.at, locale)}</span>}
                      </div>
                    )}
                    <div className="arv-act-row">
                      <button type="button" className="btn ghost arv-grow" onClick={() => setOpenEntry(sel.id)}>
                        <Icon name="arrow" size={13} /> {t('acctRmKeyOpen')}
                      </button>
                      {can.query && <button type="button" className="btn" disabled={busy} onClick={() => setForm('query')}>
                        <Icon name="chats" size={13} /> {t('acctQueryBtn')}
                      </button>}
                      {can.answer && <button type="button" className="btn" disabled={busy} onClick={() => setForm('answer')}>
                        {t('acctAnswerBtn')}
                      </button>}
                      {can.withdrawQuery && <button type="button" className="btn" disabled={busy}
                        onClick={() => void run(() => acctWithdrawQuery(sel.id), () => onToast?.(t('acctQueryWithdrawnToast')))}>
                        {t('acctWithdrawQuery')}
                      </button>}
                      {can.withdraw && (
                        <button type="button" className="btn" disabled={busy}
                                onClick={() => (view.doneIds.has(sel.id) ? void unmark(sel)
                                  : void run(() => acctWithdrawReview(sel.id), () => onToast?.(t('acctUnreviewedToast', { id: sel.id }))))}>
                          {t('acctWithdrawReview')}
                        </button>
                      )}
                      {can.review && (
                        <button type="button" className="btn accent" disabled={busy} onClick={() => mark(sel)}>
                          <Icon name="check" size={13} /> {sel.review?.state === 'changed' ? t('acctReviewAgain') : t('acctMarkReviewed')}
                        </button>
                      )}
                    </div>
                    {can.review && (
                      <div className="arv-note">
                        {sel.review?.state === 'queried' ? t('acctRmMarkNoteQueried') : t('acctRmMarkNote', { name: user?.name ?? '' })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      {undo && (
        <div className="arv-toast" role="status">
          <span>{undo.text}</span>
          <button type="button" onClick={() => void undo.run()}>{t('undo')}</button>
        </div>
      )}

      {bulkOpen && (
        <Modal onClose={() => { if (!busy) setBulkOpen(false); }} shellStyle={{ maxWidth: 480 }}
               ariaLabel={bulkTitle}>
          <div className="modal-head"><div className="modal-title">{bulkTitle}</div></div>
          <div className="modal-body arv-bulk-body">
            <p>{t('acctRmBulkBody')}</p>
            <div className="arv-bulk-list">
              {bulk.map(r => (
                <div key={r.id}>
                  <span><span className="mono">{r.id}</span> · {t('acctKind_' + r.kind)}{r.target ? ' ' + r.target.id : ''} · {t('acctMethod_' + r.method)}</span>
                  <Yuan value={r.amountCny} locale={locale} />
                </div>
              ))}
              <div className="arv-bulk-total">
                <span>{t('acctRmBulkTotal', { n: bulk.length })}</span>
                <Yuan value={bulk.reduce((a, r) => a + r.amountCny, 0)} locale={locale} />
              </div>
            </div>
            {held.length > 0 && <p>{t('acctRmBulkLeft', { ids: held.map(r => r.id).join(', ') })}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" disabled={busy} onClick={() => setBulkOpen(false)}>{t('cancel')}</button>
            <button type="button" className="btn accent" disabled={busy} onClick={confirmBulk}>{t('acctRmBulk', { n: bulk.length })}</button>
          </div>
        </Modal>
      )}

      {openEntry && (
        <EntryDrawer id={openEntry} onClose={() => setOpenEntry(null)} onChanged={load} onToast={m => onToast?.(m)} />
      )}
    </div>
  );

  // A plain function, not a component: one defined in render would remount
  // the whole list, focus and all, on every keystroke.
  function renderRows(list: AcctReviewRow[], isDone = false) {
    const starts = markDayStarts(list);
    return (
      <>
        {list.map((r, i) => {
          const a = reviewActions(r, me);
          const state = r.review?.state ?? 'open';
          const chip = rowChip(r, t, locale);
          const by = r.review?.author?.name;
          return (
            <div key={r.id} id={'arv-row-' + r.id}
                 className={'arv-row' + (starts[i] ? ' arv-daystart' : '') + (r.id === sel?.id ? ' sel' : '') + (isDone ? ' done' : '')}
                 onClick={() => { setSelId(r.id); setForm(null); }}>
              <span>
                {isDone ? <ReviewMark state="reviewed" />
                  : (
                    <button type="button" className="arv-mark-btn" disabled={!a.review || busy}
                            aria-label={a.review ? t('acctMarkReviewed') + ' ' + r.id : t('acctRvYours')}
                            title={a.review ? t('acctMarkReviewed') : t('acctRvYoursDetail')}
                            onClick={e => { e.stopPropagation(); mark(r); }}>
                      <ReviewMark state={state} own={a.own} />
                    </button>
                  )}
              </span>
              <span className="acct-date">{starts[i] ? fmtBookDay(r.occurredOn, locale) : ''}</span>
              <span>
                <button type="button" className="arv-pick" onClick={e => { e.stopPropagation(); setSelId(r.id); }}>{r.id}</button>
                <span className="acct-sub">
                  {r.review?.state === 'changed' && r.cleared?.followedPo ? t('acctEvSyncedPo')
                    : by ? t(r.review?.state === 'changed' ? 'acctRmChangedBy' : 'acctRmBy', { name: by }) : t('acctRmBackfilled')}
                </span>
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="acct-for">
                  <span className="acct-for-kind">{t('acctKind_' + r.kind)}</span>
                  {r.target && <span className="mono">{r.target.id}</span>}
                  {r.counterparty && <span className="acct-for-party">{r.counterparty}</span>}
                </span>
                <span className="acct-sub arv-ellipsis">{[t('acctMethod_' + r.method), r.note].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="acct-num">
                {r.direction === 'in' && <Yuan value={r.amountCny} locale={locale} className={isDone ? undefined : 'acct-in'} />}
              </span>
              <span className="acct-num">
                {r.direction === 'out' && <Yuan value={r.amountCny} locale={locale} />}
              </span>
              <span>
                {isDone ? (
                  <button type="button" className="arv-undo" disabled={busy} onClick={e => { e.stopPropagation(); void unmark(r); }}>
                    {t('undo')}
                  </button>
                ) : chip.label && <span className={'chip ' + chip.tone}>{chip.label}</span>}
              </span>
            </div>
          );
        })}
      </>
    );
  }
}
