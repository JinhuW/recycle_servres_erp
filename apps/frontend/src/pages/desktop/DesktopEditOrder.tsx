import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../../lib/api';
import { handleFetchError, showErrorToast } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import type { Order, OrderLine, Warehouse } from '../../lib/types';
import {
  LineDrawer, blankLine, findDuplicatePartNumbers,
  type Line, type DuplicatePartGroup,
} from './DesktopSubmit';
import { ImageLightbox } from '../../components/ImageLightbox';
import { OrderActivityLog } from '../../components/OrderActivityLog';
import { StatusChangeDialog, type StatusAttachment } from '../../components/StatusChangeDialog';
import { AttachmentChip } from '../../components/AttachmentChip';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';

const realScan = (u?: string | null): u is string =>
  !!u && !u.startsWith('data:image/placeholder');

// `order.status` is derived from the SET of line statuses and collapses to
// 'Mixed' when a (still-open) order's lines disagree — e.g. a draft whose
// lines were autosaved as 'In Transit'. Gating edit-access on that ambiguous
// string locked purchasers out of their own draft. `lifecycle` is the
// authoritative stage (see orders.ts), so derive the canonical status from it
// and only fall back to the derived string for unknown lifecycles.
const LIFECYCLE_STATUS: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

type Props = {
  order: Order;
  onCancel: () => void;
  onSaved: (msg: string) => void;
};

// Internal line state — the shared `Line` plus the original DB id (when the
// line came from the server), the line's persisted status, and a dirty
// marker so we can scope the PATCH.
type EditLine = Line & { _id?: string; _status?: string; _dirty?: boolean };

// Edit-order page lifted from design/dashboard.jsx#EditOrderPage. Table is
// read-only summary rows; clicking a row opens the right-side LineDrawer
// (same component the new-order flow uses), passed `editing={true}` so the
// drawer adds sell-price + revenue/profit/margin. Meta row + status stepper
// + Cancel/Save sit in a sticky bottom card.
//
// Purchasers stay in control through Draft and In Transit, then hand the
// order off to the manager at Reviewing (where pricing happens). Managers may
// move it through any stage and edit prices/qty. Once an order reaches "Done"
// the whole page becomes read-only.
export function DesktopEditOrder({ order, onCancel, onSaved }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const isPurchaser = user?.role !== 'manager';
  // Edit-gating keys off the authoritative lifecycle, not the 'Mixed'-prone
  // derived status, so an owner is never locked out of their own draft.
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  const orderLocked = isCompleted(effectiveStatus);
  const purchaserCanEdit =
    !isPurchaser || effectiveStatus === 'Draft' || effectiveStatus === 'In Transit';
  const canEditOrder = purchaserCanEdit && !orderLocked;
  const allowedStatuses = isPurchaser
    ? effectiveStatus === 'Draft'      ? ['Draft', 'In Transit']
    : effectiveStatus === 'In Transit' ? ['In Transit', 'Reviewing']
    :                                    [effectiveStatus]
    : ORDER_STATUSES.slice();

  const [status, setStatus] = useState(effectiveStatus);
  // Optional Done evidence (note + attachments). The dialog live-saves to the
  // backend; these mirror its latest confirmed state for the read-only block.
  const [doneDialogOpen, setDoneDialogOpen] = useState(false);
  const [doneNote, setDoneNote] = useState(order.statusMeta?.['Done']?.note ?? '');
  const [doneAttachments, setDoneAttachments] = useState<StatusAttachment[]>(
    order.statusMeta?.['Done']?.attachments ?? [],
  );
  const [submissionAtts, setSubmissionAtts] = useState<StatusAttachment[]>(
    order.statusMeta?.['Submission']?.attachments ?? [],
  );
  const [submissionUploading, setSubmissionUploading] = useState(false);
  // Owner may edit while Draft; managers always. Mirrors the backend gate.
  const canEditSubmission = !isPurchaser || (order.userId === user?.id && effectiveStatus === 'Draft');

  const addSubmissionFiles = async (fl: FileList | null) => {
    const files = Array.from(fl || []);
    if (!files.length) return;
    setSubmissionUploading(true);
    try {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          showErrorToast(t('fileTooLarge', { name: f.name }));
          continue;
        }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: StatusAttachment }>(
          `/api/orders/${order.id}/status-meta/Submission/attachments`, form);
        setSubmissionAtts(prev => [...prev, r.attachment]);
      }
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSubmissionUploading(false);
    }
  };

  const removeSubmissionAtt = async (att: StatusAttachment) => {
    try {
      await api.delete<{ ok: true }>(`/api/orders/${order.id}/status-meta/Submission/attachments/${att.id}`);
      setSubmissionAtts(prev => prev.filter(a => a.id !== att.id));
    } catch (e) {
      handleFetchError(e);
    }
  };
  const [activityKey, setActivityKey] = useState(0);
  const [lines, setLines] = useState<EditLine[]>(() => order.lines.map(orderLineToEditLine));
  const [notes, setNotes] = useState<string>(order.notes ?? '');
  const [warehouseId, setWarehouseId] = useState<string>(order.warehouse?.id ?? '');
  const [payment, setPayment] = useState<'company' | 'self'>(order.payment);
  // Default to 0% when no rate has been set on the order yet, so the field
  // and the side commission summary show a concrete value out of the gate
  // instead of a blank input. Saving 0 against a still-null DB rate is
  // suppressed below by treating null and 0 as equivalent.
  const [commissionPct, setCommissionPct] = useState<string>(
    order.commissionRate != null ? String(+(order.commissionRate * 100).toFixed(2)) : '0');
  const [totalCostInput, setTotalCostInput] = useState<string>(
    order.totalCost != null ? order.totalCost.toFixed(2) : '',
  );
  const [totalCostOverride, setTotalCostOverride] = useState(order.totalCost != null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canDelete = canEditOrder && effectiveStatus === 'Draft';

  // Archive: owner-or-manager, any non-Draft stage. Either flips to the other.
  // (Draft uses Delete instead; the backend enforces the same split.)
  const isArchived = !!order.archivedAt;
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canArchive = isOwnerOrManager && effectiveStatus !== 'Draft';
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // Filled when save() detects duplicate part numbers; the modal then drives a
  // "Save anyway" path that bypasses the check.
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => { if (alive) setWarehouses(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // Escape closes the drawer; if none open, closes the page.
  // When the delete modal is open, Escape dismisses it (if not mid-delete)
  // and does NOT fall through to the page-close / drawer-close logic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showDelete) {
        if (!deleting) setShowDelete(false);
        return;
      }
      if (showArchive) {
        if (!archiving) setShowArchive(false);
        return;
      }
      if (activeIdx !== null) setActiveIdx(null);
      else onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx, onCancel, showDelete, deleting, showArchive, archiving]);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch, _dirty: true } : l)));

  const addLine = () => {
    setLines(ls => [...ls, { ...blankLine(order.category), _dirty: true }]);
    setActiveIdx(lines.length);
  };

  const removeLine = (i: number) => {
    setLines(ls => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));
    setActiveIdx(idx => {
      if (lines.length <= 1) return null;
      if (i === idx) return null;
      if (idx != null && i < idx) return idx - 1;
      return idx;
    });
  };

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  // Lookup table keyed by line index → other 1-based line numbers sharing its
  // part #. Drives the inline drawer warning.
  const dupByIdx = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of dupGroups) {
      for (const ln of g.lineNums) {
        m.set(ln - 1, g.lineNums.filter(n => n !== ln));
      }
    }
    return m;
  }, [dupGroups]);

  const totals = useMemo(() => {
    let qty = 0, cost = 0, revenue = 0, profit = 0;
    // "Priced" = lines that have a sell price set, which is the subset that
    // can actually contribute to a realised commission.
    let pricedCount = 0, pricedProfit = 0;
    for (const l of lines) {
      const q = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      const spRaw = l.sellPrice;
      const hasPrice = spRaw != null && spRaw !== '' && Number(spRaw) > 0;
      const sp = hasPrice ? Number(spRaw) : 0;
      qty += q;
      cost += q * c;
      revenue += q * sp;
      profit += q * (sp - c);
      if (hasPrice) {
        pricedCount += 1;
        pricedProfit += q * (sp - c);
      }
    }
    return { qty, cost, revenue, profit, pricedCount, pricedProfit };
  }, [lines]);

  const statusDirty = status !== effectiveStatus;
  const linesDirty = lines.some(l => l._dirty) || lines.length !== order.lines.length;
  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  // '' = explicitly unset (null). Non-numeric intermediate input (e.g. "5e")
  // must NOT be treated as a change — mirrors the totalCost field's guard.
  const parsedCommission =
    commissionPct.trim() === '' ? null : Number(commissionPct);
  const commissionValid =
    parsedCommission === null || Number.isFinite(parsedCommission);
  const commissionRateValue =
    parsedCommission === null ? null : parsedCommission / 100;
  // null (unset) and 0 are equivalent — both yield zero commission — so
  // opening an order with a null DB rate at the default 0% UI value isn't
  // flagged as a pending change.
  const commissionDirty =
    commissionValid && (commissionRateValue ?? 0) !== (order.commissionRate ?? 0);
  const parsedTotalCost = totalCostInput.trim() === '' ? null : Number(totalCostInput);
  const totalCostDirty =
    totalCostOverride &&
    !Number.isNaN(parsedTotalCost as number) &&
    (parsedTotalCost ?? null) !== (order.totalCost ?? null);

  // Derived values for the side Payment-detail panel.
  // Self pay → the purchaser is reimbursed for what they paid out of pocket
  // (effectiveTotalCost) AND earns commission on profit. Company pay → only
  // the commission on profit. When the manager/purchaser overrides Total cost,
  // that override is the authoritative cost for EVERY part of the formula —
  // including (Revenue − Cost), so the commission preview reconciles cleanly
  // with the Self-pay reimbursement instead of mixing two cost figures.
  const effectiveTotalCost =
    totalCostOverride && parsedTotalCost != null ? parsedTotalCost : totals.cost;
  const effectiveProfit = totals.revenue - effectiveTotalCost;
  const commissionRateApplied = commissionRateValue ?? 0;
  const commissionOnProfit = effectiveProfit * commissionRateApplied;
  const purchaserEarn =
    (payment === 'self' ? effectiveTotalCost : 0) + commissionOnProfit;

  const dirty =
    statusDirty || linesDirty || notesDirty || warehouseDirty || paymentDirty || totalCostDirty || commissionDirty;

  const lineReady = (l: EditLine) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  };
  const canSave = dirty && !saving && !orderLocked && lines.every(lineReady);

  // Inline hint near the Save button — explains why it's disabled instead of
  // leaving the user clicking a dead button. Order matches the canSave gates.
  const saveDisabledReason: string | null =
    saving || canSave  ? null
  : orderLocked        ? 'This order is Done — it can no longer be edited.'
  : !dirty             ? 'No changes to save.'
  : (() => {
      const bad = lines.findIndex(l => !lineReady(l));
      if (bad < 0) return null;
      const which = lines.length === 1 ? 'this line' : `line ${bad + 1}`;
      return `Fill in brand/description, quantity and unit cost on ${which} before saving.`;
    })();

  const doSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const presentIds = new Set(lines.filter(l => l._id).map(l => l._id!));
      const removeLineIds = order.lines
        .map(l => l.id)
        .filter(id => !presentIds.has(id));
      await api.patch(`/api/orders/${order.id}`, {
        notes:         notesDirty     ? notes                  : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)  : undefined,
        payment:       paymentDirty   ? payment                : undefined,
        commissionRate: commissionDirty ? commissionRateValue : undefined,
        totalCost:     totalCostDirty ? parsedTotalCost        : undefined,
        lines: lines
          .filter(l => l._id && (l._dirty || statusDirty))
          .map(l => editLineToPatch(l, statusDirty ? status : undefined)),
        addLines: lines
          .filter(l => !l._id)
          .map(l => editLineToInsert(l, status)),
        removeLineIds: removeLineIds.length ? removeLineIds : undefined,
      });
      // The stepper's stage lives on orders.lifecycle, which PATCH never
      // touches — only /advance moves it (and cascades the line statuses).
      // Without this the save returns 200, the lines flip, but the stage snaps
      // back on reload. Managers may jump straight to the target stage;
      // purchasers can only step forward and the backend rejects `toStage` for
      // them, so send an empty body to advance one stage.
      if (statusDirty) {
        const toStage = Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === status);
        await api.post(`/api/orders/${order.id}/advance`, isPurchaser ? {} : { toStage });
      }
      onSaved('Saved ' + order.id);
    } catch (e) {
      // Keep the editor open and the user's edits intact on failure — calling
      // onSaved here would navigate away and discard unsaved work.
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (dupGroups.length > 0) {
      setDupConfirm(dupGroups);
      return;
    }
    await doSave();
  };

  const itemLabel = (l: EditLine) =>
      l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
    : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
    : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
    : (l.description ?? '—');
  const itemSpec = (l: EditLine) =>
      l.category === 'RAM' ? [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')
    : l.category === 'SSD' ? [l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : l.category === 'HDD' ? [l.interface, l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : (l.condition ?? '');

  return (
    <>
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--fg-subtle)', fontSize: 12.5,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
              marginBottom: 6,
            }}
          >
            <Icon name="chevronLeft" size={12} /> {t('backToOrders')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0 }}>{t('editOrder')}</h1>
            <span className="mono" style={{
              fontSize: 13, fontWeight: 600, padding: '3px 9px',
              borderRadius: 5, background: 'var(--bg-soft)',
              border: '1px solid var(--border)', whiteSpace: 'nowrap',
            }}>{order.id}</span>
            <span className={'chip ' + (order.category === 'RAM' ? 'info' : order.category === 'SSD' ? 'pos' : order.category === 'HDD' ? 'cool' : 'warn')}>
              {order.category}
            </span>
          </div>
          <div className="page-sub" style={{ marginTop: 6 }}>
            {fmtDateShort(order.createdAt, locale)} · {t('submittedBy')} {order.userName.split(' ')[0]} · {lines.length === 1 ? t('historyLineCountOne', { n: lines.length }) : t('historyLineCountMany', { n: lines.length })} · {t('editOrderSub')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
          {canArchive && (
            isArchived ? (
              <button
                className="btn"
                style={{ color: 'var(--accent-strong)', borderColor: 'var(--accent)' }}
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    await unarchiveOrder(order.id);
                    onSaved(t('orderRestoredToast'));
                  } catch (e) {
                    handleFetchError(e);
                    setArchiving(false);
                  }
                }}
                title={t('eoUnarchiveTooltip')}
              >
                <Icon name="rotate" size={13} /> {archiving ? '…' : t('eoUnarchive')}
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => setShowArchive(true)}
                title={t('eoArchiveTooltip')}
              >
                <Icon name="box" size={13} /> {t('archiveOrder')}
              </button>
            )
          )}
          {canDelete && (
            <button
              className="btn"
              style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
              onClick={() => { setTypedId(''); setShowDelete(true); }}
            >
              <Icon name="trash" size={13} /> {t('deleteOrder')}
            </button>
          )}
        </div>
      </div>
      {isArchived && (
        <div className="card" style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-soft)', borderStyle: 'dashed',
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'oklch(0.96 0.04 295)', color: 'oklch(0.45 0.16 295)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="box" size={14} />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.45 }}>
            <strong style={{ color: 'var(--fg)' }}>{t('historyArchived')}</strong> · {t('eoArchivedBannerBody')}
          </div>
        </div>
      )}

      {/* --oe-rows mirrors the visible line count (capped at 10) so the activity
          log's max height tracks the item table — short table, short log. */}
      <div className="oe-body" style={{ ['--oe-rows' as string]: String(Math.min(lines.length, 10)) }}>
      <div className={'card oe-items-card' + (!canEditOrder ? ' order-readonly' : '')}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">{t('orderContainsMultiple', { cat: order.category })}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.qty, cost: fmtUSD(totals.cost, locale) })}</span>
            <span className="chip mono">{order.id} · {t('subStatusEditing')}</span>
            {canEditOrder && (
              <button className="btn accent" style={{ marginLeft: 'auto' }} onClick={addLine}>
                <Icon name="plus" size={13} /> {t('subAddLine', { cat: order.category })}
              </button>
            )}
          </div>
        </div>
        <div className="table-scroll" ref={tableScrollRef}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>{t('item')}</th>
                <th>{t('partNumber')}</th>
                <th className="num">{t('qty')}</th>
                <th className="num">{t('unitCost')}</th>
                <th className="num">{t('sellUnit')}</th>
                <th className="num">{t('revenue')}</th>
                <th className="num">{t('profit')}</th>
                {canEditOrder && <th style={{ width: 40 }}></th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const qty = Number(l.qty) || 0;
                const lCost = Number(l.unitCost) || 0;
                const sp = l.sellPrice == null || l.sellPrice === '' ? 0 : Number(l.sellPrice);
                const profit = qty * (sp - lCost);
                const lossy = sp > 0 && sp < lCost;
                const filled = !!l.brand || !!l.description;
                const isActive = i === activeIdx;
                return (
                  <tr
                    key={l._id ?? l._cid}
                    className={canEditOrder ? 'row-hover' : ''}
                    style={{
                      cursor: canEditOrder ? 'pointer' : 'default',
                      background: isActive ? 'var(--accent-soft)' : undefined,
                    }}
                    onClick={canEditOrder ? () => setActiveIdx(i) : undefined}
                  >
                    <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {realScan(l.scanImageUrl) && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); setLightboxUrl(l.scanImageUrl!); }}
                            title={t('aiPhotoLabel')}
                            style={{
                              width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                              border: '1px solid var(--border)', overflow: 'hidden',
                              padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                            }}
                          >
                            <img
                              src={l.scanImageUrl}
                              alt={t('aiPhotoLabel')}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                          </button>
                        )}
                        <div style={{ minWidth: 0 }}>
                          {filled ? (
                            <>
                              <div style={{ fontWeight: 500 }}>{itemLabel(l)}</div>
                              <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{itemSpec(l)}</div>
                            </>
                          ) : (
                            <span className="muted" style={{ fontStyle: 'italic' }}>
                              {isActive ? t('subEditingFill') : t('subNotFilled')}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                    <td className="num mono">{qty}</td>
                    <td className="num mono">{lCost ? fmtUSD(lCost, locale) : '—'}</td>
                    <td className="num mono">{sp ? fmtUSD(sp, locale) : '—'}</td>
                    <td className="num mono">{sp && qty ? fmtUSD(sp * qty, locale) : '—'}</td>
                    <td className={'num mono ' + (sp ? (profit >= 0 ? 'pos' : 'neg') : 'muted')}>
                      {sp ? fmtUSD(profit, locale) : '—'}
                      {lossy && <Icon name="alert" size={11} style={{ marginLeft: 4, color: 'var(--warn)' }} />}
                    </td>
                    {canEditOrder && (
                      <td>
                        <button
                          className="btn icon sm"
                          onClick={e => { e.stopPropagation(); removeLine(i); }}
                          title={t('soRemoveLineTooltip')}
                          disabled={lines.length <= 1}
                          style={lines.length <= 1 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="oe-items-foot" style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'flex-end', gap: 24,
          fontSize: 13, background: 'var(--bg-soft)',
        }}>
          <span style={{ color: 'var(--fg-subtle)' }}>
            {t('revenue')} <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.revenue, locale)}</span>
          </span>
          <span style={{ color: 'var(--fg-subtle)' }}>
            {t('eoCost')} <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.cost, locale)}</span>
          </span>
          <span style={{ color: 'var(--fg-subtle)' }}>
            {t('profit')} <span className="mono pos" style={{ fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.profit, locale)}</span>
          </span>
        </div>
      </div>

      <aside className="oe-side">
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t('eoPaymentDetail')}</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
            {t('eoWhatEarnsOnPO', { name: order.userName.split(' ')[0] })}
          </div>

          <div style={{ marginTop: 10 }}>
            <span
              className={'chip ' + (payment === 'self' ? 'info' : 'pos')}
              style={{ fontSize: 11 }}
            >
              {payment === 'self' ? t('eoSelfPay') : t('eoCompanyPay')}
            </span>
          </div>

          <div style={{
            marginTop: 14, fontSize: 10.5, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
          }}>
            {t('eoPurchaserEarns')}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 26, fontWeight: 600, marginTop: 4, lineHeight: 1.1,
              color: purchaserEarn >= 0 ? 'var(--pos)' : 'var(--neg)',
            }}
          >
            {fmtUSD(purchaserEarn, locale)}
          </div>

          {/* Formula — symbolic then numeric, so the breakdown explains the
              number above. The self-pay term only appears when the purchaser
              fronted the cost themselves. */}
          <div style={{
            marginTop: 12, padding: '10px 12px',
            background: 'var(--bg-soft)', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 11.5, lineHeight: 1.55,
          }}>
            <div style={{ color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, fontSize: 10 }}>
              {t('eoFormula')}
            </div>
            <div style={{ marginTop: 4 }}>
              {payment === 'self' ? t('eoFormulaSelf') : t('eoFormulaCompany')}
            </div>
            <div className="mono" style={{ marginTop: 4, color: 'var(--fg)' }}>
              {payment === 'self' ? `${fmtUSD(effectiveTotalCost, locale)} + ` : ''}
              ({fmtUSD(totals.revenue, locale)} − {fmtUSD(effectiveTotalCost, locale)}) × {(commissionRateApplied * 100).toFixed(2)}%
            </div>
            <div className="mono" style={{ marginTop: 2, color: 'var(--fg-subtle)' }}>
              = {payment === 'self' ? `${fmtUSD(effectiveTotalCost, locale)} + ` : ''}{fmtUSD(commissionOnProfit, locale)} = <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtUSD(purchaserEarn, locale)}</span>
            </div>
          </div>

          <div style={{
            marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)',
            display: 'grid', gap: 8, fontSize: 12.5,
          }}>
            {payment === 'self' && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--fg-subtle)' }}>{t('eoSelfPay')}</span>
                <span className="mono">{fmtUSD(effectiveTotalCost, locale)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('revenue')}</span>
              <span className="mono">{fmtUSD(totals.revenue, locale)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('eoCost')}</span>
              <span className="mono">{fmtUSD(effectiveTotalCost, locale)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('profit')}</span>
              <span className="mono">{fmtUSD(effectiveProfit, locale)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('eoRate')}</span>
              <span className="mono">{(commissionRateApplied * 100).toFixed(2)}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('eoCommissionOnProfit')}</span>
              <span className="mono">{fmtUSD(commissionOnProfit, locale)}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              paddingTop: 6, borderTop: '1px dashed var(--border)',
              fontWeight: 600,
            }}>
              <span>{t('eoTotal')}</span>
              <span className="mono">{fmtUSD(purchaserEarn, locale)}</span>
            </div>
          </div>

          {totals.pricedCount < lines.length && (
            <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
              {t('eoUnpricedLinesHint', { n: lines.length - totals.pricedCount })}
            </div>
          )}
        </div>

        {/* PO audit log — lives under Payment detail in the side column, fully
            foldable. The component hides its own card chrome before load and
            handles the empty-state copy for drafts. */}
        <OrderActivityLog orderId={order.id} refreshKey={activityKey} />
      </aside>

      <div className="card oe-action-card" style={{ zIndex: 5, boxShadow: '0 -8px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginBottom: 10,
          }}>
            <Icon name="flag" size={12} /> {t('orderStatus')}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {t('advanceAsProgresses')}
            </span>
          </div>
          <div className="so-stepper">
            {ORDER_STATUSES.map((s, i) => {
              const active = s === status;
              const currentIdx = ORDER_STATUSES.indexOf(status as typeof ORDER_STATUSES[number]);
              const reached = currentIdx >= 0 && i <= currentIdx;
              const locked = isPurchaser && !allowedStatuses.includes(s);
              return (
                <Fragment key={s}>
                  <button
                    type="button"
                    className={'so-step' + (active ? ' active' : '') + (reached ? ' reached' : '') + (locked ? ' locked' : '')}
                    onClick={() => {
                      if (locked || orderLocked) return;
                      // Done gets the evidence dialog first; confirming stages
                      // the status, Save commits it. Re-open it even when already
                      // at Done so the user can add more notes / attachments.
                      // Purchasers never reach here for Done (allowedStatuses
                      // keeps it locked).
                      if (s === 'Done') { setDoneDialogOpen(true); return; }
                      setStatus(s);
                    }}
                    disabled={locked || orderLocked}
                    title={locked
                      ? t('eoStepLockedTooltip')
                      : t('eoSetStatusTo', { s })}
                  >
                    <span className="so-step-dot">
                      {locked ? <Icon name="lock" size={10} /> : (i + 1)}
                    </span>
                    <span className="so-step-label">{s}</span>
                  </button>
                  {i < ORDER_STATUSES.length - 1 && (
                    <span className={'so-step-bar' + (i < currentIdx ? ' reached' : '')} />
                  )}
                </Fragment>
              );
            })}
          </div>
          {isPurchaser && !purchaserCanEdit && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="lock" size={13} />
              {t('eoReviewedByMgr')}
            </div>
          )}
          {isPurchaser && purchaserCanEdit && effectiveStatus === 'Draft' && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              {t('oeHintDraftPre')}<strong>In Transit</strong>{t('oeHintDraftPost')}
            </div>
          )}
          {isPurchaser && purchaserCanEdit && effectiveStatus === 'In Transit' && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              {t('oeHintInTransitPre')}<strong>Reviewing</strong>{t('oeHintInTransitPost')}
            </div>
          )}
          {statusDirty && !isPurchaser && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              {t('eoStatusChangeMgrPre')} <strong>{effectiveStatus}</strong> {t('eoStatusChangeMid')} <strong>{status}</strong> {t('eoStatusChangePost')}
            </div>
          )}
          {statusDirty && isPurchaser && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              {t('eoStatusChangeMgrPre')} <strong>{effectiveStatus}</strong> {t('eoStatusChangeMid')} <strong>{status}</strong> {t('eoStatusChangePurchPost')}
            </div>
          )}
          {(doneNote || doneAttachments.length > 0) && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8,
              background: 'var(--bg-soft)', border: '1px solid var(--border)',
              display: 'grid', gap: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="paperclip" size={11} /> {t('poDoneEvidenceTitle')}
              </div>
              {doneNote && (
                <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{doneNote}</div>
              )}
              {doneAttachments.map(a => <AttachmentChip key={a.id} a={a} />)}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginBottom: 10,
          }}>
            <Icon name="warehouse" size={12} /> {t('orderDetails')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('warehouse')}</label>
              <div style={{ position: 'relative' }}>
                <Icon name="warehouse" size={13} style={{
                  position: 'absolute', left: 10, top: '50%',
                  transform: 'translateY(-50%)', color: 'var(--fg-subtle)',
                  pointerEvents: 'none',
                }} />
                <select
                  className="select"
                  value={warehouseId}
                  onChange={e => setWarehouseId(e.target.value)}
                  disabled={!canEditOrder}
                  style={{ paddingLeft: 30, width: '100%' }}
                >
                  {warehouses.length === 0 && (
                    <option value={warehouseId}>{order.warehouse?.name ?? order.warehouse?.short ?? '—'}</option>
                  )}
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('payment')}</label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  type="button"
                  className={payment === 'company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => canEditOrder && setPayment('company')}
                  disabled={!canEditOrder}
                >{t('payCompanyShort')}</button>
                <button
                  type="button"
                  className={payment === 'self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => canEditOrder && setPayment('self')}
                  disabled={!canEditOrder}
                >{t('paySelfShort')}</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('commissionRate')}</label>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                step="0.1"
                disabled={isPurchaser}
                value={commissionPct}
                placeholder={isPurchaser ? '—' : t('eoSetRate')}
                onChange={e => setCommissionPct(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>{t('totalCost')}</span>
                {totalCostOverride && canEditOrder && (
                  <button
                    onClick={() => {
                      setTotalCostOverride(false);
                      setTotalCostInput(totals.cost.toFixed(2));
                    }}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-strong)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                    title={t('subAutoSumIs', { cost: fmtUSD(totals.cost, locale) })}
                  >{t('reset')}</button>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{
                  position: 'absolute', left: 12, top: '50%',
                  transform: 'translateY(-50%)', color: 'var(--fg-subtle)',
                  pointerEvents: 'none',
                }}>$</span>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={totalCostOverride ? totalCostInput : totals.cost.toFixed(2)}
                  onChange={e => { setTotalCostOverride(true); setTotalCostInput(e.target.value); }}
                  onFocus={e => e.target.select()}
                  disabled={!canEditOrder}
                  style={{ paddingLeft: 24, fontWeight: 500 }}
                />
              </div>
            </div>
            {/* Notes gets its own row and spans the full grid so there's
                room to write more than a single short phrase. */}
            <div className="field" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
              <label className="label">{t('orderNotes')}</label>
              <textarea
                className="input"
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={t('orderNotesPh')}
                disabled={!canEditOrder}
                style={{ width: '100%', resize: 'vertical', minHeight: 64, fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </div>
            {(submissionAtts.length > 0 || canEditSubmission) && (
              <div className="field" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
                <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="paperclip" size={12} /> {t('poSubmissionEvidenceTitle')}
                </label>
                <div style={{ display: 'grid', gap: 8 }}>
                  {submissionAtts.map(a => (
                    <AttachmentChip
                      key={a.id}
                      a={a}
                      onRemove={canEditSubmission ? () => removeSubmissionAtt(a) : undefined}
                    />
                  ))}
                  {canEditSubmission && (
                    <AttachmentDropzone
                      boxHint={t('poSubmitAttachHint')}
                      uploading={submissionUploading}
                      onFiles={addSubmissionFiles}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{
          padding: 16, display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr) auto',
          gap: 18, alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('lines')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('subTotalUnits')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.qty}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              {t('totalCost')} {totalCostOverride && Math.abs((parsedTotalCost ?? 0) - totals.cost) > 0.01 && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(totalCostOverride ? (parsedTotalCost ?? 0) : totals.cost, locale)}
            </div>
          </div>
          {saveError && (
            <div className="form-error" role="alert" style={{ marginRight: 'auto', alignSelf: 'center', color: 'var(--neg, #c0392b)', fontSize: 13 }}>
              {saveError}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onCancel}>{t('cancel')}</button>
              <button
                className="btn primary"
                disabled={!canSave}
                title={saveDisabledReason ?? undefined}
                onClick={save}
              >
                <Icon name="check2" size={14} /> {saving ? '…' : t('save')}
              </button>
            </div>
            {saveDisabledReason && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', maxWidth: 320, textAlign: 'right' }}>
                {saveDisabledReason}
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          line={lines[activeIdx]}
          idx={activeIdx}
          editing
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          duplicateOnLines={dupByIdx.get(activeIdx)}
        />
      )}

      {showDelete && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !deleting) setShowDelete(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--neg-soft)', color: 'var(--neg)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="trash" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('deleteOrderTitle', { id: order.id })}</div>
                  <div className="modal-sub">
                    {t('eoDeleteSubFull')}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="label">
                  {t('dangerTypeToConfirmPrefix')} <span className="mono">{order.id}</span> {t('dangerTypeToConfirmSuffix')}
                </label>
                <input
                  className="input mono"
                  value={typedId}
                  onChange={e => setTypedId(e.target.value)}
                  placeholder={order.id}
                  autoFocus
                  disabled={deleting}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => setShowDelete(false)}
                disabled={deleting}
              >
                {t('cancel')}
              </button>
              <button
                className="btn"
                style={{
                  background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)',
                  opacity: deleting || typedId !== order.id ? 0.5 : 1,
                }}
                disabled={deleting || typedId !== order.id}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteOrder(order.id);
                    onCancel();
                  } catch (e) {
                    handleFetchError(e);
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '…' : t('deleteOrder')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showArchive && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !archiving) setShowArchive(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  // Cool/violet tone — deliberately distinct from the destructive
                  // red of Delete. Archive is reversible; the colour should not
                  // alarm.
                  background: 'oklch(0.96 0.04 295)', color: 'oklch(0.45 0.16 295)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="box" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('eoArchiveModalTitle', { id: order.id })}</div>
                  <div className="modal-sub">
                    {t('eoArchiveModalBody')}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setShowArchive(false)} disabled={archiving}>
                {t('cancel')}
              </button>
              <button
                className="btn accent"
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    await archiveOrder(order.id);
                    onSaved(t('orderArchivedToast'));
                  } catch (e) {
                    handleFetchError(e);
                    setArchiving(false);
                    setShowArchive(false);
                  }
                }}
              >
                {archiving ? '…' : t('archiveOrder')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dupConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !saving) setDupConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="alert" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('dupPartModalTitle')}</div>
                  <div className="modal-sub">{t('dupPartModalSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {dupConfirm.map(g => (
                  <li key={g.partNumber.toLowerCase()}>
                    {(g.lineNums.length === 1 ? t('dupPartModalRowOne') : t('dupPartModalRowMany'))
                      .replace('{pn}', g.partNumber)
                      .replace('{nums}', g.lineNums.join(', '))}
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDupConfirm(null)} disabled={saving}>
                {t('dupPartReview')}
              </button>
              <button
                className="btn primary"
                disabled={saving}
                onClick={async () => { setDupConfirm(null); await doSave(); }}
              >
                {saving ? '…' : t('dupPartSaveAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} alt={t('aiPhotoLabel')} onClose={() => setLightboxUrl(null)} />
      )}

      {doneDialogOpen && (
        <StatusChangeDialog
          orderId={order.id}
          to="Done"
          currentStatus={effectiveStatus}
          initialNote={doneNote}
          initialAttachments={doneAttachments}
          apiBase="/api/orders"
          variant="purchase"
          onCancel={() => setDoneDialogOpen(false)}
          onConfirm={({ note, attachments }) => {
            setDoneNote(note);
            setDoneAttachments(attachments);
            setDoneDialogOpen(false);
            setStatus('Done');
          }}
          onMutated={() => setActivityKey(k => k + 1)}
        />
      )}
    </>
  );
}

// ─── Conversion helpers ──────────────────────────────────────────────────────
function orderLineToEditLine(l: OrderLine): EditLine {
  return {
    _cid:           crypto.randomUUID(),
    _id:            l.id,
    _status:        l.status,
    category:       l.category,
    brand:          l.brand ?? undefined,
    capacity:       l.capacity ?? undefined,
    type:           l.type ?? undefined,
    generation:     l.generation ?? undefined,
    classification: l.classification ?? undefined,
    rank:           l.rank ?? undefined,
    speed:          l.speed ?? undefined,
    interface:      l.interface ?? undefined,
    formFactor:     l.formFactor ?? undefined,
    description:    l.description ?? undefined,
    partNumber:     l.partNumber ?? undefined,
    serialNumber:   l.serialNumber ?? undefined,
    chipNumber:     l.chipNumber ?? undefined,
    condition:      l.condition,
    qty:            l.qty,
    unitCost:       l.unitCost,
    sellPrice:      l.sellPrice ?? undefined,
    scanImageId:    l.scanImageId ?? undefined,
    scanImageUrl:   l.scanImageUrl ?? undefined,
    health:         l.health,
    rpm:            l.rpm,
  };
}

function editLineToPatch(l: EditLine, status?: string) {
  const sp = l.sellPrice;
  return {
    id:             l._id!,
    status,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    generation:     l.generation ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
  };
}

function editLineToInsert(l: EditLine, status: string) {
  const sp = l.sellPrice;
  return {
    category:       l.category,
    status,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    generation:     l.generation ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
  };
}
