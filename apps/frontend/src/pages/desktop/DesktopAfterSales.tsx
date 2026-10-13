import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, addAfterSalesNote, afterSalesSummary, createAfterSalesCase, getAfterSalesCase, listAfterSalesCases,
  patchAfterSalesCase, setAfterSalesStatus,
  type AfterSalesCase, type AfterSalesResolution, type AfterSalesRow, type AfterSalesStatus,
} from '../../lib/api';
import { forEachKeysetPage } from '../../lib/keysetPages';
import { useT } from '../../lib/i18n';
import { handleFetchError } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { statusTone } from '../../lib/status';
import {
  afterSalesCasePath, afterSalesNewPath, hrefFor, match, navigate, navigateBack, onLinkClick, readHashQuery, useRoute,
} from '../../lib/route';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { sellOrderStatusShort } from '../../lib/lookups';
import { useManagerOptions } from '../../lib/useManagers';
import {
  AFTER_SALES_RESOLUTIONS as RESOLUTIONS, AFTER_SALES_STATUSES as STATUSES, CASEABLE_SELL_STATUSES,
} from '@recycle-erp/shared';

const CLOSED = new Set<string>(['Resolved', 'Cancelled']);

const statusKey = (s: string) => 'asStatus_' + s.replace(/ /g, '_');

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function DesktopAfterSales({ onToast }: Props = {}) {
  const { path } = useRoute();
  const m = match('/after-sales/:id', path);
  if (m?.id === 'new') return <NewCaseForm onToast={onToast} />;
  if (m?.id) return <CaseDetail id={m.id} onToast={onToast} />;
  return <CaseList />;
}

function StatusChip({ status }: { status: string }) {
  const { t } = useT();
  return <span className={'chip ' + statusTone(status)} style={{ fontSize: 10.5 }}>{t(statusKey(status))}</span>;
}

function ResolutionLabel({ r }: { r: AfterSalesResolution | null }) {
  const { t } = useT();
  return r
    ? <span>{t('asRes_' + r)}</span>
    : <span style={{ color: 'var(--fg-subtle)' }}>{t('asResNone')}</span>;
}

// ── List ────────────────────────────────────────────────────────────────────

function CaseList() {
  const { t, locale } = useT();
  const [rows, setRows] = useState<AfterSalesRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | AfterSalesStatus>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [stats, setStats] = useState<Record<string, { count: number; amount: number }> | null>(null);

  // Typing is debounced into the query the list is fetched with.
  useEffect(() => {
    const h = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(h);
  }, [search]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    if (q) p.set('q', q);
    p.set('limit', '200');
    return p.toString();
  }, [statusFilter, q]);

  // Bumped per load, so a superseded walk's pages never land on the new list.
  const loadGen = useRef(0);
  useEffect(() => {
    const gen = ++loadGen.current;
    forEachKeysetPage<AfterSalesRow>(
      cursor => listAfterSalesCases(query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
        .then(r => ({ items: r.rows, nextCursor: r.nextCursor })),
      (items, { first }) => {
        if (gen !== loadGen.current) return false;
        setRows(prev => first ? items : [...prev, ...items]);
        setLoaded(true);
      },
    ).catch(handleFetchError);
  }, [query]);

  // The tiles count every case, whatever the search or pick: once per visit.
  useEffect(() => {
    let alive = true;
    afterSalesSummary().then(r => { if (alive) setStats(r.byStatus); }).catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('asTitle')}</h1>
          <div className="page-sub">{t('asSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn accent" onClick={() => navigate(afterSalesNewPath())}>
            <Icon name="plus" size={14} /> {t('asNewCase')}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STATUSES.length}, 1fr)`, gap: 12, marginBottom: 16 }}>
        {STATUSES.map(s => {
          const active = statusFilter === s;
          const stat = stats?.[s] ?? { count: 0, amount: 0 };
          return (
            <button
              key={s}
              type="button"
              className="so-stat"
              onClick={() => setStatusFilter(active ? 'all' : s)}
              style={{
                ...(active ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' } : {}),
                fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              <div className="so-stat-head"><StatusChip status={s} /></div>
              <div className="so-stat-num">{stat.count}</div>
              <div className="so-stat-sub">{fmtUSD(stat.amount, locale)}</div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <select
            className="select"
            style={{ width: 180, height: 32, fontSize: 12.5, padding: '0 12px' }}
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as 'all' | AfterSalesStatus)}
          >
            <option value="all">{t('asAllStatuses')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{t(statusKey(s))}</option>)}
          </select>
          <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 420 }}>
            <Icon name="search" size={13} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fg-subtle)' }} />
            <input
              className="input"
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5 }}
              placeholder={t('asSearchPh')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loaded && rows.length === 0 ? (
          <div className="page-sub" style={{ padding: 24 }}>{t('asEmpty')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('asColCase')}</th>
                <th>{t('asColOrder')}</th>
                <th>{t('asColCustomer')}</th>
                <th>{t('asColIssue')}</th>
                <th style={{ textAlign: 'right' }}>{t('asColItems')}</th>
                <th>{t('asColResolution')}</th>
                <th style={{ textAlign: 'right' }}>{t('asColAmount')}</th>
                <th>{t('asColAssignee')}</th>
                <th>{t('asColStatus')}</th>
                <th>{t('asColUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => navigate(afterSalesCasePath(r.id))} style={{ cursor: 'pointer' }}>
                  <td className="mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{r.id}</td>
                  <td>
                    <a
                      className="mono"
                      href={hrefFor('/sell-orders/' + r.sellOrder.id)}
                      onClick={e => { e.stopPropagation(); onLinkClick('/sell-orders/' + r.sellOrder.id)(e); }}
                    >{r.sellOrder.id}</a>
                  </td>
                  <td>{r.customer.short ?? r.customer.name}</td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.issue}>
                    {r.issue}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono">{r.qty}</td>
                  <td><ResolutionLabel r={r.resolution} /></td>
                  <td style={{ textAlign: 'right' }} className="mono">{r.amount != null ? fmtUSD(r.amount, locale) : '—'}</td>
                  <td style={{ color: r.assignee ? 'inherit' : 'var(--fg-subtle)' }}>{r.assignee?.name ?? t('asUnassigned')}</td>
                  <td><StatusChip status={r.status} /></td>
                  <td style={{ color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{fmtDateShort(r.updatedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ── Case page ───────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<AfterSalesStatus, string> = {
  Open: 'asActReopen',
  'In progress': 'asActStart',
  'Awaiting return': 'asActAwait',
  Resolved: 'asActResolve',
  Cancelled: 'asActCancel',
};

function CaseDetail({ id, onToast }: { id: string } & Props) {
  const { t, locale } = useT();
  const managers = useManagerOptions();
  const [c, setC] = useState<AfterSalesCase | null>(null);
  const [draft, setDraft] = useState<{ issue: string; resolution: '' | AfterSalesResolution; amount: string; assigneeId: string }>({
    issue: '', resolution: '', amount: '', assigneeId: '',
  });
  const [saving, setSaving] = useState(false);
  const [moveTo, setMoveTo] = useState<AfterSalesStatus | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getAfterSalesCase(id);
      setC(r.case);
      setDraft({
        issue: r.case.issue,
        resolution: r.case.resolution ?? '',
        amount: r.case.amount == null ? '' : String(r.case.amount),
        assigneeId: r.case.assignee?.id ?? '',
      });
    } catch (e) {
      handleFetchError(e);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (!c) return <div style={{ padding: 60, color: 'var(--fg-subtle)' }}>…</div>;

  const closed = CLOSED.has(c.status);
  // The status route lets only a return await the goods, so the resolution
  // holds still until the case leaves that stage.
  const awaitingReturn = c.status === 'Awaiting return';
  const dirty = draft.issue.trim() !== c.issue
    || (draft.resolution || null) !== c.resolution
    || (draft.amount === '' ? null : Number(draft.amount)) !== c.amount
    || (draft.assigneeId || null) !== (c.assignee?.id ?? null);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await patchAfterSalesCase(c.id, {
        issue: draft.issue.trim(),
        resolution: draft.resolution || null,
        amount: draft.amount === '' ? null : Number(draft.amount),
        assigneeId: draft.assigneeId || null,
      });
      onToast?.(t('asSavedToast'));
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSaving(false);
    }
  };

  const move = async () => {
    if (!moveTo || moving) return;
    setMoving(true);
    try {
      await setAfterSalesStatus(c.id, moveTo, moveNote.trim() || undefined);
      onToast?.(t('asMovedToast', { id: c.id, status: t(statusKey(moveTo)) }));
      setMoveTo(null);
      setMoveNote('');
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setMoving(false);
    }
  };

  const addNote = async () => {
    const text = note.trim();
    if (!text || noting) return;
    setNoting(true);
    try {
      await addAfterSalesNote(c.id, text);
      setNote('');
      onToast?.(t('asNoteAdded'));
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setNoting(false);
    }
  };

  const actionLabel = (to: AfterSalesStatus) =>
    to === 'In progress' && c.status === 'Awaiting return' ? t('asActProgress') : t(ACTION_LABEL[to]);

  const soPath = '/sell-orders/' + c.sellOrder.id;
  const fieldLabel = (f: string) => ({
    issue: t('asIssue'), resolution: t('asResolution'), amount: t('asAmount'), assignee_id: t('asAssignee'),
  } as Record<string, string>)[f] ?? f;

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ marginBottom: 6 }}>
            <a href={hrefFor('/after-sales')} onClick={(e) => { e.preventDefault(); navigateBack('/after-sales'); }}
               style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
              ← {t('asBackToList')}
            </a>
          </div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="mono">{c.id}</span>
            <StatusChip status={c.status} />
          </h1>
          <div className="page-sub">
            <a className="mono" href={hrefFor(soPath)} onClick={onLinkClick(soPath)}>{c.sellOrder.id}</a>
            {' · '}{c.customer.name}
            {' · '}{t('asOpenedBy', { name: c.createdBy?.name ?? '—', when: fmtDateShort(c.createdAt, locale) })}
          </div>
        </div>
        <div className="page-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {c.allowedTo.map(to => (
            <button
              key={to}
              className={'btn' + (to === 'Resolved' || to === 'Open' ? ' accent' : '')}
              style={to === 'Cancelled' ? { color: 'var(--neg)', borderColor: 'var(--neg)' } : undefined}
              onClick={() => { setMoveTo(to); setMoveNote(''); }}
            >
              {actionLabel(to)}
            </button>
          ))}
        </div>
      </div>

      <div className="so-page-body">
        <div className="so-page-main">
          {closed && (
            <div className="card so-page-card" style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>
              {t('asReadOnly', { status: t(statusKey(c.status)) })}
            </div>
          )}
          <div className="card so-page-card">
            <div className="so-section-head"><Icon name="alert" size={14} /> {t('asIssue')}</div>
            <textarea
              className="input"
              rows={4}
              disabled={closed}
              value={draft.issue}
              onChange={e => setDraft({ ...draft, issue: e.target.value })}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>

          <div className="card so-page-card">
            <div className="so-section-head"><Icon name="box" size={14} /> {t('asLines')}</div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('asColItems')}</th>
                  <th style={{ textAlign: 'right' }}>{t('asLineQty')}</th>
                  <th style={{ textAlign: 'right' }}>{t('asLineUnit')}</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map(l => (
                  <tr key={l.id}>
                    <td>
                      {l.label}
                      {l.partNumber && <span className="mono" style={{ marginLeft: 8, color: 'var(--fg-subtle)' }}>{l.partNumber}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono">{l.qty}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmtUSD(l.unitPrice, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="so-page-side">
          <div className="card so-page-card">
            <div className="so-section-head"><Icon name="edit" size={14} /> {t('asResolution')}</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                <span>{t('asResolution')}</span>
                <select className="select" disabled={closed || awaitingReturn} value={draft.resolution}
                        title={awaitingReturn ? t('asResLockedAwaiting') : undefined}
                        onChange={e => setDraft({ ...draft, resolution: e.target.value as '' | AfterSalesResolution })}>
                  <option value="">{t('asResNone')}</option>
                  {RESOLUTIONS.map(r => <option key={r} value={r}>{t('asRes_' + r)}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                <span>{t('asAmount')}</span>
                <input className="input" type="number" min={0} step="0.01" disabled={closed} value={draft.amount}
                       onChange={e => setDraft({ ...draft, amount: e.target.value })} />
                <span style={{ color: 'var(--fg-subtle)', fontSize: 11.5 }}>{t('asAmountHint')}</span>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                <span>{t('asAssignee')}</span>
                <select className="select" disabled={closed} value={draft.assigneeId}
                        onChange={e => setDraft({ ...draft, assigneeId: e.target.value })}>
                  <option value="">{t('asUnassigned')}</option>
                  {managers.map(mm => <option key={mm.id} value={mm.id}>{mm.name}</option>)}
                  {c.assignee && !managers.some(mm => mm.id === c.assignee!.id) && (
                    <option value={c.assignee.id}>{c.assignee.name}</option>
                  )}
                </select>
              </label>
              {!closed && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn accent" disabled={!dirty || saving} onClick={save}>
                    {saving ? '…' : t('asSaveDetails')}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="card so-page-card">
            <div className="so-section-head"><Icon name="clock" size={14} /> {t('asTimeline')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
              {c.events.map(e => (
                <div key={e.id} style={{ display: 'grid', gap: 2 }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{e.actor?.name ?? '—'}</span>{' '}
                    <span>
                      {e.kind === 'created' && t('asEvCreated')}
                      {e.kind === 'status' && t('asEvStatus', { from: t(statusKey(e.from ?? '')), to: t(statusKey(e.to ?? '')) })}
                      {e.kind === 'edited' && t('asEvEdited', { fields: Object.keys(e.detail.changes ?? {}).map(fieldLabel).join(', ') })}
                      {e.kind === 'note' && t('asEvNote')}
                    </span>
                    <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>{fmtDateShort(e.at, locale)}</span>
                  </div>
                  {e.note && <div style={{ whiteSpace: 'pre-wrap', color: 'var(--fg)', paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>{e.note}</div>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
              <textarea className="input" rows={2} placeholder={t('asNotePh')} value={note}
                        onChange={e => setNote(e.target.value)}
                        style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn" disabled={!note.trim() || noting} onClick={addNote}>
                  <Icon name="note" size={13} /> {t('asAddNote')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {moveTo && (
        <Modal onClose={() => { if (!moving) setMoveTo(null); }} shellStyle={{ maxWidth: 440 }}>
          <div className="modal-head">
            <div className="modal-title">{t('asMoveTitle', { status: t(statusKey(moveTo)) })}</div>
          </div>
          <div className="modal-body">
            <textarea className="input" rows={3} placeholder={t('asMoveNotePh')} value={moveNote}
                      onChange={e => setMoveNote(e.target.value)}
                      style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' }} />
          </div>
          <div className="modal-foot">
            <button className="btn" disabled={moving} onClick={() => setMoveTo(null)}>{t('cancel')}</button>
            <button className="btn accent" disabled={moving} onClick={move}>{moving ? '…' : t('asMoveConfirm')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── New case ────────────────────────────────────────────────────────────────

type OrderLine = { id: string; no: number; label: string; partNumber: string | null; qty: number; unitPrice: number };
type OrderHead = { id: string; status: string; customer: { name: string }; lines: OrderLine[] };

function NewCaseForm({ onToast }: Props) {
  const { t, locale } = useT();
  const managers = useManagerOptions();
  const preset = readHashQuery().get('order') ?? '';
  const [orderId, setOrderId] = useState(preset);
  const [order, setOrder] = useState<OrderHead | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [picked, setPicked] = useState<Record<string, number>>({});
  // What the qty field shows while it is being typed in: clamping on every
  // keystroke made it impossible to clear the field or start a number with 0.
  const [qtyText, setQtyText] = useState<Record<string, string>>({});
  const [issue, setIssue] = useState('');
  const [resolution, setResolution] = useState<'' | AfterSalesResolution>('');
  const [amount, setAmount] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [creating, setCreating] = useState(false);

  const loadOrder = useCallback(async (id: string) => {
    const trimmed = id.trim().toUpperCase();
    if (!trimmed) return;
    setLoadingOrder(true);
    try {
      const r = await api.get<{ order: OrderHead }>(`/api/sell-orders/${encodeURIComponent(trimmed)}`);
      setOrder(r.order);
      setPicked({});
      setQtyText({});
    } catch (e) {
      setOrder(null);
      handleFetchError(e);
    } finally {
      setLoadingOrder(false);
    }
  }, []);
  useEffect(() => { if (preset) void loadOrder(preset); }, [preset, loadOrder]);

  const eligible = !!order && CASEABLE_SELL_STATUSES.has(order.status);
  const lines = useMemo(() => (order?.lines ?? []).filter(l => l.qty > 0), [order]);
  const anyPicked = Object.values(picked).some(q => q > 0);

  const create = async () => {
    if (!order || creating) return;
    if (!anyPicked) { onToast?.(t('asNeedLine'), 'error'); return; }
    if (!issue.trim()) { onToast?.(t('asNeedIssue'), 'error'); return; }
    setCreating(true);
    try {
      const r = await createAfterSalesCase({
        sellOrderId: order.id,
        issue: issue.trim(),
        lines: Object.entries(picked).filter(([, q]) => q > 0).map(([sellOrderLineId, qty]) => ({ sellOrderLineId, qty })),
        resolution: resolution || null,
        amount: amount === '' ? null : Number(amount),
        assigneeId: assigneeId || null,
      });
      onToast?.(t('asCreatedToast', { id: r.id }));
      navigate(afterSalesCasePath(r.id));
    } catch (e) {
      handleFetchError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div style={{ marginBottom: 6 }}>
            <a href={hrefFor('/after-sales')} onClick={(e) => { e.preventDefault(); navigateBack('/after-sales'); }}
               style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
              ← {t('asBackToList')}
            </a>
          </div>
          <h1 className="page-title">{t('asNewTitle')}</h1>
          <div className="page-sub">{t('asNewSub')}</div>
        </div>
      </div>

      <div className="so-page-body">
        <div className="so-page-main">
          <div className="card so-page-card">
            <div className="so-section-head"><Icon name="tag" size={14} /> {t('asOrderField')}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input mono"
                style={{ width: 200 }}
                placeholder={t('asOrderPh')}
                value={orderId}
                onChange={e => setOrderId(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void loadOrder(orderId); }}
              />
              <button className="btn" disabled={loadingOrder || !orderId.trim()} onClick={() => loadOrder(orderId)}>
                {loadingOrder ? '…' : t('asOrderLoad')}
              </button>
              {order && (
                <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>
                  {order.customer.name} · <span className={'chip ' + statusTone(order.status)} style={{ fontSize: 10.5 }}>{sellOrderStatusShort(order.status)}</span>
                </span>
              )}
            </div>
            {order && !eligible && (
              <div style={{ marginTop: 10, fontSize: 13, color: 'var(--neg)' }}>
                {t('asOrderNotEligible', { status: sellOrderStatusShort(order.status) })}
              </div>
            )}
          </div>

          {order && eligible && (
            <div className="card so-page-card">
              <div className="so-section-head"><Icon name="box" size={14} /> {t('asPickLines')}</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th>{t('asColItems')}</th>
                    <th style={{ textAlign: 'right' }}>{t('asLineUnit')}</th>
                    <th style={{ textAlign: 'right', width: 120 }}>{t('asLineQty')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(l => {
                    const on = (picked[l.id] ?? 0) > 0;
                    return (
                      <tr key={l.id}>
                        <td>
                          <input type="checkbox" checked={on}
                                 onChange={e => {
                                   setPicked({ ...picked, [l.id]: e.target.checked ? l.qty : 0 });
                                   setQtyText(({ [l.id]: _, ...rest }) => rest);
                                 }} />
                        </td>
                        <td>
                          <span className="mono" style={{ color: 'var(--fg-subtle)', marginRight: 8 }}>#{l.no}</span>
                          {l.label}
                          {l.partNumber && <span className="mono" style={{ marginLeft: 8, color: 'var(--fg-subtle)' }}>{l.partNumber}</span>}
                        </td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmtUSD(l.unitPrice, locale)}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <input
                            className="input mono"
                            type="number" min={1} max={l.qty} step={1}
                            disabled={!on}
                            value={on ? (qtyText[l.id] ?? String(picked[l.id])) : ''}
                            onChange={e => {
                              const text = e.target.value;
                              setQtyText({ ...qtyText, [l.id]: text });
                              const n = Number(text);
                              if (/^\d+$/.test(text) && n >= 1 && n <= l.qty) setPicked({ ...picked, [l.id]: n });
                            }}
                            onBlur={() => {
                              const typed = qtyText[l.id];
                              if (typed === undefined) return;
                              const n = Math.max(1, Math.min(l.qty, Math.floor(Number(typed) || 1)));
                              setPicked({ ...picked, [l.id]: n });
                              setQtyText(({ [l.id]: _, ...rest }) => rest);
                            }}
                            style={{ width: 80, textAlign: 'right' }}
                          />
                          <span style={{ color: 'var(--fg-subtle)', marginLeft: 6, fontSize: 12 }}>/ {l.qty}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {order && eligible && (
            <div className="card so-page-card">
              <div className="so-section-head"><Icon name="alert" size={14} /> {t('asIssue')}</div>
              <textarea className="input" rows={4} placeholder={t('asIssuePh')} value={issue}
                        onChange={e => setIssue(e.target.value)}
                        style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            </div>
          )}
        </div>

        {order && eligible && (
          <div className="so-page-side">
            <div className="card so-page-card">
              <div className="so-section-head"><Icon name="edit" size={14} /> {t('asResolution')}</div>
              <div style={{ display: 'grid', gap: 10 }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                  <span>{t('asResolution')}</span>
                  <select className="select" value={resolution} onChange={e => setResolution(e.target.value as '' | AfterSalesResolution)}>
                    <option value="">{t('asResNone')}</option>
                    {RESOLUTIONS.map(r => <option key={r} value={r}>{t('asRes_' + r)}</option>)}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                  <span>{t('asAmount')}</span>
                  <input className="input" type="number" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
                  <span style={{ color: 'var(--fg-subtle)', fontSize: 11.5 }}>{t('asAmountHint')}</span>
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                  <span>{t('asAssignee')}</span>
                  <select className="select" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
                    <option value="">{t('asUnassigned')}</option>
                    {managers.map(mm => <option key={mm.id} value={mm.id}>{mm.name}</option>)}
                  </select>
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn accent" disabled={creating || !anyPicked || !issue.trim()} onClick={create}>
                    {creating ? '…' : t('asCreate')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
