import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../../lib/api';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import { poEffectiveCost, parseFeeInput, feeEq, readStoredGoodsTotal } from '../../lib/poTotals';
import { normalizePaypalTxnInput } from '../../lib/paypalTxn';
import type { Category, Order, OrderLine, Warehouse } from '../../lib/types';
import {
  LineDrawer, blankLine, findDuplicatePartNumbers,
  type Line, type DuplicatePartGroup,
} from './DesktopSubmit';
import { AddLineMenu } from './submit/AddLineMenu';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import {
  linePhotos, deleteLinePhoto, uploadedPhotoCount, useLinePhotoBuffer,
  type LinePhoto, type PendingPhoto,
} from '../../lib/linePhotos';
import { groupLines, shouldGroup, displayRows, catTone, pricedTotals } from '../../lib/lineGroups';
import { CostTape } from '../../components/CostTape';
import { useMarketLookup } from '../../lib/useMarketLookup';
import { ImageLightbox } from '../../components/ImageLightbox';
import { serialIssue, isPricedSellPrice } from '@recycle-erp/shared';
import { lineRequirements, missingFieldNames } from '../../lib/lineRequirements';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { OrderActivityLog } from '../../components/OrderActivityLog';
import { RevertNoticeDialog } from '../../components/RevertNoticeDialog';
import { navigate } from '../../lib/route';
import { listShipments } from '../../lib/api';

// The backend folds prepaid-label costs into orders.other_fees and appends
// "Shipping label <tracking>" entries to its note (a dedicated column is
// pending the backend phase). The UI un-folds them: label spend renders as its
// own read-only Shipping row, the editable Other-fees cell holds only the
// user's remainder, and saves re-attach the shipping parts so the stored
// column round-trips unchanged.
const SHIP_NOTE_RE = /^(Shipping label |Label voided )/;
function splitFeeNote(note: string | null): { userNote: string; shipNotes: string[] } {
  const segs = (note ?? '').split(' | ').map(s => s.trim()).filter(Boolean);
  return {
    userNote: segs.filter(s => !SHIP_NOTE_RE.test(s)).join(' | '),
    shipNotes: segs.filter(s => SHIP_NOTE_RE.test(s)),
  };
}
// Voided labels were already subtracted server-side; these still count.
const LIVE_LABEL_STATUSES = new Set(['purchased', 'in_transit', 'delivered', 'exception']);
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
  // The purchaser keeps their order until it is Done. Editing it after
  // submission is allowed and costs them the stage: the backend sends it back
  // to Draft, so `revertOnSave` warns before the first such save.
  const purchaserCanEdit = !isPurchaser || !orderLocked;
  const canEditOrder = purchaserCanEdit && !orderLocked;
  const revertOnSave = isPurchaser && !orderLocked && effectiveStatus !== 'Draft';
  // Notes and submission evidence outlive the purchaser's edit window: the
  // manager owns pricing from Reviewing on, but whoever raised the PO can keep
  // documenting it until Done. Mirrors the backend's notes-only gate.
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canAnnotate = !orderLocked && isOwnerOrManager;
  // A Done order is a closed book, but managers keep one backward move:
  // send it back to Reviewing (the backend guards lines committed to open
  // sell orders). Everything else stays read-only until that reopen lands.
  const canReopen = !isPurchaser && orderLocked;
  const [status, setStatus] = useState(effectiveStatus);
  // The stage as last written. Normally the one the page opened with, but a
  // save that has to keep the user here (a photo upload that failed) has
  // already advanced the order — re-sending it would step it on again.
  const [savedStatus, setSavedStatus] = useState(effectiveStatus);
  // Submitting is the one stage move a purchaser makes. Everything after it is
  // the manager's, and a purchaser edit moves the stage on its own — so past
  // Draft the stepper offers nothing to pick.
  //
  // Keyed off `savedStatus`, not the `order` prop: an edit that sent the order
  // back to Draft has already moved the stage, and the prop does not refetch
  // while this page is open. Reading the prop leaves the purchaser told to
  // "submit it again" with only the stage they just left on offer.
  const allowedStatuses = isPurchaser
    ? savedStatus === 'Draft' ? ['Draft', 'In Transit'] : [savedStatus]
    : ORDER_STATUSES.slice();
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
          showErrorDialog(t('fileTooLarge', { name: f.name }));
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
  // Files picked for a line that has no DB id to hang them off yet — one added
  // in this session and not yet confirmed. Keyed by _cid, the only handle such
  // a line has, and flushed once the id lands.
  const photos = useLinePhotoBuffer((cid, saved) =>
    setLines(ls => ls.map(l =>
      (l._cid === cid ? { ...l, photos: [...(l.photos ?? []), ...saved] } : l))));

  // Upload what was buffered for a line, now that it has an id. Returns how
  // many are still queued because their upload failed: those keep their File
  // and their preview, since it is the only copy of that picture there is.
  const flushPendingPhotos = async (
    cid: string, lineId: string, items?: PendingPhoto[],
  ): Promise<number> => (await photos.flush(cid, order.id, lineId, items)).failed.length;

  // A line that came from the server has somewhere to put a photo right away;
  // one added in this session doesn't until Confirm line or Save gives it an id.
  const addLinePhotos = (idx: number, files: FileList | null) => {
    const l = lines[idx];
    if (!l) return;
    const added = photos.add(l._cid, uploadedPhotoCount(l.photos), files);
    if (!added.length || !l._id) return;
    void flushPendingPhotos(l._cid, l._id, added)
      .then(failed => { if (failed) showErrorDialog(t('linePhotoUploadFailed')); });
  };

  // Photos held against a line that already has somewhere to put them: an
  // upload that failed, nothing else. What the Retry action offers.
  const retryablePhotos = lines.reduce(
    (n, l) => n + (l._id ? photos.queuedFor(l._cid).length : 0), 0);

  // Set when a save wrote the order but left photos behind: the page has to
  // stay put, so it also owes the user the exit once they are uploaded.
  const [heldAfterSave, setHeldAfterSave] = useState(false);

  const retryQueuedPhotos = async () => {
    const flushed = await Promise.all(lines
      .filter(l => l._id && photos.queuedFor(l._cid).length)
      .map(l => flushPendingPhotos(l._cid, l._id!)));
    if (flushed.reduce((a, b) => a + b, 0) > 0) {
      showErrorDialog(t('linePhotoUploadFailed'));
      return;
    }
    if (heldAfterSave) onSaved('Saved ' + order.id);
  };

  const removeLinePhoto = async (idx: number, photo: LinePhoto) => {
    const l = lines[idx];
    if (!l?._id) return;
    try {
      await deleteLinePhoto(order.id, l._id, photo.id);
      setLines(ls => ls.map((x, j) =>
        (j === idx ? { ...x, photos: (x.photos ?? []).filter(p => p.id !== photo.id) } : x)));
    } catch { showErrorDialog(t('linePhotoDeleteFailed')); }
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
  // Fees are charged on top of the goods total, so they get their own input
  // rather than being folded into the override. '' renders as no fee.
  const [otherFeesInput, setOtherFeesInput] = useState<string>(
    order.otherFees > 0 ? order.otherFees.toFixed(2) : '',
  );
  const [otherFeesNote, setOtherFeesNote] = useState<string>(order.otherFeesNote ?? '');
  // Kept in the server's canon (uppercase, no spaces) so dirty-compare is
  // exact against what a save round-trips.
  const [paypalTxn, setPaypalTxn] = useState<string>(order.paypalTxnId ?? '');
  // null until the PO's shipments load; the fee inputs then re-seed to the
  // user-only remainder. Clamped to the stored column so the tape's rows
  // always sum to exactly what the server holds, even after manual fee edits.
  const [shipSplit, setShipSplit] = useState<{ fees: number; notes: string[] } | null>(null);
  useEffect(() => {
    let alive = true;
    listShipments(order.id)
      .then(({ items }) => {
        if (!alive) return;
        const raw = items
          .filter(s => LIVE_LABEL_STATUSES.has(s.status) && s.labelCost != null)
          .reduce((sum, s) => sum + (s.labelCost ?? 0), 0);
        const fees = Math.min(raw, order.otherFees);
        const { userNote, shipNotes } = splitFeeNote(order.otherFeesNote);
        setShipSplit({ fees, notes: shipNotes });
        if (fees > 0 || shipNotes.length) {
          const remainder = order.otherFees - fees;
          setOtherFeesInput(remainder > 0 ? remainder.toFixed(2) : '');
          setOtherFeesNote(userNote);
        }
      })
      .catch(() => { if (alive) setShipSplit({ fees: 0, notes: [] }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);
  const shipFees = shipSplit?.fees ?? 0;
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  // A reverted order is a Draft again, but it is not a fresh one: once it has
  // been submitted the record stays, and archive is the way to hide it.
  const canDelete = canEditOrder && effectiveStatus === 'Draft' && !order.everSubmitted;

  // Archive: owner-or-manager, any non-Draft stage. Either flips to the other.
  // (Draft uses Delete instead; the backend enforces the same split.)
  const isArchived = !!order.archivedAt;
  // Mirrors the backend: a reverted order is a Draft that HAS been submitted,
  // and Delete refuses exactly those — so Archive has to take it, or the order
  // offers neither. Unarchiving is always available once archived.
  const canArchive = isOwnerOrManager
    && (!!order.archivedAt || effectiveStatus !== 'Draft' || !!order.everSubmitted);
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // Filled when save() detects duplicate part numbers; the modal then drives a
  // "Save anyway" path that bypasses the check.
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // Serial-rule violations (DDR5 requires serials; serial count must equal
  // qty) caught at save time — shown as a blocking dialog, nothing persists.
  const [serialIssues, setSerialIssues] = useState<SerialLineIssue[] | null>(null);
  // Holds the answer callback while the "this returns the order to Draft"
  // warning is up; acknowledging once covers the rest of the visit.
  const [revertConfirm, setRevertConfirm] = useState<((ok: boolean) => void) | null>(null);
  const [revertAcked, setRevertAcked] = useState(false);
  // The purchaser's unreviewed changes, shown to a manager opening the order.
  const [pendingRevert, setPendingRevert] = useState(order.pendingRevert ?? []);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => { if (alive) setWarehouses(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // A manager may hand the PO to a different purchaser (or take it back) at
  // any stage short of Done — ownership drives commission and "my orders".
  const [ownerId, setOwnerId] = useState(order.userId);
  const [purchasers, setPurchasers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (isPurchaser) return;
    let alive = true;
    api.get<{ items: { id: string; name: string; role: string }[] }>('/api/members')
      .then(r => { if (alive) setPurchasers(r.items.filter(m => m.role === 'purchaser')); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [isPurchaser]);
  const ownerDirty = ownerId !== order.userId;
  // The member list holds purchasers only; the current owner (possibly a
  // manager) and the signed-in manager both need a row so the select can
  // show the order as-is and offer "take it back".
  const ownerOptions = useMemo(() => {
    const opts = purchasers.map(p => ({ ...p }));
    const ensure = (id?: string, name?: string | null) => {
      if (!id || opts.some(o => o.id === id)) return;
      opts.unshift({ id, name: name ?? id });
    };
    ensure(order.userId, order.userName);
    ensure(user?.id, user?.name);
    return opts;
  }, [purchasers, order.userId, order.userName, user?.id, user?.name]);

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

  // Which rows the table walks, and which the fold hides — see lib/lineGroups.
  // Kept out of the render so it can be tested without one.
  const rows = useMemo(
    () => displayRows(lines, groups, grouped, folded),
    [lines, groups, grouped, folded],
  );
  const groupByCat = useMemo(
    () => new Map(groups.map(g => [g.category, g])),
    [groups],
  );

  const groupHead = (category: string) => {
    const g = groupByCat.get(category);
    if (!g) return null;
    return (
      <tr className="grp-row" style={catTone(category)}>
        <td colSpan={canEditOrder ? 9 : 8}>
          <button
            type="button"
            className="grp-hd"
            aria-expanded={!folded.has(category)}
            onClick={e => { e.stopPropagation(); toggleFold(category); }}
          >
            <span className={'grp-tw' + (folded.has(category) ? ' closed' : '')}>
              <Icon name="chevronDown" size={13} />
            </span>
            <span className="grp-chip">{category}</span>
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
    );
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
    for (const l of lines) {
      const q = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      // An unpriced line still costs what it cost; it just earns nothing yet.
      const sp = isPricedSellPrice(l.sellPrice) ? Number(l.sellPrice) : 0;
      qty += q;
      cost += q * c;
      revenue += q * sp;
      profit += q * (sp - c);
    }
    // The priced subset — what can actually contribute to a realised
    // commission — through the rule the capture screen and the cost tape use.
    const priced = pricedTotals(lines);
    return {
      qty, cost, revenue, profit,
      pricedCount: priced.count, pricedProfit: priced.profit, pricedCost: priced.cost,
    };
  }, [lines]);

  const statusDirty = status !== savedStatus;
  const linesDirty = lines.some(l => l._dirty) || lines.length !== persistedIds.length;
  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  // '' = explicitly unset (null). Non-numeric intermediate input (e.g. "5e")
  // must NOT be treated as a change — the same guard the other-fees field uses.
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
  // Non-numeric intermediate input ("5e") must not read as a change.
  const parsedOtherFees = parseFeeInput(otherFeesInput);
  // Compare against the user-only part once the split is known; before that
  // the inputs still hold the raw column values, so the raw baseline applies.
  // Compared in cents, not as raw floats: the input is seeded from
  // `(order.otherFees - fees).toFixed(2)` while the baseline is the unrounded
  // subtraction, so `250.30 - 12.10` is 238.20000000000002 against an input of
  // "238.20" and a plain !== calls every labelled order dirty on mount — which
  // now costs a purchaser the stage for opening the page. The column is
  // NUMERIC(12,2); that is the precision a change has to show up at.
  const otherFeesDirty = !feeEq(
    parsedOtherFees,
    shipSplit ? order.otherFees - shipSplit.fees : order.otherFees,
  );
  const otherFeesNoteDirty = shipSplit
    ? otherFeesNote.trim() !== splitFeeNote(order.otherFeesNote).userNote
    : otherFeesNote.trim() !== (order.otherFeesNote ?? '');
  const paypalDirty = paypalTxn !== (order.paypalTxnId ?? '');

  // The goods total is no longer editable here: it is the sum of the lines, and
  // anything paid on top of the goods is the fee — so line costs + fee is what
  // the purchaser actually paid, with nothing to reconcile between two fields.
  //
  // The stored total is read straight off the record, never round-tripped
  // through form state, because no control on this page can change it. Whether
  // it is a negotiated lot price worth preserving or just a mirror of the lines
  // is settled ONCE, against the subtotal the order arrived with — the same
  // instant the backend settles it (services/orderGoodsTotal.ts). Judge it
  // against the live sum instead and every unit-cost edit turns the mirror into
  // a fake override: the tape, the footer and the commission preview all freeze
  // on the figure the page opened with, while the save that follows stores the
  // new one. A real negotiated price does stay pinned, and the tape and footer
  // say so rather than leaving the arithmetic looking wrong.
  const loadedLineSubtotal = useMemo(
    () => order.lines.reduce((sum, l) => sum + l.qty * l.unitCost, 0),
    [order.lines],
  );
  const storedGoods = useMemo(
    () => readStoredGoodsTotal(order.totalCost, loadedLineSubtotal),
    [order.totalCost, loadedLineSubtotal],
  );
  const goodsOverridden = storedGoods.negotiated;

  // Derived values for the side Payment-detail panel.
  // Self pay → the purchaser is reimbursed for what they paid out of pocket
  // (effectiveTotalCost) AND earns commission on profit. Company pay → only
  // the commission on profit. When the order carries a negotiated goods total,
  // that price is the authoritative goods cost for EVERY part of the formula
  // — including (Revenue − Cost), so the commission preview reconciles cleanly
  // with the Self-pay reimbursement instead of mixing two cost figures. Fees
  // land on top of it, so they reduce profit and therefore commission.
  const cost = poEffectiveCost({
    lineSubtotal: totals.cost,
    totalCostOverride: storedGoods.override,
    otherFees: parsedOtherFees + shipFees,
  });
  const effectiveTotalCost = cost.total;
  const effectiveProfit = totals.revenue - effectiveTotalCost;
  const commissionRateApplied = commissionRateValue ?? 0;
  const commissionOnProfit = effectiveProfit * commissionRateApplied;
  const purchaserEarn =
    (payment === 'self' ? effectiveTotalCost : 0) + commissionOnProfit;

  const dirty =
    statusDirty || linesDirty || notesDirty || warehouseDirty || paymentDirty
    || commissionDirty || otherFeesDirty || otherFeesNoteDirty || paypalDirty || ownerDirty;
  // What the backend reads as a change to the order itself — the set that
  // sends a purchaser's submitted order back to Draft. A note is not one.
  const materialDirty =
    linesDirty || warehouseDirty || paymentDirty || otherFeesDirty
    || otherFeesNoteDirty || paypalDirty;

  const lineReady = (l: EditLine) => lineRequirements(l).ready;
  // A note-only save (purchaser past In Transit) sends no lines, so an
  // incomplete legacy line must not block it — they can't fix it at that stage.
  // Line readiness gates only the saves that actually write lines. A note-only
  // save sends none, so an incomplete legacy line must not block it — the
  // purchaser can't fix that line at this stage anyway.
  const canSave =
    dirty && !saving && (!orderLocked || (canReopen && statusDirty))
    && (!canEditOrder || !(linesDirty || statusDirty) || lines.every(lineReady));

  // Localized "Brand, Quantity" list of what a line is still waiting on. The
  // capture screen asks the same question, and used to name the same blank
  // field by a different word.
  const missingNamesFor = (l: EditLine): string | null =>
    missingFieldNames(lineRequirements(l).missingKeys, t, lang);

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

  // Everything standing between the user and a save, one entry per problem.
  // Save stays clickable while these exist: clicking opens a dialog listing
  // them, which beats a dead button next to a hint that's easy to miss.
  const saveBlockers: string[] =
    saving || canSave  ? []
  : orderLocked        ? [t('saveBlockedLocked')]
  : !dirty             ? [t('saveBlockedNoChanges')]
  : lines.flatMap((l, i) => {
      if (lineReady(l)) return [];
      const fields = missingNamesFor(l);
      if (fields) {
        return [lines.length === 1
          ? t('subMissingFieldsThis', { fields })
          : t('subMissingFieldsLine', { n: i + 1, fields })];
      }
      return [lines.length === 1 ? t('subFillThisLine') : t('subFillLineN', { n: i + 1 })];
    });

  const attemptSave = () => {
    if (saveBlockers.length) {
      showErrorDialog(t('errCantSaveMsg'), saveBlockers, t('errCantSaveTitle'));
      return;
    }
    void save();
  };

  const doSave = async () => {
    setSaving(true);
    try {
      // Past the purchaser's edit window only the note is theirs to change;
      // sending the line/pricing keys too would trip the backend's 403.
      if (!canEditOrder) {
        if (notesDirty) await api.patch(`/api/orders/${order.id}`, { notes });
        // Manager reopening a Done order — the one stage move a closed order
        // accepts. /advance cascades line statuses server-side, so no line
        // patch is needed alongside it.
        if (statusDirty && !isPurchaser) {
          const toStage = Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === status);
          await api.post(`/api/orders/${order.id}/advance`, { toStage });
          setSavedStatus(status);
        }
        onSaved('Saved ' + order.id);
        return;
      }
      const presentIds = new Set(lines.filter(l => l._id).map(l => l._id!));
      const removeLineIds = persistedIds.filter(id => !presentIds.has(id));
      const addedLines = lines.filter(l => !l._id);
      const r = await api.patch<{ ok: true; addedLineIds: string[]; lifecycle: string }>(`/api/orders/${order.id}`, {
        notes:         notesDirty     ? notes                  : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)  : undefined,
        payment:       paymentDirty   ? payment                : undefined,
        commissionRate: commissionDirty ? commissionRateValue : undefined,
        paypalTxnId:   paypalDirty     ? (paypalTxn || null)   : undefined,
        onBehalfOfUserId: ownerDirty ? ownerId : undefined,
        otherFees:     otherFeesDirty ? parsedOtherFees + shipFees : undefined,
        otherFeesNote: otherFeesNoteDirty
          ? ([otherFeesNote.trim(), ...(shipSplit?.notes ?? [])].filter(Boolean).join(' | ') || null)
          : undefined,
        lines: lines
          .filter(l => l._id && (l._dirty || statusDirty))
          .map(l => editLineToPatch(l, statusDirty ? status : undefined)),
        addLines: addedLines.map(l => editLineToInsert(l, status)),
        removeLineIds: removeLineIds.length ? removeLineIds : undefined,
      });
      // addedLineIds comes back aligned 1:1 with the addLines we sent, so a
      // photo buffered against a line that had no id can finally reach it.
      // Before onSaved, which navigates away and takes the buffer with it.
      const idByCid = new Map<string, string>();
      addedLines.forEach((l, i) => { if (r.addedLineIds[i]) idByCid.set(l._cid, r.addedLineIds[i]); });
      // Written back before anything can keep the user on this page: a second
      // save must patch these lines, not append them a second time.
      setLines(ls => ls.map(l => {
        const id = idByCid.get(l._cid);
        return id ? { ...l, _id: id, _dirty: false } : (l._dirty ? { ...l, _dirty: false } : l);
      }));
      setPersistedIds([...persistedIds.filter(id => presentIds.has(id)), ...idByCid.values()]);
      let stillQueued = 0;
      for (const [cid, newId] of idByCid) stillQueued += await flushPendingPhotos(cid, newId);
      // A photo picked for an existing line whose upload failed is queued too,
      // and this is its last chance before the page goes away.
      for (const l of lines) {
        if (l._id && photos.queuedFor(l._cid).length) {
          stillQueued += await flushPendingPhotos(l._cid, l._id);
        }
      }
      // The stepper's stage lives on orders.lifecycle, which PATCH never
      // touches — only /advance moves it (and cascades the line statuses).
      // Without this the save returns 200, the lines flip, but the stage snaps
      // back on reload. Managers may jump straight to the target stage;
      // purchasers can only step forward and the backend rejects `toStage` for
      // them, so send an empty body to advance one stage.
      if (statusDirty) {
        const toStage = Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === status);
        await api.post(`/api/orders/${order.id}/advance`, isPurchaser ? {} : { toStage });
        setSavedStatus(status);
      } else {
        applyLifecycle(r.lifecycle);
      }
      // The order is saved either way, but those Files exist nowhere else and
      // this page is the only thing holding them — leaving now would discard
      // them. Retry is in the footer.
      if (stillQueued > 0) {
        setHeldAfterSave(true);
        showErrorDialog(t('linePhotoRetryHold', { n: stillQueued }));
        return;
      }
      onSaved('Saved ' + order.id);
    } catch (e) {
      // Keep the editor open and the user's edits intact on failure — calling
      // onSaved here would navigate away and discard unsaved work.
      showErrorDialog(e instanceof Error ? e.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // PATCH returns where the order ended up: a purchaser's material change sends
  // it back to Draft. Every write path has to take this, or the page keeps
  // showing the stage the order left and the stepper offers no way back.
  const applyLifecycle = (lifecycle: string | undefined) => {
    const next = lifecycle ? LIFECYCLE_STATUS[lifecycle] : undefined;
    if (!next || next === savedStatus) return;
    setStatus(next);
    setSavedStatus(next);
  };

  // A purchaser's first write to a submitted order costs it the stage, so ask
  // once per visit before any of the paths that write — Save, and the drawer's
  // own Confirm. Answering resolves whichever call is waiting.
  const askRevert = (material = true): Promise<boolean> => {
    if (!revertOnSave || revertAcked || !material) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      setRevertConfirm(() => (ok: boolean) => {
        setRevertConfirm(null);
        if (ok) setRevertAcked(true);
        resolve(ok);
      });
    });
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
    if (!(await askRevert(materialDirty))) return;
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
    // Confirm writes straight through, so the stage warning belongs here too —
    // but after the checks that can still abort, or a save that never happens
    // spends the once-per-visit acknowledgement.
    if (!(await askRevert())) throw new Error(t('revertWarnCancelled'));
    const r = await api.patch<{ ok: true; addedLineIds: string[]; lifecycle: string }>(
      `/api/orders/${order.id}`,
      l._id
        ? { lines: [editLineToPatch(l)] }
        : { addLines: [editLineToInsert(l, status)] },
    );
    // A purchaser's confirm can send the order back to Draft. Without this the
    // page keeps showing the old stage, the stepper still offers only that
    // stage, and there is no way to re-submit short of a reload.
    applyLifecycle(r.lifecycle);
    const newId = l._id ?? r.addedLineIds[0];
    setLines(ls => ls.map((x, j) => (j === i ? { ...x, _id: newId, _dirty: false } : x)));
    if (!l._id && newId) {
      setPersistedIds(ids => [...ids, newId]);
      if (await flushPendingPhotos(l._cid, newId)) showErrorDialog(t('linePhotoUploadFailed'));
    }
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
              {rows.map(({ line: l, index: i, head, hidden }) => {
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
                if (hidden) {
                  return head ? <Fragment key={'g-' + head}>{groupHead(head)}</Fragment> : null;
                }
                // Rows open the drawer at every stage — a locked order gets a
                // read-only drawer, not an unreachable one.
                return (
                  <Fragment key={l._id ?? l._cid}>
                  {head && groupHead(head)}
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
            fees={parsedOtherFees}
            shippingFees={shipFees}
            total={effectiveTotalCost}
            revenue={totals.revenue}
            pricedCost={totals.pricedCost}
            pricedProfit={totals.pricedProfit}
            pricedCount={totals.pricedCount}
            locale={locale}
            goodsNote={goodsOverridden ? (
              <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
            ) : undefined}
            feeField={canEditOrder ? (
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span className="mono oe-ledger-currency" aria-hidden="true">$</span>
                <input
                  id="oe-other-fees"
                  // Its visible label is a receipt row inside CostTape, not a
                  // <label>, so the field is unnamed without this.
                  aria-label={t('otherFees')}
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

        {/* Bank payments linked to this PO on the Payments page. Manager-only
            (the API 403s everyone else) and invisible until something links. */}
        {user?.role === 'manager' && <PoPaymentsLedger orderId={order.id} locale={locale} />}

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
              // On a closed order the whole stepper freezes except the
              // manager's reopen target (Done → Reviewing).
              const stepDisabled = locked || (orderLocked && !(canReopen && s === 'Reviewing'));
              return (
                <Fragment key={s}>
                  <button
                    type="button"
                    className={'so-step' + (active ? ' active' : '') + (reached ? ' reached' : '') + (locked ? ' locked' : '')}
                    onClick={() => {
                      if (stepDisabled) return;
                      // Done gets the evidence dialog first; confirming stages
                      // the status, Save commits it. Re-open it even when already
                      // at Done so the user can add more notes / attachments.
                      // Purchasers never reach here for Done (allowedStatuses
                      // keeps it locked).
                      if (s === 'Done') { setDoneDialogOpen(true); return; }
                      setStatus(s);
                    }}
                    disabled={stepDisabled}
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
          {revertOnSave && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="rotate" size={13} />
              {t('revertHint')}
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
            {!isPurchaser && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="eo-owner">{t('poOnBehalfLabel')}</label>
                <select
                  id="eo-owner"
                  className="select"
                  value={ownerId}
                  onChange={e => setOwnerId(e.target.value)}
                  // A Done PO is a closed book — ownership (commission,
                  // "my orders") is part of the record and stays put.
                  disabled={orderLocked}
                  title={orderLocked ? t('eoOwnerLockedDone') : undefined}
                  style={{ width: '100%' }}
                >
                  {ownerOptions.map(o => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('poPaypalTxn')}</label>
              <input
                className="input mono"
                value={paypalTxn}
                onChange={e => setPaypalTxn(normalizePaypalTxnInput(e.target.value))}
                placeholder={canEditOrder ? t('shipPayTxnPh') : '—'}
                disabled={!canEditOrder}
                autoComplete="off"
                spellCheck={false}
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
          gridTemplateColumns: 'auto repeat(3, 1fr) auto',
          gap: 18, alignItems: 'center',
        }}>
          {/* Shipping lives on its own page — this is the way in. */}
          <button
            className="btn"
            onClick={() => navigate(`/shipping/${order.id}`)}
          >
            <Icon name="truck" size={14} /> {t('shipLabelsBtn')}
          </button>
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
              {t('totalCost')} {goodsOverridden && (
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            {/* Only ever shown for photos whose upload failed: a queued photo
                on a line that has no id yet is waiting for Save, not for this. */}
            {retryablePhotos > 0 && (
              <button
                className="btn"
                disabled={saving || photos.busy}
                onClick={() => void retryQueuedPhotos()}
              >
                <Icon name="refresh" size={14} /> {t('linePhotoRetryAction', { n: retryablePhotos })}
              </button>
            )}
            <button
              className="btn primary"
              disabled={saving}
              title={saveBlockers[0]}
              onClick={attemptSave}
            >
              <Icon name="check2" size={14} /> {saving ? '…' : t('save')}
            </button>
          </div>
        </div>
      </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          // See DesktopSubmit: the drawer's per-line state (notably the
          // category-switch undo, which snapshots the whole line) must not
          // survive a move to another row.
          key={lines[activeIdx]._id ?? lines[activeIdx]._cid}
          line={lines[activeIdx]}
          idx={activeIdx}
          editing
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          onConfirmLine={() => confirmLine(activeIdx)}
          onConfirmError={showErrorDialog}
          duplicateOnLines={dupByIdx.get(activeIdx)}
          readOnly={!canEditOrder}
          missingFields={missingNamesFor(lines[activeIdx])}
          market={marketFor(lines[activeIdx].partNumber)}
          photoCtx={{
            orderId: order.id,
            // A line added in this session isn't persisted until Confirm line
            // or Save, so it has no id to hang a photo off yet — files picked
            // for it are buffered as local previews and uploaded when it lands.
            lineId: lines[activeIdx]._id ?? null,
            pending: photos.queuedFor(lines[activeIdx]._cid),
            onAddFiles: files => addLinePhotos(activeIdx, files),
            onRemovePending: p => photos.remove(lines[activeIdx]._cid, p),
            onRemoveSaved: photo => void removeLinePhoto(activeIdx, photo),
            busy: photos.busy,
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
                onClick={async () => {
                  setDupConfirm(null);
                  if (!(await askRevert(materialDirty))) return;
                  await doSave();
                }}
              >
                {saving ? '…' : t('dupPartSaveAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {revertConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) revertConfirm(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="rotate" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('revertWarnTitle')}</div>
                  <div className="modal-sub">{t('revertWarnBody')}</div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => revertConfirm(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => revertConfirm(true)}>
                {t('revertWarnConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRevert.length > 0 && (
        <RevertNoticeDialog
          orderId={order.id}
          changes={pendingRevert}
          onAcknowledged={() => { setPendingRevert([]); setActivityKey(k => k + 1); }}
          onDismiss={() => setPendingRevert([])}
        />
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
    // A scan performed in the drawer must survive Save; null keeps the stored
    // value (the backend applies these with COALESCE, like every field here).
    scanImageId:    l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
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
    scanImageId:    l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  };
}

// Read-only ledger of bank transactions linked to this PO on the Payments
// page. Renders nothing until a payment is linked, so most POs pay no cost.
function PoPaymentsLedger({ orderId, locale }: { orderId: string; locale: string }) {
  const { t } = useT();
  const [ledger, setLedger] = useState<{
    payments: {
      id: string; source: string; postedAt: string; amount: number;
      counterparty: string | null; linkKind: 'payment' | 'refund' | null; linkAuto: boolean;
    }[];
    net: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<NonNullable<typeof ledger>>(`/api/bank-transactions/by-order/${encodeURIComponent(orderId)}`)
      .then(r => { if (alive) setLedger(r); })
      // Silent: the ledger is a side panel, not the page — a fetch hiccup
      // must not throw a dialog over an otherwise working order edit.
      .catch(() => {});
    return () => { alive = false; };
  }, [orderId]);

  if (!ledger || ledger.payments.length === 0) return null;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t('payLedgerTitle')}</div>
        <button
          type="button"
          className="btn sm ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => navigate('/payments')}
        >
          {t('payLedgerOpen')}
        </button>
      </div>
      <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 12.5 }}>
        {ledger.payments.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span className={'chip dot ' + (p.linkKind === 'refund' ? 'cool' : 'pos')} style={{ fontSize: 10.5 }}>
              {t(p.linkKind === 'refund' ? 'payKindRefund' : 'payKindPayment')}
            </span>
            <span className="muted">{fmtDateShort(p.postedAt, locale)}</span>
            <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.counterparty ?? (p.source === 'paired' ? 'PayPal + Mercury' : p.source)}
            </span>
            <span className="mono" style={{ marginLeft: 'auto', color: p.amount > 0 ? 'var(--pos)' : undefined }}>
              {(p.amount < 0 ? '−' : '+') + fmtUSD(Math.abs(p.amount), locale)}
            </span>
          </div>
        ))}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          paddingTop: 6, borderTop: '1px dashed var(--border)', fontWeight: 600,
        }}>
          <span>{t('payLedgerNet')}</span>
          <span className="mono">{(ledger.net < 0 ? '−' : '+') + fmtUSD(Math.abs(ledger.net), locale)}</span>
        </div>
      </div>
    </div>
  );
}
