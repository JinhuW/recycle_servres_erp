import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseSerials } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import { LineSpecChips } from '../../components/LineSpecChips';
import { api } from '../../lib/api';
import {
  BOX_CHECK_REASONS, boxCheckReasonKey, checkBody, countOf, emptyCheck, lineState, matchScan, nextOpenAfter,
  orderLines, tally,
  type BoxCheckReason, type CheckExtra, type ChecksResponse, type LineCheck,
} from '../../lib/boxCheck';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { lineSpecLabel } from '../../lib/lineGroups';
import { linePhotos } from '../../lib/linePhotos';
import { statusTone } from '../../lib/status';
import type { Order, OrderLine } from '../../lib/types';

// Box check: the manager's bench view of one PO. Each line starts at its full
// qty and is ticked when found (or lowered and flagged when short); a ticked
// line sinks to the bottom so what is left to find stays on top. Progress lives on the server, so a reload or a
// second manager picks up where the count stands.

type Props = {
  order: Order;
  onExit: () => void;
  onApproved: () => Promise<void>;
  showToast: (msg: string, kind?: 'success' | 'error' | 'warn') => void;
};

type Undo = { lineId: string; prev: LineCheck; msg: string };
type ScanMsg = { tone: 'muted' | 'pos' | 'neg'; text: string; extra?: string };

const SAVE_DELAY_MS = 400;

export function DesktopBoxCheck({ order, onExit, onApproved, showToast }: Props) {
  const { t, locale } = useT();
  const lines = order.lines;
  const readOnly = order.archivedAt !== null;
  const atReviewing = order.lifecycle === 'reviewing';

  const [checks, setChecks] = useState<Map<string, LineCheck>>(new Map());
  const [extras, setExtras] = useState<CheckExtra[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(lines[0]?.id ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ reason: BoxCheckReason | null; note: string }>({ reason: null, note: '' });
  const [showDone, setShowDone] = useState(true);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<ScanMsg | null>(null);
  const [busy, setBusy] = useState<'approve' | 'send' | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [photoIdx, setPhotoIdx] = useState(0);

  const scanRef = useRef<HTMLInputElement | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<ChecksResponse>(`/api/orders/${order.id}/checks`);
      setChecks(new Map(r.lines.map(c => [c.lineId, c])));
      setExtras(r.extras);
    } catch (e) {
      handleFetchError(e);
    } finally {
      setLoaded(true);
    }
  }, [order.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  // Optimistic: the row moves the moment it is ticked, and a burst from a
  // scanner collapses into one write per line.
  const save = useCallback((next: LineCheck) => {
    setChecks(m => new Map(m).set(next.lineId, next));
    const pending = timers.current.get(next.lineId);
    if (pending) clearTimeout(pending);
    timers.current.set(next.lineId, setTimeout(() => {
      timers.current.delete(next.lineId);
      api.put<ChecksResponse>(`/api/orders/${order.id}/checks/${next.lineId}`, checkBody(next))
        .catch((e) => { handleFetchError(e); void load(); });
    }, SAVE_DELAY_MS));
  }, [order.id, load]);

  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);
  const checkOf = useCallback(
    (id: string) => checks.get(id) ?? emptyCheck(id, lineById.get(id)?.qty ?? 0),
    [checks, lineById],
  );

  const flashUndo = (u: Undo) => {
    setUndo(u);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  // The stepper only changes the number. Lowering a checked line takes the
  // tick away — the manager has to decide about the shortfall — and reaching
  // the qty never ticks on its own, because the count starts there.
  const setCount = (l: OrderLine, n: number) => {
    if (readOnly) return;
    const prev = checkOf(l.id);
    const counted = Math.max(0, Math.min(l.qty, n));
    if (counted === prev.counted) return;
    save({ ...prev, counted, checkedAt: counted < l.qty ? null : prev.checkedAt });
  };

  const check = (l: OrderLine) => {
    const prev = checkOf(l.id);
    const next: LineCheck = { ...prev, checkedAt: new Date().toISOString() };
    save(next);
    flashUndo({ lineId: l.id, prev, msg: t('bcCheckedToast', { pn: l.partNumber ?? lineLabel(l), n: countOf(l, prev), of: l.qty }) });
    setSelectedId(nextOpenAfter(lines, new Map(checks).set(l.id, next), l.id)?.id ?? l.id);
  };

  // A short line can't just be ticked: the shortfall goes to the purchaser as
  // a flag, so the tick opens the flag editor instead.
  const toggle = (l: OrderLine) => {
    if (readOnly) return;
    const c = checkOf(l.id);
    const state = lineState(l, c);
    if (state === 'flagged' || state === 'partial') { openFlag(l); return; }
    if (state === 'done') {
      save({ ...c, checkedAt: null });
      flashUndo({ lineId: l.id, prev: c, msg: t('bcUncheckedToast', { pn: l.partNumber ?? lineLabel(l) }) });
      return;
    }
    check(l);
  };

  const openFlag = (l: OrderLine) => {
    if (readOnly) return;
    const c = checkOf(l.id);
    setSelectedId(l.id);
    setEditingId(l.id);
    const short = c.counted < l.qty;
    setDraft(c.flagReason
      ? { reason: c.flagReason, note: c.flagNote ?? '' }
      : { reason: short ? 'short' : null, note: short ? t('bcShortNote', { n: c.counted, of: l.qty }) : '' });
  };

  const saveFlag = (l: OrderLine) => {
    if (!draft.reason) return;
    const prev = checkOf(l.id);
    const next = { ...prev, flagReason: draft.reason, flagNote: draft.note.trim() || null };
    save(next);
    setEditingId(null);
    flashUndo({ lineId: l.id, prev, msg: t('bcFlaggedToast', { pn: l.partNumber ?? lineLabel(l) }) });
    setSelectedId(nextOpenAfter(lines, new Map(checks).set(l.id, next), l.id)?.id ?? l.id);
  };

  const clearFlag = (l: OrderLine) => {
    const prev = checkOf(l.id);
    save({ ...prev, flagReason: null, flagNote: null });
    setEditingId(null);
  };

  const applyUndo = () => {
    if (!undo) return;
    save(undo.prev);
    setSelectedId(undo.lineId);
    setUndo(null);
  };

  const ordered = useMemo(() => orderLines(lines, checks), [lines, checks]);
  const sum = useMemo(() => tally(lines, checks), [lines, checks]);
  const remaining = ordered.open.length;
  const visible = useMemo(
    () => [...ordered.open, ...ordered.flagged, ...(showDone ? ordered.done : [])],
    [ordered, showDone],
  );
  const selected = (selectedId && lineById.get(selectedId)) || lines[0] || null;

  const checkAllRemaining = () => {
    if (readOnly) return;
    const now = Date.now();
    // Short lines are left for a decision; everything still at its full count
    // is ticked. Staggered stamps keep the batch in PO order inside Checked.
    ordered.open
      .filter(l => lineState(l, checks.get(l.id)) === 'open')
      .forEach((l, i) => save({ ...checkOf(l.id), checkedAt: new Date(now - i).toISOString() }));
    setUndo(null);
  };

  // ── Scanner: a USB/Bluetooth scanner types the label and presses Enter.
  const onScan = (raw: string) => {
    const text = raw.trim();
    setScan('');
    if (!text) return;
    const hit = matchScan(lines, checks, text);
    if (!hit) {
      setScanMsg({ tone: 'neg', text: t('bcScanNoMatch', { pn: text, id: order.id }), extra: text });
      return;
    }
    setSelectedId(hit.id);
    const pn = hit.partNumber ?? lineLabel(hit);
    const state = lineState(hit, checks.get(hit.id));
    if (state === 'done') {
      setScanMsg({ tone: 'neg', text: t('bcScanAlreadyChecked', { pn }), extra: text });
      return;
    }
    // A scan means "found it": a full line is ticked, a short or flagged one
    // opens its flag for the decision a tick would have asked for.
    if (state === 'open') {
      setScanMsg({ tone: 'pos', text: t('bcScanChecked', { pn }) });
      check(hit);
    } else {
      setScanMsg(null);
      openFlag(hit);
    }
    requestAnimationFrame(() => document.getElementById('bc-row-' + hit.id)?.scrollIntoView({ block: 'nearest' }));
  };

  const addExtra = async (partNumber: string) => {
    try {
      const r = await api.post<ChecksResponse>(`/api/orders/${order.id}/checks/extras`, { partNumber });
      setExtras(r.extras);
      setScanMsg({ tone: 'muted', text: t('bcExtraRecorded', { pn: partNumber }) });
    } catch (e) { handleFetchError(e); }
  };
  const removeExtra = async (x: CheckExtra) => {
    try {
      const r = await api.delete<ChecksResponse>(`/api/orders/${order.id}/checks/extras/${x.id}`);
      setExtras(r.extras);
    } catch (e) { handleFetchError(e); }
  };

  // Writes still waiting on their debounce go out before anything reads the
  // server's copy of the count.
  const flush = async () => {
    const ids = [...timers.current.keys()];
    ids.forEach(id => { clearTimeout(timers.current.get(id)); timers.current.delete(id); });
    await Promise.all(ids.map(id => api.put(`/api/orders/${order.id}/checks/${id}`, checkBody(checkOf(id)))));
  };

  const approve = async () => {
    setBusy('approve');
    try {
      await flush();
      // The page may have sat open while someone else moved the PO; a bare
      // advance from a stale Reviewing would skip a stage.
      const fresh = await api.get<{ order: Order }>(`/api/orders/${order.id}`);
      if (fresh.order.lifecycle !== 'reviewing') {
        showErrorDialog(t('bcStaleStage', { id: order.id, s: fresh.order.status }));
        return;
      }
      await api.post(`/api/orders/${order.id}/advance`, { toStage: 'ready_to_pay' });
      await onApproved();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('send');
    try {
      await flush();
      await api.post(`/api/orders/${order.id}/checks/send`, {});
      showToast(t('bcSentToast', { name: order.userName.split(' ')[0] ?? order.userName }));
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };

  // ── FLIP: a row that changes group slides from where it was.
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const lastTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const tops = new Map<string, number>();
    rowRefs.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top;
      tops.set(id, top);
      const was = lastTops.current.get(id);
      if (!reduce && was !== undefined && Math.abs(was - top) > 2 && el.animate) {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    lastTops.current = tops;
  }, [ordered, showDone, editingId]);

  // ── Keyboard. Ignored while typing, so the scan box and the note stay
  // plain text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightbox) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) {
        if (e.key === 'Escape' && target.id === 'bc-scan') target.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = visible.findIndex(l => l.id === selected?.id);
      const move = (d: number) => {
        const n = visible[Math.max(0, Math.min(visible.length - 1, i + d))];
        if (!n) return;
        setSelectedId(n.id);
        requestAnimationFrame(() => document.getElementById('bc-row-' + n.id)?.scrollIntoView({ block: 'nearest' }));
      };
      switch (e.key) {
        case 'ArrowDown': case 'j': e.preventDefault(); move(1); break;
        case 'ArrowUp': case 'k': e.preventDefault(); move(-1); break;
        case ' ':
          if (target?.closest('button')) return;
          e.preventDefault(); if (selected) toggle(selected); break;
        case '+': case '=': if (selected) setCount(selected, checkOf(selected.id).counted + 1); break;
        case '-': if (selected) setCount(selected, checkOf(selected.id).counted - 1); break;
        case 'f': case 'F': e.preventDefault(); if (selected) openFlag(selected); break;
        case '/': e.preventDefault(); scanRef.current?.focus(); break;
        case 'Escape': if (editingId) setEditingId(null); else onExit(); break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => { setPhotoIdx(0); }, [selected?.id]);

  const flaggedCount = ordered.flagged.length;
  const problems = flaggedCount + extras.length;

  const row = (l: OrderLine) => {
    const c = checkOf(l.id);
    const state = lineState(l, c);
    const shots = linePhotos(l);
    const isSel = selected?.id === l.id;
    const pn = l.partNumber ?? lineLabel(l);
    return (
      <Fragment key={l.id}>
        <tr
          id={'bc-row-' + l.id}
          ref={el => { if (el) rowRefs.current.set(l.id, el); else rowRefs.current.delete(l.id); }}
          className={'bc-row bc-' + state + (isSel ? ' row-selected' : '')}
          onClick={() => setSelectedId(l.id)}
        >
          <td className="bc-cb-cell">
            <button
              type="button"
              className="bc-cb"
              aria-pressed={state === 'done'}
              aria-label={t(state === 'done' ? 'bcUncheckLine' : 'bcCheckLine', { pn })}
              disabled={readOnly}
              onClick={e => { e.stopPropagation(); setSelectedId(l.id); toggle(l); }}
            >
              {state === 'done' && <Icon name="check" size={14} stroke={3} />}
              {state === 'flagged' && <Icon name="alert" size={13} />}
            </button>
          </td>
          <td className="bc-thumb-cell">
            {shots.length ? (
              <img className="bc-thumb" src={shots[0]!.url} alt="" />
            ) : (
              <span className="bc-thumb bc-thumb-empty"><Icon name={l.category === 'RAM' ? 'chip' : 'drive'} size={16} /></span>
            )}
          </td>
          <td>
            <div className="bc-pn mono">{pn}</div>
            <div className="bc-spec">
              <span>{lineLabel(l)}</span>
              <LineSpecChips line={l} />
            </div>
            {c.flagReason && (
              <div className="bc-flagnote">
                <Icon name="flag" size={11} /> {t(boxCheckReasonKey(c.flagReason))}
                {c.flagNote && <span className="muted"> · {c.flagNote}</span>}
              </div>
            )}
          </td>
          <td className="muted bc-cond">{l.condition}</td>
          <td className="num">
            <div className="bc-count" onClick={e => e.stopPropagation()}>
              <button type="button" className="btn ghost icon-only sm" aria-label={t('bcCountLess')}
                disabled={readOnly || c.counted === 0} onClick={() => { setSelectedId(l.id); setCount(l, c.counted - 1); }}>
                <Icon name="minus" size={13} />
              </button>
              <span className="mono bc-count-n">
                <b>{Math.min(c.counted, l.qty)}</b><span className="muted"> / {l.qty}</span>
              </span>
              <button type="button" className="btn ghost icon-only sm" aria-label={t('bcCountMore')}
                disabled={readOnly || c.counted >= l.qty} onClick={() => { setSelectedId(l.id); setCount(l, c.counted + 1); }}>
                <Icon name="plus" size={13} />
              </button>
            </div>
          </td>
          <td className="bc-flag-cell">
            <button
              type="button"
              className={'btn ghost icon-only sm bc-flagbtn' + (c.flagReason ? ' on' : '')}
              title={t('bcFlagTip')}
              aria-label={t('bcFlagTip')}
              disabled={readOnly}
              onClick={e => { e.stopPropagation(); if (editingId === l.id) setEditingId(null); else openFlag(l); }}
            >
              <Icon name="flag" size={13} />
            </button>
          </td>
        </tr>
        {editingId === l.id && (
          <tr className="bc-flag-row">
            <td colSpan={6}>
              <div className="bc-flag-edit">
                <div className="bc-flag-label">{t('bcFlagWhat', { pn })}</div>
                <div className="seg" role="radiogroup" aria-label={t('bcFlagWhat', { pn })}>
                  {BOX_CHECK_REASONS.map(r => (
                    <button key={r} type="button" role="radio" aria-checked={draft.reason === r}
                      className={draft.reason === r ? 'active' : ''}
                      onClick={() => setDraft(d => ({ ...d, reason: r }))}>
                      {t(boxCheckReasonKey(r))}
                    </button>
                  ))}
                </div>
                <input
                  id="bc-flag-note"
                  className="input"
                  type="text"
                  maxLength={500}
                  value={draft.note}
                  placeholder={t('bcFlagNotePh')}
                  onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') saveFlag(l); if (e.key === 'Escape') setEditingId(null); }}
                />
                <div className="bc-flag-actions">
                  {c.flagReason && (
                    <button type="button" className="btn sm" onClick={() => clearFlag(l)}>{t('bcRemoveFlag')}</button>
                  )}
                  <button type="button" className="btn sm" onClick={() => setEditingId(null)}>{t('cancel')}</button>
                  <button type="button" className="btn sm bc-btn-neg" disabled={!draft.reason} onClick={() => saveFlag(l)}>
                    <Icon name="flag" size={12} /> {t('bcFlagLine')}
                  </button>
                </div>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const selCheck = selected ? checkOf(selected.id) : null;
  const selShots = selected ? linePhotos(selected) : [];
  const selSerials = selected ? parseSerials(selected.serialNumber) : [];
  const shot = selShots[Math.min(photoIdx, selShots.length - 1)];

  return (
    <div className="bc-page">
      <div className="page-head">
        <div>
          <button type="button" className="bc-back" onClick={onExit}>
            <Icon name="chevronLeft" size={12} /> {t('bcBack')}
          </button>
          <div className="bc-title-row">
            <h1 className="page-title">{t('bcTitle')}</h1>
            <span className="mono bc-id">{order.id}</span>
            <span className={'chip dot ' + statusTone(order.status)}>{order.status}</span>
            <OrderCategoryChips categories={order.categories} max={3} />
          </div>
          <div className="page-sub">
            {[
              t('submittedBy') + ' ' + order.userName,
              order.warehouse?.short ?? null,
              order.package ? [order.package.carrier, order.package.trackingNumber].filter(Boolean).join(' ') : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="bc-keys" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('bcKeyMove')}</span>
          <span><kbd>Space</kbd> {t('bcKeyCheck')}</span>
          <span><kbd>+</kbd><kbd>−</kbd> {t('bcKeyCount')}</span>
          <span><kbd>F</kbd> {t('bcKeyFlag')}</span>
          <span><kbd>/</kbd> {t('bcKeyScan')}</span>
        </div>
      </div>

      {readOnly && (
        <div className="oe-banner bc-banner"><Icon name="lock" size={13} /> {t('bcArchived')}</div>
      )}

      <div className="card bc-tally">
        <div className="bc-tally-num">
          <span className="mono"><b>{sum.counted}</b><span className="muted"> / {sum.units}</span></span>
          <span className="card-sub">{t('bcUnitsCounted', { n: sum.done, of: lines.length })}</span>
        </div>
        <div className="bc-tally-meter">
          <div className="bc-meter" role="img" aria-label={t('bcUnitsCounted', { n: sum.done, of: lines.length })}>
            <i className="bc-m-done" style={{ flexGrow: sum.done }} />
            <i className="bc-m-part" style={{ flexGrow: sum.partial }} />
            <i className="bc-m-flag" style={{ flexGrow: sum.flagged }} />
            <i className="bc-m-open" style={{ flexGrow: sum.open }} />
          </div>
          <div className="bc-legend">
            <span className="chip pos dot">{t('bcLegendDone', { n: sum.done })}</span>
            <span className="chip warn dot">{t('bcLegendPartial', { n: sum.partial })}</span>
            <span className="chip neg dot">{t('bcLegendFlagged', { n: sum.flagged })}</span>
            <span className="chip muted dot">{t('bcLegendOpen', { n: sum.open })}</span>
          </div>
        </div>
        <button type="button" className="btn" disabled={readOnly || remaining === 0} onClick={checkAllRemaining}>
          <Icon name="check2" size={13} /> {t('bcCheckAll')}
        </button>
      </div>

      <div className="bc-grid">
        <div className="card bc-list-card">
          <div className="card-head bc-scan-head">
            <label className="bc-scan" htmlFor="bc-scan">
              <Icon name="scan" size={15} />
              <input
                id="bc-scan"
                ref={scanRef}
                className="input mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={scan}
                disabled={readOnly}
                placeholder={t('bcScanPh')}
                onChange={e => setScan(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onScan(scan); } }}
              />
            </label>
            <div className={'bc-scan-msg ' + (scanMsg?.tone ?? 'muted')} aria-live="polite">
              {scanMsg ? scanMsg.text : t('bcScanHint')}
              {scanMsg?.extra && !readOnly && (
                <button type="button" className="btn sm" onClick={() => void addExtra(scanMsg.extra!)}>
                  <Icon name="plus" size={12} /> {t('bcRecordExtra')}
                </button>
              )}
            </div>
          </div>
          {!loaded ? (
            <div className="card-body muted">{t('loadingApp')}</div>
          ) : (
            <table className="table bc-table">
              <thead>
                <tr>
                  <th className="bc-cb-cell" aria-label={t('bcColChecked')} />
                  <th className="bc-thumb-cell" aria-label={t('linePhotos')} />
                  <th>{t('bcColItem')}</th>
                  <th>{t('bcColCondition')}</th>
                  <th className="num">{t('bcColCounted')}</th>
                  <th className="bc-flag-cell" aria-label={t('bcFlagTip')} />
                </tr>
              </thead>
              <tbody>
                {ordered.open.map(row)}
                {remaining === 0 && (
                  <tr className="bc-group-empty"><td colSpan={6}>{t('bcAllResolved')}</td></tr>
                )}
                {ordered.flagged.length > 0 && (
                  <tr className="bc-group"><td colSpan={6}>{t('bcGroupFlagged')} <span className="mono muted">{ordered.flagged.length}</span></td></tr>
                )}
                {ordered.flagged.map(row)}
                {ordered.done.length > 0 && (
                  <tr className="bc-group">
                    <td colSpan={6}>
                      {t('bcGroupChecked')} <span className="mono muted">{ordered.done.length}</span>
                      <button type="button" className="bc-link" onClick={() => setShowDone(s => !s)}>
                        {showDone ? t('bcHide') : t('bcShow')}
                      </button>
                    </td>
                  </tr>
                )}
                {showDone && ordered.done.map(row)}
              </tbody>
            </table>
          )}
          {extras.length > 0 && (
            <div className="bc-extras">
              <div className="bc-extras-head">{t('bcExtrasTitle')}</div>
              {extras.map(x => (
                <div key={x.id} className="bc-extra">
                  <Icon name="alert" size={12} />
                  <span className="mono">{x.partNumber}</span>
                  {x.note && <span className="muted">{x.note}</span>}
                  {!readOnly && (
                    <button type="button" className="btn ghost icon-only sm" aria-label={t('delete')} onClick={() => void removeExtra(x)}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bc-side">
          {selected && selCheck && (
            <div className="card bc-compare">
              <div className="card-head"><span className="card-title">{t('bcCompareTitle')}</span>
                {selShots.length > 1 && <span className="card-sub mono">{Math.min(photoIdx, selShots.length - 1) + 1} / {selShots.length}</span>}
              </div>
              <div className="bc-photo">
                {shot ? (
                  <button type="button" className="bc-photo-btn" onClick={() => setLightbox(shot.url)} title={t('linePhotos')}>
                    <img src={shot.url} alt={t('linePhotos')} />
                  </button>
                ) : (
                  <div className="bc-photo-empty"><Icon name="image" size={20} /><span>{t('bcNoPhoto')}</span></div>
                )}
              </div>
              {selShots.length > 1 && (
                <div className="bc-photo-strip">
                  {selShots.map((p, i) => (
                    <button key={p.url} type="button" className={'bc-photo-pip' + (i === photoIdx ? ' on' : '')} onClick={() => setPhotoIdx(i)}>
                      <img src={p.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <div className="card-body bc-compare-body">
                <div className="bc-pn mono">{selected.partNumber ?? lineLabel(selected)}</div>
                <div className="card-sub">{lineLabel(selected)}</div>
                <dl className="bc-kv">
                  <dt>{t('bcColCondition')}</dt><dd>{selected.condition}</dd>
                  <dt>{t('bcExpected')}</dt><dd className="mono">{selected.qty}</dd>
                  <dt>{t('bcColCounted')}</dt><dd className="mono">{Math.min(selCheck.counted, selected.qty)}</dd>
                  <dt>{t('unitCost')}</dt><dd className="mono">{fmtUSD(selected.unitCost, locale)}</dd>
                  {selected.chipNumber && (<><dt>{t('bcChip')}</dt><dd className="mono">{selected.chipNumber}</dd></>)}
                </dl>
                <div className="bc-serials">
                  <div className="card-sub">{selSerials.length ? t('bcSerialsOnFile', { n: selSerials.length }) : t('bcNoSerials')}</div>
                  {selSerials.length > 0 && (
                    <div className="bc-serial-list">{selSerials.map(s => <span key={s} className="mono">{s}</span>)}</div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="card bc-finish">
            <div className="card-head"><span className="card-title">{t('bcFinishTitle')}</span></div>
            <div className="card-body">
              {remaining > 0 ? (
                <p className="card-sub">{t(remaining === 1 ? 'bcRemainingOne' : 'bcRemainingMany', { n: remaining })}</p>
              ) : problems > 0 ? (
                <>
                  <p className="card-sub">{t('bcSendIntro')}</p>
                  <ul className="bc-problem-list">
                    {ordered.flagged.map(l => {
                      const c = checkOf(l.id);
                      return (
                        <li key={l.id}>
                          <span className="mono">{l.partNumber ?? lineLabel(l)}</span> · {t(boxCheckReasonKey(c.flagReason ?? ''))}
                          {c.flagNote && <span className="muted"> ({c.flagNote})</span>}
                        </li>
                      );
                    })}
                    {extras.map(x => <li key={x.id}>{t('bcExtraItem', { pn: x.partNumber })}</li>)}
                  </ul>
                </>
              ) : (
                <p className="card-sub">{t(atReviewing ? 'bcAllMatch' : 'bcAllMatchNotReviewing', { n: lines.length, s: order.status })}</p>
              )}
              <div className="bc-finish-actions">
                {problems > 0 && (
                  <button type="button" className="btn bc-btn-neg" disabled={readOnly || busy !== null || remaining > 0} onClick={() => void send()}>
                    <Icon name="flag" size={13} /> {busy === 'send' ? '…' : t('bcSend')}
                  </button>
                )}
                {atReviewing && problems === 0 && (
                  <button type="button" className="btn accent" disabled={readOnly || busy !== null || remaining > 0} onClick={() => void approve()}>
                    <Icon name="check" size={13} /> {busy === 'approve' ? '…' : t('bcApprove')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {undo && (
        <div className="toast-wrap">
          <div className="toast info bc-undo">
            <Icon name="check2" size={16} />
            <span>{undo.msg}</span>
            <button type="button" onClick={applyUndo}>{t('bcUndo')}</button>
          </div>
        </div>
      )}
      {lightbox && <ImageLightbox url={lightbox} alt={t('linePhotos')} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function lineLabel(l: OrderLine): string {
  return lineSpecLabel(l) || l.description || l.category;
}
