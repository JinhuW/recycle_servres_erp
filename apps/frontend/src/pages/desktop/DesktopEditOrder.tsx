import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../../lib/api';
import { handleFetchError, showErrorToast } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import { poEffectiveCost, parseFeeInput, GOODS_EPSILON } from '../../lib/poTotals';
import type { Category, Order, OrderLine, Warehouse } from '../../lib/types';
import {
  LineDrawer, blankLine, findDuplicatePartNumbers,
  type Line, type DuplicatePartGroup,
} from './DesktopSubmit';
import { AddLineMenu } from './submit/AddLineMenu';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import { linePhotos, uploadLinePhoto, deleteLinePhoto, type LinePhoto } from '../../lib/linePhotos';
import { groupLines, shouldGroup, catTone } from '../../lib/lineGroups';
import { CostTape } from '../../components/CostTape';
import { useMarketLookup } from '../../lib/useMarketLookup';
import { ImageLightbox } from '../../components/ImageLightbox';
import { serialIssue } from '@recycle-erp/shared';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { OrderActivityLog } from '../../components/OrderActivityLog';
import { StatusChangeDialog, type StatusAttachment } from '../../components/StatusChangeDialog';
import { AttachmentChip } from '../../components/AttachmentChip';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';



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
  // Notes and submission evidence outlive the purchaser's edit window: the
  // manager owns pricing from Reviewing on, but whoever raised the PO can keep
  // documenting it until Done. Mirrors the backend's notes-only gate.
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canAnnotate = !orderLocked && isOwnerOrManager;
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
  // Owner may edit until the order is Done; managers always. Mirrors the
  // backend gate.
  const canEditSubmission = canAnnotate;

  const addSubmissionFiles = async (fl: FileList | null) => {
    const files = Array.from(fl || []);
    if (!files.length) return;
    setSubmissionUploading(true);
    try {
      for (const f of files) {
        // 50 MiB server hard cap; oversized images are shrunk server-side.
        if (f.size > 50 * 1024 * 1024) {
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

  // Done evidence stays editable after the transition — the dialog only opens
  // on the way into Done, so without this a wrong photo was stuck forever.
  // Manager-only, mirroring the backend canWriteMeta gate.
  const removeDoneAtt = async (att: StatusAttachment) => {
    try {
      await api.delete<{ ok: true }>(`/api/orders/${order.id}/status-meta/Done/attachments/${att.id}`);
      setDoneAttachments(prev => prev.filter(a => a.id !== att.id));
      setActivityKey(k => k + 1);
    } catch (e) {
      handleFetchError(e);
    }
  };
  const [activityKey, setActivityKey] = useState(0);
  const [lines, setLines] = useState<EditLine[]>(() => order.lines.map(orderLineToEditLine));
  const [photoBusy, setPhotoBusy] = useState(false);

  // Photos upload immediately here: unlike the submit screen, every line on an
  // existing order already has a DB id to attach them to.
  const addLinePhotos = async (idx: number, files: FileList | null) => {
    const l = lines[idx];
    const picked = Array.from(files ?? []).filter(f => f.type.startsWith('image/'));
    if (!l?._id || !picked.length) return;
    setPhotoBusy(true);
    try {
      for (const f of picked) {
        try {
          const r = await uploadLinePhoto(order.id, l._id, f);
          setLines(ls => ls.map((x, j) => (j === idx ? { ...x, photos: [...(x.photos ?? []), r.photo] } : x)));
        } catch { showErrorToast(t('linePhotoUploadFailed')); }
      }
    } finally { setPhotoBusy(false); }
  };

  const removeLinePhoto = async (idx: number, photo: LinePhoto) => {
    const l = lines[idx];
    if (!l?._id) return;
    try {
      await deleteLinePhoto(order.id, l._id, photo.id);
      setLines(ls => ls.map((x, j) =>
        (j === idx ? { ...x, photos: (x.photos ?? []).filter(p => p.id !== photo.id) } : x)));
    } catch { showErrorToast(t('linePhotoDeleteFailed')); }
  };
  // Line ids that exist in the DB. Seeded from the server's set and grown by
  // the drawer's Confirm-line write-through — `order.lines` is a snapshot from
  // page load and never learns about those, so a line added+confirmed and then
  // removed would otherwise be missed by save()'s removeLineIds diff.
  const [persistedIds, setPersistedIds] = useState<string[]>(() => order.lines.map(l => l.id));
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
  // Fees are charged on top of the goods total, so they get their own input
  // rather than being folded into the override. '' renders as no fee.
  const [otherFeesInput, setOtherFeesInput] = useState<string>(
    order.otherFees > 0 ? order.otherFees.toFixed(2) : '',
  );
  const [otherFeesNote, setOtherFeesNote] = useState<string>(order.otherFeesNote ?? '');
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
  const canArchive = isOwnerOrManager && effectiveStatus !== 'Draft';
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // Filled when save() detects duplicate part numbers; the modal then drives a
  // "Save anyway" path that bypasses the check.
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // Serial-rule violations (DDR5 requires serials; serial count must equal
  // qty) caught at save time — shown as a blocking dialog, nothing persists.
  const [serialIssues, setSerialIssues] = useState<SerialLineIssue[] | null>(null);

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

  const addLine = (cat: Category) => {
    setLines(ls => [...ls, { ...blankLine(cat), _dirty: true }]);
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

  const marketFor = useMarketLookup(lines.map(l => l.partNumber));

  // ── Category grouping ──────────────────────────────────────────────────
  // Only when the PO actually spans categories: a single-category order gets
  // one header restating a total the ledger already shows, which is noise.
  const groups = useMemo(() => groupLines(lines), [lines]);
  const grouped = useMemo(() => shouldGroup(lines), [lines]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (cat: string) => setFolded(prev => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  // The table walks this instead of `lines`, so grouped rows come out
  // contiguous (position order interleaves categories) while every row keeps
  // the index its handlers were written against.
  const displayRows = useMemo(() => {
    if (!grouped) return lines.map((line, index) => ({ line, index, head: null as React.ReactNode }));
    return groups.flatMap(g => g.lines.map(({ line, index }, k) => ({
      line,
      index,
      head: k === 0 ? (
        <tr className="grp-row" style={catTone(g.category)}>
          <td colSpan={canEditOrder ? 9 : 8}>
            <button
              type="button"
              className="grp-hd"
              aria-expanded={!folded.has(g.category)}
              onClick={e => { e.stopPropagation(); toggleFold(g.category); }}
            >
              <span className={'grp-tw' + (folded.has(g.category) ? ' closed' : '')}>
                <Icon name="chevronDown" size={13} />
              </span>
              <span className="grp-chip">{g.category}</span>
              <span className="grp-meta">
                {g.lines.length === 1
                  ? t('historyLineCountOne', { n: g.lines.length })
                  : t('historyLineCountMany', { n: g.lines.length })}
                {' · '}{t('grpUnits', { n: g.units.toLocaleString(locale) })}
                {g.unpriced > 0 && <span className="grp-unpriced"> · {t('grpUnpriced', { n: g.unpriced })}</span>}
              </span>
              <span className="grp-amt mono">{fmtUSD(g.goods, locale)}</span>
              <span className={'grp-pl mono ' + (g.profit > 0 ? 'pos' : g.profit < 0 ? 'neg' : 'muted')}>
                {g.profit ? (g.profit > 0 ? '+' : '−') + fmtUSD(Math.abs(g.profit), locale) : '—'}
              </span>
            </button>
          </td>
        </tr>
      ) : null,
    })));
  // toggleFold is stable enough for this render-derived list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, groups, lines, folded, canEditOrder, locale, t]);

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
    let pricedCount = 0, pricedProfit = 0, pricedCost = 0;
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
        pricedCost += q * c;
      }
    }
    return { qty, cost, revenue, profit, pricedCount, pricedProfit, pricedCost };
  }, [lines]);

  const statusDirty = status !== effectiveStatus;
  const linesDirty = lines.some(l => l._dirty) || lines.length !== persistedIds.length;
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

  // Non-numeric intermediate input ("5e") must not read as a change — same
  // guard as totalCostDirty above.
  const parsedOtherFees = parseFeeInput(otherFeesInput);
  const otherFeesDirty = parsedOtherFees !== order.otherFees;
  const otherFeesNoteDirty = otherFeesNote.trim() !== (order.otherFeesNote ?? '');

  // The goods total is no longer editable here: it is the sum of the lines, and
  // anything paid on top of the goods is the fee — so line costs + fee is what
  // the purchaser actually paid, with nothing to reconcile between two fields.
  // A legacy order that carries a stored override keeps it (totalCostOverride
  // is seeded from the record and never set again), so historical goods totals
  // are preserved rather than silently rewritten on the next save.

  // Derived values for the side Payment-detail panel.
  // Self pay → the purchaser is reimbursed for what they paid out of pocket
  // (effectiveTotalCost) AND earns commission on profit. Company pay → only
  // the commission on profit. When the manager/purchaser overrides Goods total,
  // that override is the authoritative goods cost for EVERY part of the formula
  // — including (Revenue − Cost), so the commission preview reconciles cleanly
  // with the Self-pay reimbursement instead of mixing two cost figures. Fees
  // land on top of it, so they reduce profit and therefore commission.
  const cost = poEffectiveCost({
    lineSubtotal: totals.cost,
    totalCostOverride: totalCostOverride ? parsedTotalCost : null,
    otherFees: parsedOtherFees,
  });
  const effectiveTotalCost = cost.total;
  const effectiveProfit = totals.revenue - effectiveTotalCost;
  const commissionRateApplied = commissionRateValue ?? 0;
  const commissionOnProfit = effectiveProfit * commissionRateApplied;
  const purchaserEarn =
    (payment === 'self' ? effectiveTotalCost : 0) + commissionOnProfit;

  const dirty =
    statusDirty || linesDirty || notesDirty || warehouseDirty || paymentDirty || totalCostDirty
    || commissionDirty || otherFeesDirty || otherFeesNoteDirty;

  const lineReady = (l: EditLine) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other'
      ? !!l.description && !!(l.itemType ?? '').trim()
      : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  };
  // A note-only save (purchaser past In Transit) sends no lines, so an
  // incomplete legacy line must not block it — they can't fix it at that stage.
  const canSave =
    dirty && !saving && !orderLocked && (!canEditOrder || lines.every(lineReady));

  // Serial rules fire only where the backend's will: on new lines, and on
  // edits that change serial/qty/generation from what the server holds.
  // Untouched legacy serial-less lines stay saveable for price/status.
  const originalById = useMemo(() => {
    const m = new Map<string, EditLine>();
    for (const ol of order.lines) m.set(ol.id, orderLineToEditLine(ol));
    return m;
  }, [order.lines]);
  const changesSerialFields = (l: EditLine): boolean => {
    const o = l._id ? originalById.get(l._id) : undefined;
    if (!o) return true;
    return (l.generation ?? null) !== (o.generation ?? null)
      || Number(l.qty) !== Number(o.qty)
      || (l.serialNumber ?? '') !== (o.serialNumber ?? '');
  };
  const serialIssueFor = (l: EditLine) => (changesSerialFields(l) ? serialIssue(l) : null);

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
      // Past the purchaser's edit window only the note is theirs to change;
      // sending the line/pricing keys too would trip the backend's 403.
      if (!canEditOrder) {
        if (notesDirty) await api.patch(`/api/orders/${order.id}`, { notes });
        onSaved('Saved ' + order.id);
        return;
      }
      const presentIds = new Set(lines.filter(l => l._id).map(l => l._id!));
      const removeLineIds = persistedIds.filter(id => !presentIds.has(id));
      await api.patch(`/api/orders/${order.id}`, {
        notes:         notesDirty     ? notes                  : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)  : undefined,
        payment:       paymentDirty   ? payment                : undefined,
        commissionRate: commissionDirty ? commissionRateValue : undefined,
        totalCost:     totalCostDirty ? parsedTotalCost        : undefined,
        otherFees:     otherFeesDirty ? parsedOtherFees        : undefined,
        otherFeesNote: otherFeesNoteDirty ? (otherFeesNote.trim() || null) : undefined,
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
    const issues = lines
      .map((l, idx) => ({ lineNo: idx + 1, label: l.partNumber || itemType(l), issue: serialIssueFor(l) }))
      .filter((x): x is SerialLineIssue => x.issue !== null);
    if (issues.length) {
      setSerialIssues(issues);
      return;
    }
    if (dupGroups.length > 0) {
      setDupConfirm(dupGroups);
      return;
    }
    await doSave();
  };

  // Drawer "Confirm line" writes that one line straight to the DB instead of
  // parking it in local state until Save. Closing the tab after confirming
  // therefore loses nothing — matching what Confirm already means on the
  // new-order screen. Save still exists for order-level fields and the stage.
  // Throws on failure so the drawer keeps itself open and shows the reason.
  const confirmLine = async (i: number): Promise<void> => {
    const l = lines[i];
    if (!l) return;
    if (!lineReady(l)) throw new Error(t('subFillThisLine'));
    // Nothing to push for an untouched server line; skip the round trip.
    if (l._id && !l._dirty) return;
    const issue = serialIssueFor(l);
    if (issue) {
      setSerialIssues([{ lineNo: i + 1, label: l.partNumber || itemType(l), issue }]);
      // Thrown so the drawer keeps itself open for the fix.
      throw new Error(t('serialCheckTitle'));
    }
    const r = await api.patch<{ ok: true; addedLineIds: string[] }>(
      `/api/orders/${order.id}`,
      l._id
        ? { lines: [editLineToPatch(l)] }
        : { addLines: [editLineToInsert(l, status)] },
    );
    const newId = l._id ?? r.addedLineIds[0];
    setLines(ls => ls.map((x, j) => (j === i ? { ...x, _id: newId, _dirty: false } : x)));
    if (!l._id && newId) setPersistedIds(ids => [...ids, newId]);
    setActivityKey(k => k + 1);
    window.__showToast?.(t('drawerLineSaved', { n: i + 1 }), 'success');
  };

  const itemType = (l: EditLine) =>
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
            <OrderCategoryChips categories={order.categories} max={3} />
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
            <div className="card-sub">{t('subOrderContainsMixed')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.qty, cost: fmtUSD(totals.cost, locale) })}</span>
            <span className="chip mono">{order.id} · {t('subStatusEditing')}</span>
            {canEditOrder && (
              <span style={{ marginLeft: 'auto' }}><AddLineMenu onAdd={addLine} /></span>
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
              {displayRows.map(({ line: l, index: i, head }) => {
                const qty = Number(l.qty) || 0;
                const lCost = Number(l.unitCost) || 0;
                const sp = l.sellPrice == null || l.sellPrice === '' ? 0 : Number(l.sellPrice);
                const profit = qty * (sp - lCost);
                const lossy = sp > 0 && sp < lCost;
                const filled = !!l.brand || !!l.description;
                const isActive = i === activeIdx;
                // A folded group still emits its header row, just none of its
                // lines — otherwise the group would vanish along with them.
                // Every member drops out, not only the one carrying the head.
                if (folded.has(l.category)) {
                  return head ? <Fragment key={'g-' + l.category}>{head}</Fragment> : null;
                }
                // Rows open the drawer at every stage — a locked order gets a
                // read-only drawer, not an unreachable one.
                return (
                  <Fragment key={l._id ?? l._cid}>
                  {head}
                  <tr
                    className="row-hover"
                    style={{
                      cursor: 'pointer',
                      background: isActive ? 'var(--accent-soft)' : undefined,
                    }}
                    onClick={() => setActiveIdx(i)}
                  >
                    <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {(() => {
                          // Any line may carry photos now, not just the RAM
                          // ones an AI scan happened to produce. Shows the
                          // first with a +N when there are more.
                          const shots = linePhotos(l);
                          if (!shots.length) return null;
                          return (
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); setLightboxUrl(shots[0].url); }}
                              title={t('linePhotos')}
                              style={{
                                width: 40, height: 40, borderRadius: 8, flexShrink: 0, position: 'relative',
                                border: '1px solid var(--border)', overflow: 'hidden',
                                padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                              }}
                            >
                              <img
                                src={shots[0].url}
                                alt={t('linePhotos')}
                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                              />
                              {shots.length > 1 && (
                                <span style={{
                                  position: 'absolute', right: 0, bottom: 0,
                                  background: 'rgba(15,23,42,0.72)', color: 'white',
                                  fontSize: 9, fontWeight: 700, padding: '1px 4px',
                                  borderTopLeftRadius: 5,
                                }}>+{shots.length - 1}</span>
                              )}
                            </button>
                          );
                        })()}
                        <div style={{ minWidth: 0 }}>
                          {filled ? (
                            <>
                              <div style={{ fontWeight: 500 }}>{itemType(l)}</div>
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
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* The PO's money as a receipt — see components/CostTape. The fee is
            the one editable cell in it: a cost that never was a line. */}
        <div className="oe-items-foot">
          <CostTape
            groups={groups}
            grouped={grouped}
            lineCount={lines.length}
            units={totals.qty}
            goods={cost.goods}
            fees={cost.fees}
            total={effectiveTotalCost}
            revenue={totals.revenue}
            pricedCost={totals.pricedCost}
            pricedProfit={totals.pricedProfit}
            pricedCount={totals.pricedCount}
            coveragePct={totals.cost > 0 ? (totals.pricedCost / totals.cost) * 100 : 100}
            locale={locale}
            feeField={canEditOrder ? (
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span className="mono oe-ledger-currency" aria-hidden="true">$</span>
                <input
                  id="oe-other-fees"
                  className="input mono tape-money"
                  type="number"
                  min={0}
                  step="0.01"
                  value={otherFeesInput}
                  placeholder="0.00"
                  onChange={e => setOtherFeesInput(e.target.value)}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 22 }}
                />
              </span>
            ) : undefined}
            feeNoteField={canEditOrder ? (
              <input
                className="input tape-note"
                type="text"
                maxLength={280}
                value={otherFeesNote}
                placeholder={t('otherFeesPh')}
                onChange={e => setOtherFeesNote(e.target.value)}
                aria-label={t('otherFeesNote')}
              />
            ) : (otherFeesNote.trim() ? <span className="muted" style={{ fontSize: 11.5 }}>{otherFeesNote.trim()}</span> : undefined)}
          />
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
            {/* Cost above is all-in. Break the fee out beneath it so the number
                is never an unexplained jump — indented, so it reads as part of
                the row above rather than a fourth peer figure. */}
            {cost.fees > 0 && (
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginTop: -3, paddingLeft: 10, fontSize: 11.5, color: 'var(--fg-subtle)',
              }}>
                <span>{t('otherFees')}{otherFeesNote.trim() ? ` · ${otherFeesNote.trim()}` : ''}</span>
                <span className="mono">{fmtUSD(cost.fees, locale)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('eoProfitAllLines', { n: lines.length })}</span>
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
              {doneAttachments.map(a => (
                <AttachmentChip
                  key={a.id}
                  a={a}
                  onRemove={!isPurchaser ? () => removeDoneAtt(a) : undefined}
                />
              ))}
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
                disabled={!canAnnotate}
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
              {t('totalCost')} {totalCostOverride && Math.abs((parsedTotalCost ?? 0) - totals.cost) > GOODS_EPSILON && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(cost.total, locale)}
            </div>
            {cost.fees > 0 && (
              <div style={{ fontSize: 11, color: 'var(--accent-strong)', marginTop: 1 }}>
                {t('inclFees', { fees: fmtUSD(cost.fees, locale) })}
              </div>
            )}
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
          onConfirmLine={() => confirmLine(activeIdx)}
          onConfirmError={showErrorToast}
          duplicateOnLines={dupByIdx.get(activeIdx)}
          readOnly={!canEditOrder}
          market={marketFor(lines[activeIdx].partNumber)}
          photoCtx={{
            orderId: order.id,
            // A line added in this session isn't persisted until Save, so it
            // has no id to hang a photo off yet — the strip goes read-only
            // rather than silently dropping the file.
            lineId: lines[activeIdx]._id ?? null,
            pending: [],
            onAddFiles: files => void addLinePhotos(activeIdx, files),
            onRemovePending: () => { /* nothing is buffered on this screen */ },
            onRemoveSaved: photo => void removeLinePhoto(activeIdx, photo),
            busy: photoBusy,
          }}
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

      {serialIssues && (
        <SerialCheckDialog issues={serialIssues} onClose={() => setSerialIssues(null)} />
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
    photos:         l.photos ?? [],
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
    itemType:      l.itemType ?? undefined,
    partNumber:     l.partNumber ?? undefined,
    serialNumber:   l.serialNumber ?? undefined,
    chipNumber:     l.chipNumber ?? undefined,
    condition:      l.condition,
    qty:            l.qty,
    // An unpriced line (purchaser raised it, manager prices it at Reviewing)
    // opens the drawer blank rather than with a 0 to clear first.
    unitCost:       l.unitCost || '',
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
    // Sent so a recategorisation made in the drawer survives Save. Without it
    // the backend keeps the stored category and silently drops the change.
    category:       l.category,
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
    itemType:      l.itemType ?? null,
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
    itemType:      l.itemType ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
  };
}
