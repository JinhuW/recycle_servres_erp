import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { AttachmentChip } from '../../components/AttachmentChip';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { PaymentFields } from '../../components/PaymentFields';
import type { HandoffMethod } from '../../lib/handoff';
import { useT } from '../../lib/i18n';
import { api, createOrder, deleteOrder, MAX_UPLOAD_BYTES } from '../../lib/api';
import { handleFetchError, showErrorDialog, showWarnToast } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { poEffectiveCost, parseFeeInput } from '../../lib/poTotals';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { Category, Warehouse, OrderSummary } from '../../lib/types';
import { LineDrawer } from './submit/LineDrawer';
import { AddLineMenu } from './submit/AddLineMenu';
import { eligibleDraftTargets } from './submit/eligibleTargets';
import { DupPartDialog } from './submit/DupPartDialog';
import {
  blankLine, brandConfirmPending, duplicatesByIndex, findDuplicatePartNumbers,
  lineBlockerMessages, type DuplicatePartGroup, type Line,
} from './submit/line';
import { usePreference } from '../../lib/preferences';
import { useMarketLookup } from '../../lib/useMarketLookup';
import { groupLines, shouldGroup, pricedTotals, lineSpecLabel } from '../../lib/lineGroups';
import { CostTape } from '../../components/CostTape';
import { useAuth } from '../../lib/auth';
import { synthesizePartNumber, serialIssue } from '@recycle-erp/shared';
import { lineRequirements, missingFieldNames } from '../../lib/lineRequirements';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { loadWarehouses } from '../../lib/warehouses';
import {
  deleteLinePhoto, planPhotoCarry, photoSourceFile, uploadLinePhoto,
  uploadedPhotoCount, useLinePhotoBuffer,
  type LineCarryPlan, type PendingPhoto,
} from '../../lib/linePhotos';

// ─── Public component ────────────────────────────────────────────────────────
// OrderForm — line-item table + right-side drawer for editing one line, plus a
// bottom card with order meta + totals + submit action. There is no
// category step ahead of it: a PO may hold several categories, so the choice
// belongs to each line (AddLineMenu) rather than to the order.
//
// RAM lines get an AI label drop zone at the top of the right-side drawer
// (LineDrawer): drop or click a photo, the scan patches the current line.

type Props = {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
};

export function DesktopSubmit({ onDone }: Props) {
  const { t } = useT();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('submitNewOrder')}</h1>
          <div className="page-sub">{t('submitNewOrderSub')}</div>
        </div>
      </div>

      <OrderForm onDone={onDone} />
    </>
  );
}

// Extensions and MIME types both: Safari populates neither consistently on
// drag-and-drop, and Windows file dialogs filter on the extension.
const SUBMIT_ATTACH_ACCEPT = [
  '.pdf', '.png', '.jpg', '.jpeg', '.xlsx', '.csv',
  'image/*', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
].join(',');

type OrderMeta = {
  warehouseId: string;
  payment: 'Company' | 'Self';
  paymentMethod: HandoffMethod | null;
  notes: string;
  // Charged on top of the goods total, so it is its own field rather than
  // something folded into the override.
  otherFees: string;
  otherFeesNote: string;
};

// ─── OrderForm ───────────────────────────────────────────────────────────────
function OrderForm({
  onDone,
}: {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
}) {
  const { t, lang, locale } = useT();
  const { user } = useAuth();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    loadWarehouses()
      .then(setWarehouses)
      .catch(handleFetchError);
  }, []);

  // A manager may file the PO for a purchaser, who then owns it (commission,
  // "my orders", notifications). '' means the manager keeps it themselves.
  const isManager = user?.role === 'manager';
  const [onBehalfOfUserId, setOnBehalfOfUserId] = useState('');
  const [members, setMembers] = useState<
    { id: string; name: string; defaultWarehouseId?: string | null }[]
  >([]);
  useEffect(() => {
    if (!isManager) return;
    // Any member can own the PO, managers included; the signed-in manager is
    // already the "Myself" option, so they are left off the list.
    api.get<{ items: { id: string; name: string; defaultWarehouseId?: string | null }[] }>('/api/members')
      .then(r => setMembers(r.items.filter(m => m.id !== user?.id)))
      .catch(handleFetchError);
  }, [isManager, user?.id]);

  // Which category the next line defaults to. Persisted so a purchaser who
  // works through a pallet of drives doesn't re-pick on every session; the
  // add control offers all four regardless, so this only sets the first line.
  const [lastCat, setLastCat] = usePreference('submit.lastCategory', 'RAM');
  const [lines, setLines] = useState<Line[]>([blankLine(lastCat as Category)]);
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [meta, setMeta] = useState<OrderMeta>({
    warehouseId: '',
    payment: 'Company',
    paymentMethod: null,
    notes: '',
    otherFees: '',
    otherFeesNote: '',
  });

  // Photos picked before their line exists, keyed by _cid — the only stable
  // handle a line has before it is persisted. Uploaded by `flushPhotos` once
  // the DB id lands. Mirrors the evidenceFiles deferral below.
  const photos = useLinePhotoBuffer((cid, saved) =>
    setLines(ls => ls.map(l => (l._cid === cid ? { ...l, photos: [...(l.photos ?? []), ...saved] } : l))));

  // Upload whatever was buffered for this line, now that it has an id. Returns
  // how many are still queued because their upload failed — those keep their
  // File and their preview, so the retry the user is promised is a real one.
  const flushPhotos = async (
    cid: string, poId: string, lineId: string, items?: PendingPhoto[],
  ): Promise<number> => (await photos.flush(cid, poId, lineId, items)).failed.length;

  // A line that has already been confirmed has somewhere to put a photo right
  // away; one that hasn't waits for the submit that gives it an id.
  const addLinePhotos = (l: Line, files: FileList | null) => {
    const added = photos.add(l._cid, uploadedPhotoCount(l.photos), files);
    if (!added.length || !orderId || !l._dbId) return;
    void flushPhotos(l._cid, orderId, l._dbId, added)
      .then(failed => { if (failed) showErrorDialog(t('linePhotoUploadFailed')); });
  };

  // Photos sitting on a line that already has somewhere to put them: an upload
  // that failed, nothing else. What the Retry action in the commit bar offers.
  const retryablePhotos = lines.reduce(
    (n, l) => n + (l._dbId ? photos.queuedFor(l._cid).length : 0), 0);

  // Order-level error banner — populated by submit/confirm failures. AI scan
  // failures live inside the LineDrawer, alongside the dropzone that produces
  // them.
  const [submitting, setSubmitting] = useState(false);

  // Set when a submit wrote the order but could not upload everything the page
  // was holding. Keeps the user here with a retry rather than navigating away
  // from bytes that exist nowhere else.
  const [unfinished, setUnfinished] = useState<{ orderId: string; evidence: boolean } | null>(null);

  // Submission evidence is buffered locally, not uploaded live: the merge path
  // deletes the throwaway draft, so the only stable target id is known after
  // submit succeeds. Upload runs against that final id (see uploadEvidence).
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);

  // One object URL per File, created lazily and revoked only on unmount — so
  // removing one file never revokes a URL still in use by another's preview.
  const evidenceUrlsRef = useRef<Map<File, string>>(new Map());
  const evidencePreviews = evidenceFiles.map(f => {
    let url = evidenceUrlsRef.current.get(f);
    if (!url) { url = URL.createObjectURL(f); evidenceUrlsRef.current.set(f, url); }
    return { file: f, url };
  });
  useEffect(() => () => {
    for (const url of evidenceUrlsRef.current.values()) URL.revokeObjectURL(url);
    evidenceUrlsRef.current.clear();
  }, []);

  const addEvidenceFiles = (fl: FileList | null) => {
    const picked = Array.from(fl || []).filter(f => {
      // 50 MiB server hard cap; oversized images are shrunk server-side.
      if (f.size > MAX_UPLOAD_BYTES) { showErrorDialog(t('fileTooLarge', { name: f.name })); return false; }
      return true;
    });
    if (picked.length) setEvidenceFiles(prev => [...prev, ...picked]);
  };

  // Upload buffered evidence to the FINAL order id (the new draft, or the merge
  // target). Returns true if every file uploaded. Non-fatal: a false result
  // surfaces a warning but the order is already submitted.
  const uploadEvidence = async (finalId: string): Promise<boolean> => {
    const failed: File[] = [];
    for (const f of evidenceFiles) {
      try {
        const form = new FormData();
        form.append('file', f);
        await api.upload(`/api/orders/${finalId}/status-meta/Submission/attachments`, form);
      } catch { failed.push(f); }
    }
    // Only the failures are kept, so a retry re-sends exactly those instead of
    // attaching the ones that landed a second time.
    if (failed.length !== evidenceFiles.length) setEvidenceFiles(failed);
    return failed.length === 0;
  };

  // The PO is created lazily — only when its first line is persisted (see
  // persistLines) — so abandoning the form never writes an empty draft. Null
  // until then, then holds the real PO id.
  const [orderId, setOrderId] = useState<string | null>(null);

  // The commit bar sits in normal flow (not sticky), so on a long order it
  // starts off screen. The fab appears exactly while it is — a shortcut to
  // the Submit button rather than a second copy of it.
  const commitRef = useRef<HTMLDivElement>(null);
  const [commitVisible, setCommitVisible] = useState(true);
  useEffect(() => {
    const el = commitRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setCommitVisible(e.isIntersecting));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Existing same-category Draft POs the user can append to instead of creating
  // a fresh PO. Fetched once on mount, before any order exists; excludeId keeps
  // this session's own order out of the list once it's been created.
  // Any Draft PO of the user's own is a valid append target now that a PO may
  // mix categories — there is nothing left for a category filter to protect.
  const [allDrafts, setAllDrafts] = useState<OrderSummary[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ orders: OrderSummary[] }>('/api/orders?status=Draft')
      .then(r => { if (alive) setAllDrafts(r.orders); })
      .catch(() => { /* non-fatal: just means no "add to existing" option */ });
    return () => { alive = false; };
  }, []);

  const targets = useMemo(
    () => eligibleDraftTargets(allDrafts, { meId: user?.id, excludeId: orderId }),
    [allDrafts, user?.id, orderId],
  );

  // The warehouse follows the order's owner until it's picked by hand: the
  // on-behalf purchaser's home warehouse when filing for someone, else the
  // current user's, else the first in the list.
  const [warehouseTouched, setWarehouseTouched] = useState(false);
  const ownerDefaultWh = onBehalfOfUserId
    ? members.find(m => m.id === onBehalfOfUserId)?.defaultWarehouseId
    : user?.defaultWarehouseId;
  useEffect(() => {
    if (!warehouses.length || warehouseTouched) return;
    const preferred =
      ownerDefaultWh && warehouses.some(w => w.id === ownerDefaultWh)
        ? ownerDefaultWh
        : warehouses[0].id;
    setMeta(m => (m.warehouseId === preferred ? m : { ...m, warehouseId: preferred }));
  }, [warehouses, warehouseTouched, ownerDefaultWh]);

  const totals = useMemo(() => {
    let units = 0, cost = 0;
    lines.forEach(l => {
      const qty = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      units += qty;
      cost += qty * c;
    });
    return { units, cost };
  }, [lines]);

  // Goods (line sum, or the negotiated override) plus fees charged on top.
  const cost = poEffectiveCost({
    lineSubtotal: totals.cost,
    // Always the line sum now — anything paid beyond the goods is the fee.
    totalCostOverride: null,
    otherFees: parseFeeInput(meta.otherFees),
  });

  // One batched lookup for every part number on the form, so the drawer can
  // show what the part is worth while the buy price is still being decided.
  const marketFor = useMarketLookup(lines.map(l => l.partNumber));

  const groups = useMemo(() => groupLines(lines), [lines]);
  const grouped = useMemo(() => shouldGroup(lines), [lines]);

  const priced = useMemo(() => pricedTotals(lines), [lines]);

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  const dupByIdx = useMemo(() => duplicatesByIndex(dupGroups), [dupGroups]);
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // When the dup-part warning is reached via "add to existing", remember which
  // target to merge into so confirming the warning doesn't fall back to new-PO.
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ selectedId: string | null } | null>(null);
  // Lines submitted with a blank part number that can be auto-filled (e.g.
  // Mixed-brand SSDs). Holds the proposed value per line for the confirm modal.
  const [pnConfirm, setPnConfirm] = useState<{ idx: number; value: string }[] | null>(null);
  // Serial-rule violations (DDR5 requires serials; serial count must equal
  // qty) caught at save time — shown as a blocking dialog, nothing persists.
  const [serialIssues, setSerialIssues] = useState<SerialLineIssue[] | null>(null);

  const updateLine = (i: number, patch: Partial<Line>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Adding the next line first auto-saves the line the user was filling out,
  // so they don't lose work by forgetting to press Confirm. If the active line
  // isn't ready yet, surface the reason and don't append — otherwise the user
  // ends up with a silent half-saved row.
  const addLine = async (cat: Category) => {
    if (activeIdx != null) {
      const cur = lines[activeIdx];
      if (cur && !cur._confirmed) {
        if (brandConfirmPending(cur)) {
          showWarnToast(t('subConfirmBrandThis'));
          return;
        }
        if (!lineReady(cur)) {
          const fields = missingNamesFor(cur);
          showWarnToast(fields ? t('drawerStillNeeded', { fields }) : t('subFillThisLine'));
          return;
        }
        try {
          await handleConfirmLine(activeIdx);
        } catch (e) {
          showErrorDialog(e instanceof Error ? e.message : t('subSubmitFailed'));
          return;
        }
      }
    }
    setLastCat(cat);
    setLines(ls => [...ls, blankLine(cat)]);
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

  const lineReady = (l: Line) => lineRequirements(l).ready;
  const missingFieldKeys = (l: Line): string[] => lineRequirements(l).missingKeys;

  // Localized "Brand, Speed (MHz), …" list for missing-field messages.
  const missingNamesFor = (l: Line): string | null =>
    missingFieldNames(missingFieldKeys(l), t, lang);

  const lineLabel = (l: Line): string => l.partNumber || l.brand || l.description || '';

  // Serial rules for a set of lines; null when everything passes.
  const collectSerialIssues = (ls: Line[]): SerialLineIssue[] | null => {
    const found = ls
      .map((l, idx) => ({ lineNo: idx + 1, label: lineLabel(l), issue: serialIssue(l) }))
      .filter((x): x is SerialLineIssue => x.issue !== null);
    return found.length ? found : null;
  };

  // Maps a local Line to the wire shape expected by PATCH /api/orders/:id addLines.
  const toWireLine = (l: Line) => ({
    category: l.category,
    sellPrice: l.sellPrice == null || l.sellPrice === '' ? null : Number(l.sellPrice),
    brand: l.brand ?? null,
    capacity: l.capacity ?? null,
    type: l.type ?? null,
    generation: l.generation ?? null,
    classification: l.classification ?? null,
    rank: l.rank ?? null,
    speed: l.speed ?? null,
    interface: l.interface ?? null,
    formFactor: l.formFactor ?? null,
    description: l.description ?? null,
    itemType: l.itemType ?? null,
    partNumber: l.partNumber ?? null,
    serialNumber: l.serialNumber ?? null,
    chipNumber: l.chipNumber ?? null,
    condition: l.condition,
    qty: Number(l.qty) || 1,
    unitCost: Number(l.unitCost) || 0,
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    status: 'In Transit' as const,
    scanImageId: l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  });

  // No goods total: the backend derives it from the lines on every write that
  // moves them. Sending one here was actively wrong on the per-line confirm —
  // `totals.cost` is the sum of ALL local lines, while the PATCH appends only
  // the one just confirmed, so confirming line 3 of 5 wrote the full local sum
  // as a stated goods total the remaining appends could no longer correct.
  type WireMeta = {
    warehouseId?: string;
    payment: 'company' | 'self';
    paymentMethod: HandoffMethod | null;
    notes: string | null;
    otherFees: number;
    otherFeesNote: string | null;
  };

  // Lazily create-or-append. The first persist creates the PO already carrying
  // its content (POST /api/orders); later persists append via PATCH. An empty
  // PO is therefore never written — if the first POST fails, orderId stays null
  // and a retry creates it fresh. Returns the resolved id so callers can chain
  // (e.g. evidence upload).
  const persistLines = async (
    wireLines: ReturnType<typeof toWireLine>[],
    m: WireMeta,
  ): Promise<{ orderId: string; lineIds: string[] }> => {
    if (orderId) {
      const r = await api.patch<{ ok: true; addedLineIds?: string[] }>(
        '/api/orders/' + orderId, { addLines: wireLines, ...m });
      return { orderId, lineIds: r.addedLineIds ?? [] };
    }
    // Ownership travels only on the create — PATCH can't reassign an owner,
    // so appends deliberately leave it out.
    const r = await createOrder({
      lines: wireLines, ...m,
      ...(onBehalfOfUserId ? { onBehalfOfUserId } : {}),
    });
    setOrderId(r.id);
    return { orderId: r.id, lineIds: r.lineIds ?? [] };
  };

  const wireMeta = (): WireMeta => ({
    ...(meta.warehouseId ? { warehouseId: meta.warehouseId } : {}),
    payment: meta.payment === 'Company' ? 'company' : 'self',
    paymentMethod: meta.payment === 'Company' ? meta.paymentMethod : null,
    notes: meta.notes || null,
    otherFees: parseFeeInput(meta.otherFees),
    otherFeesNote: meta.otherFeesNote.trim() || null,
  });

  // Confirms a single line AND auto-saves the current order metadata in the
  // same write. The user doesn't need to click "Submit Order" to keep their
  // work safe — closing the tab after confirming a line leaves nothing
  // unsaved. The first confirm is what creates the PO. (Submit Order remains
  // as the navigate-away trigger.)
  const handleConfirmLine = async (idx: number): Promise<void> => {
    const l = lines[idx];
    if (l._confirmed) return;
    // Backstop: the drawer opens the confirm dialog before it gets here, and
    // addLine bails earlier still. Nothing should reach this — but this is the
    // single funnel every confirm goes through, so it is where the rule can't
    // be routed around.
    if (brandConfirmPending(l)) {
      showErrorDialog(t('subConfirmBrandThis'));
      throw new Error(t('brandConfirmTitle'));
    }
    if (!lineReady(l)) {
      const fields = missingNamesFor(l);
      showErrorDialog(fields ? t('subMissingFieldsThis', { fields }) : t('subFillThisLine'));
      return;
    }
    const issue = serialIssue(l);
    if (issue) {
      setSerialIssues([{ lineNo: idx + 1, label: lineLabel(l), issue }]);
      // Thrown (not returned) so the drawer's confirm handler keeps the
      // drawer open for the fix instead of closing on apparent success.
      throw new Error(t('serialCheckTitle'));
    }
    const saved = await persistLines([toWireLine(l)], wireMeta());
    const dbId = saved.lineIds[0] ?? null;
    updateLine(idx, { _confirmed: true, _dbId: dbId });
    // The line only just acquired an id, so this is the first moment its
    // buffered photos can be attached to anything.
    if (dbId) {
      void flushPhotos(l._cid, saved.orderId, dbId)
        .then(failed => { if (failed) showErrorDialog(t('linePhotoUploadFailed')); });
    }
  };

  // Escape closes the drawer — unless a dialog is stacked on top of it, which
  // gets the key first. Both listen on the window, so without this one press
  // would dismiss the dialog and the drawer under it.
  useEscapeKey(useCallback(() => {
    if (document.querySelector('.modal-backdrop')) return;
    setActiveIdx(null);
  }, []), activeIdx !== null);

  // `submitLines` defaults to state, but the part-number confirm flow passes a
  // freshly-patched array: setLines() is async, so submitting from state right
  // after it would serialize the PRE-patch lines and drop accepted part numbers.
  const doSubmit = async (submitLines: Line[] = lines) => {
    const unconfirmedLines = submitLines.filter(l => !l._confirmed);
    setSubmitting(true);
    try {
      // Creates the PO if no line was ever confirmed (single-line straight
      // submit); otherwise appends any still-unconfirmed lines + refreshes meta.
      const saved = await persistLines(unconfirmedLines.map(toWireLine), wireMeta());
      const finalId = saved.orderId;
      // Recorded before anything can hold the user here: a retry needs a line
      // to attach the photos to, and a second submit must patch these lines
      // rather than append them a second time.
      const idByCid = new Map<string, string>();
      unconfirmedLines.forEach((l, i) => {
        if (saved.lineIds[i]) idByCid.set(l._cid, saved.lineIds[i]);
      });
      setLines(ls => ls.map(l => (idByCid.has(l._cid)
        ? { ...l, _confirmed: true, _dbId: idByCid.get(l._cid)! }
        : l)));
      // Same deferral as a per-line confirm, for lines submitted without one,
      // plus any already-confirmed line still holding photos — one whose
      // upload failed, or one picked after the confirm.
      const flushed = await Promise.all([
        ...unconfirmedLines.map(l => {
          const lineId = idByCid.get(l._cid);
          return lineId ? flushPhotos(l._cid, finalId, lineId) : Promise.resolve(0);
        }),
        ...submitLines
          .filter(l => l._dbId && photos.queuedFor(l._cid).length)
          .map(l => flushPhotos(l._cid, finalId, l._dbId!)),
      ]);
      const stillQueued = flushed.reduce((a, b) => a + b, 0);
      const evidenceOk = evidenceFiles.length === 0 || await uploadEvidence(finalId);
      // Those Files are the only copy of those pictures, and this form is the
      // only place holding them — navigating away is what made the promised
      // retry a lie. The order itself is already saved either way.
      if (stillQueued > 0) {
        setUnfinished({ orderId: finalId, evidence: !evidenceOk });
        if (!evidenceOk) showErrorDialog(t('poSubmitUploadWarning'));
        showErrorDialog(t('linePhotoRetryHold', { n: stillQueued }));
        return;
      }
      onDone(evidenceOk
        ? { msg: t('orderSubmitted'), kind: 'success' }
        : { msg: t('poSubmitUploadWarning'), kind: 'error' });
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Retries what the submit could not upload, and leaves the page once nothing
  // is left behind. Only the bytes are re-sent: the order was written already.
  const retryQueuedPhotos = async () => {
    const targetId = unfinished?.orderId ?? orderId;
    if (!targetId) return;
    setSubmitting(true);
    try {
      const flushed = await Promise.all(lines
        .filter(l => l._dbId && photos.queuedFor(l._cid).length)
        .map(l => flushPhotos(l._cid, targetId, l._dbId!)));
      const stillQueued = flushed.reduce((a, b) => a + b, 0);
      const evidenceOk = !unfinished?.evidence || await uploadEvidence(targetId);
      if (stillQueued > 0) {
        setUnfinished({ orderId: targetId, evidence: !evidenceOk });
        showErrorDialog(t('linePhotoRetryHold', { n: stillQueued }));
        return;
      }
      if (unfinished) {
        onDone(evidenceOk
          ? { msg: t('orderSubmitted'), kind: 'success' }
          : { msg: t('poSubmitUploadWarning'), kind: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Puts this session's photos on the merge target, and must finish before the
  // throwaway draft is deleted — that delete sweeps every R2 object the draft's
  // rows point at. Returns how many photos could not be carried across.
  const carryPhotosToTarget = async (
    targetId: string,
    plans: LineCarryPlan[],
    addedLineIds: string[],
  ): Promise<number> => {
    let lost = 0;
    const jobs: Promise<void>[] = [];
    plans.forEach((plan, i) => {
      lost += plan.overCap;
      if (!plan.carry.length) return;
      // addedLineIds mirrors the addLines ordering; a missing entry means the
      // target never got that line, so there is nothing to attach to.
      const lineId = addedLineIds[i];
      if (!lineId) { lost += plan.carry.length; return; }
      for (const src of plan.carry) {
        jobs.push((async () => {
          const file = await photoSourceFile(src);
          if (!file) { lost += 1; return; }
          try { await uploadLinePhoto(targetId, lineId, file); }
          catch { lost += 1; }
        })());
      }
    });
    await Promise.all(jobs);
    return lost;
  };

  // Append all local lines to an existing Draft PO. Target meta (warehouse/
  // payment/notes) is inherited — we send only lines + a refreshed total.
  const doSubmitToExisting = async (target: OrderSummary, submitLines: Line[] = lines) => {
    setSubmitting(true);
    try {
      // Worked out before anything is written: the throwaway draft is deleted
      // at the end of this, and that sweep takes its line photos and its label
      // scans out of R2 with it. So the pictures have to be re-uploaded onto
      // the target, and a scan key the draft still owns must not be handed over
      // — the surviving PO would point at an object that no longer exists.
      const draftWillBeDeleted = orderId != null;
      const plans = planPhotoCarry(
        submitLines.map(l => ({
          cid: l._cid,
          persisted: !!l._dbId,
          pending: photos.queuedFor(l._cid),
          photos: l.photos,
          scanImageId: l.scanImageId,
          scanImageUrl: l.scanImageUrl,
        })),
        photos.uploadedFiles,
        draftWillBeDeleted,
      );
      const res = await api.patch<{ ok: true; addedLineIds?: string[] }>('/api/orders/' + target.id, {
        addLines: submitLines.map((l, i) => ({ ...toWireLine(l), scanImageId: plans[i].scanImageId })),
        // The goods total is not accumulated by hand any more — the backend
        // re-derives it from the target's lines once these land. Fees are not
        // a line and have nothing to derive from, so they still accumulate
        // here: the target keeps what it was charged, plus what this batch adds.
        otherFees: target.otherFees + parseFeeInput(meta.otherFees),
      });
      const photosLost = await carryPhotosToTarget(target.id, plans, res.addedLineIds ?? []);
      const evidenceOk = evidenceFiles.length === 0 || await uploadEvidence(target.id);
      // Best-effort cleanup of the throwaway draft IF one was created — lazy
      // creation means there may be none (user merged before confirming a
      // line). The merge already succeeded, so a failure here must not fail it.
      if (orderId) { try { await deleteOrder(orderId); } catch { /* harmless */ } }
      onDone(
        photosLost > 0
          ? { msg: t('subMergePhotosLost', { id: target.id, n: photosLost }), kind: 'error' }
          : !evidenceOk
            ? { msg: t('poSubmitUploadWarning'), kind: 'error' }
            : { msg: t('subLinesAddedToPo', { id: target.id }), kind: 'success' });
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Part # is required on every line. Clicking Submit first checks for blanks:
  // a line we can auto-fill (synthesizePartNumber returns a value, e.g. a
  // Mixed-brand SSD) is offered in a confirm modal; a blank we can't fill is a
  // hard stop. Only once all lines have (or accept) a part # do we proceed into
  // the existing target/duplicate flow.
  const proceedSubmit = (submitLines: Line[] = lines) => {
    if (targets.length > 0) { setChoice({ selectedId: null }); return; }
    // Recompute duplicates from the lines we're about to submit — dupGroups is
    // memoized on state, which lags a just-applied part-number patch.
    const dups = submitLines === lines ? dupGroups : findDuplicatePartNumbers(submitLines);
    if (dups.length > 0) { setDupConfirm(dups); return; }
    void doSubmit(submitLines);
  };

  const attemptSubmit = () => {
    const issues = collectSerialIssues(lines);
    if (issues) { setSerialIssues(issues); return; }
    const blanks = lines
      .map((l, idx) => ({ idx, l, gen: (l.partNumber ?? '').trim() ? null : synthesizePartNumber(l.category, l) }))
      .filter(x => !(x.l.partNumber ?? '').trim());
    const blocking = blanks.find(x => !x.gen);
    if (blocking) { showErrorDialog(t('pnRequiredLine', { n: blocking.idx + 1 })); return; }
    if (blanks.length > 0) {
      setPnConfirm(blanks.map(x => ({ idx: x.idx, value: x.gen! })));
      return;
    }
    proceedSubmit();
  };

  // What Submit is still waiting on, one entry per problem. The button stays
  // live while these exist: clicking it opens a dialog with the whole list,
  // which beats a dead button and a hint that's easy to miss. Priority order:
  // warehouse load → warehouse pick → per-line completeness.
  const submitBlockers: string[] =
    submitting              ? []
  : warehouses.length === 0 ? [t('subWarehousesNotLoaded')]
  : !meta.warehouseId       ? [t('reviewPickWarehouseHint')]
  : lineBlockerMessages(lines, t, lineReady, missingNamesFor);

  const onSubmitClick = () => {
    if (submitBlockers.length) {
      showErrorDialog(t('errCantSubmitMsg'), submitBlockers, t('errCantSubmitTitle'));
      return;
    }
    attemptSubmit();
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">{t('subOrderContainsMixed')}</div>
          </div>
          <span className="chip mono">
            {(orderId ?? t('subDrafting'))} · {t('lifecycleDraft')}
          </span>
        </div>

        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 18px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {t('subItemsInOrder')} <span style={{ fontWeight: 500, color: 'var(--fg-subtle)', marginLeft: 4 }}>({lines.length})</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('subItemsClickRowAny')}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.units, cost: fmtUSD(totals.cost, locale) })}</span>
            <AddLineMenu onAdd={addLine} />
          </div>
        </div>

        <div className="sub-lines-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>{t('item')}</th>
              <th>{t('partNumber')}</th>
              <th className="num">{t('qty')}</th>
              <th className="num">{t('unitCost')}</th>
              <th className="num">{t('totalCost')}</th>
              <th>{t('status')}</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lQty = Number(l.qty) || 0;
              const lCost = Number(l.unitCost) || 0;
              const filled = !!l.brand || !!l.description;
              const isActive = i === activeIdx;
              return (
                <tr
                  key={l._cid}
                  className="row-hover"
                  style={{ cursor: 'pointer', background: isActive ? 'var(--accent-soft)' : undefined }}
                  onClick={() => setActiveIdx(i)}
                >
                  <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                  <td>
                    {filled ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {lineSpecLabel(l)}
                          {l.category === 'Other' && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              {!!(l.itemType ?? '').trim() && <span className="chip">{l.itemType}</span>}
                              {l.description ?? '—'}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                          {l.category === 'RAM' && [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')}
                          {l.category === 'SSD' && [l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'HDD' && [l.interface, l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'Other' && l.condition}
                        </div>
                      </div>
                    ) : <span className="muted" style={{ fontStyle: 'italic' }}>{isActive ? t('subEditingFill') : t('subNotFilled')}</span>}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                  <td className="num mono">{lQty}</td>
                  <td className="num mono">{lCost ? fmtUSD(lCost, locale) : '—'}</td>
                  <td className="num mono">{lQty && lCost ? fmtUSD(lQty * lCost, locale) : '—'}</td>
                  <td>
                    {isActive && <span className="chip info"><Icon name="edit" size={10} /> {t('subStatusEditing')}</span>}
                    {!isActive && filled && <span className="chip pos">{t('subStatusReady')}</span>}
                    {!isActive && !filled && <span className="chip warn">{t('subStatusNeedsInfo')}</span>}
                  </td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {/* Same cost ledger as the edit page: goods + fees = cost, with the
            fee — a cost that never was a line — as the one editable cell.
            No revenue/profit terms here; a PO being captured has no sell
            prices yet. */}
        <div className="oe-submit-foot">
          <CostTape
            groups={groups}
            grouped={grouped}
            lineCount={lines.length}
            units={totals.units}
            goods={cost.goods}
            fees={cost.fees}
            total={cost.total}
            revenue={priced.revenue}
            pricedCost={priced.cost}
            pricedProfit={priced.profit}
            pricedCount={priced.count}
            locale={locale}
            feeField={
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span className="mono oe-ledger-currency" aria-hidden="true">$</span>
                <input
                  id="sub-other-fees"
                  // Its visible label is a receipt row inside CostTape, not a
                  // <label>, so the field is unnamed without this.
                  aria-label={t('otherFees')}
                  className="input mono tape-money"
                  type="number"
                  min={0}
                  step="0.01"
                  value={meta.otherFees}
                  placeholder="0.00"
                  onChange={e => setMeta(m => ({ ...m, otherFees: e.target.value }))}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 22 }}
                />
              </span>
            }
            feeNoteField={
              <input
                className="input tape-note"
                type="text"
                maxLength={280}
                value={meta.otherFeesNote}
                placeholder={t('otherFeesPh')}
                onChange={e => setMeta(m => ({ ...m, otherFeesNote: e.target.value }))}
                aria-label={t('otherFeesNote')}
              />
            }
          />
        </div>
      </div>

      {/* Commit bar: destination + payer + note, attachments, then the
          single figure the submit button commits. */}
      <div className="card sub-commit" ref={commitRef}>
        <div className={isManager ? 'sub-commit-meta sub-commit-meta--behalf' : 'sub-commit-meta'}>
          {isManager && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="sub-behalf">{t('poOnBehalfLabel')}</label>
              <select
                id="sub-behalf"
                className="select"
                value={onBehalfOfUserId}
                onChange={e => setOnBehalfOfUserId(e.target.value)}
                // The first confirmed line creates the PO and fixes its owner,
                // so the picker locks from that moment on.
                disabled={!!orderId}
                title={orderId ? t('poOnBehalfLocked') : undefined}
              >
                <option value="">{t('poOnBehalfSelf')}</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="sub-warehouse">{t('warehouse')} <span className="req">*</span></label>
            <select
              id="sub-warehouse"
              className="select"
              value={meta.warehouseId}
              onChange={e => {
                setWarehouseTouched(true);
                setMeta(m => ({ ...m, warehouseId: e.target.value }));
              }}
            >
              {warehouses.length === 0 && <option value="">{t('loadingApp')}</option>}
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <PaymentFields
              paidBy={meta.payment === 'Company' ? 'company' : 'self'}
              onPaidBy={v => setMeta(m => ({ ...m, payment: v === 'company' ? 'Company' : 'Self' }))}
              method={meta.paymentMethod}
              onMethod={v => setMeta(m => ({ ...m, paymentMethod: v }))}
              txnId="" onTxnId={() => {}}
              compact
              idPrefix="sub"
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="sub-notes">{t('orderNotes')}</label>
            <input
              id="sub-notes"
              className="input"
              value={meta.notes}
              onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
              placeholder={t('subOptional')}
            />
          </div>
        </div>

        <div className="sub-commit-attach">
          {/* Vendors send lot manifests / price lists as spreadsheets, so this
              dropzone takes sheets on top of the usual receipt formats. Other
              attachment surfaces keep the narrower picker. */}
          <AttachmentDropzone
            compact
            label={t('poSubmitAttachLabel')}
            boxHint={t('uploadHintSheets')}
            accept={SUBMIT_ATTACH_ACCEPT}
            onFiles={addEvidenceFiles}
          />
          {evidencePreviews.length > 0 && (
            <div className="sub-commit-files">
              {evidencePreviews.map(p => (
                <AttachmentChip
                  key={p.url}
                  a={{ id: p.url, filename: p.file.name, size: p.file.size, mime: p.file.type, url: p.url }}
                  onRemove={() => setEvidenceFiles(prev => prev.filter(x => x !== p.file))}
                />
              ))}
            </div>
          )}
        </div>

        <div className="sub-commit-foot">
          <div className="sub-commit-total">
            <div className="sub-commit-cap">{t('totalCost')}</div>
            <div className="sub-commit-amt">{fmtUSD(cost.total, locale)}</div>
            {cost.fees > 0 && (
              <div className="sub-commit-fees">{t('inclFees', { fees: fmtUSD(cost.fees, locale) })}</div>
            )}
          </div>
          <div className="sub-commit-actions">
            {/* Leaves the form. Confirmed lines are already persisted to the
                draft, so nothing entered is lost — this is not a discard. */}
            <button className="btn" onClick={() => onDone()}>{t('cancel')}</button>
            {/* Only ever shown for photos whose upload failed: a queued photo
                on a line that has no id yet is waiting for the submit, not for
                this. */}
            {retryablePhotos > 0 && (
              <button
                className="btn"
                disabled={submitting || photos.busy}
                onClick={() => void retryQueuedPhotos()}
              >
                <Icon name="refresh" size={14} /> {t('linePhotoRetryAction', { n: retryablePhotos })}
              </button>
            )}
            <button
              className="btn accent lg"
              disabled={submitting}
              title={submitBlockers[0]}
              onClick={onSubmitClick}
            >
              {t('submitOrder')} <Icon name="check" size={14} />
            </button>
          </div>
        </div>
      </div>

      {!commitVisible && (
        <button
          className="jump-bottom-fab"
          title={t('subJumpToBottom')}
          aria-label={t('subJumpToBottom')}
          onClick={() => commitRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
        >
          <Icon name="chevronDown" size={16} />
        </button>
      )}

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          // Keyed on the line, not mounted once and re-pointed: the drawer holds
          // per-line state (the category-switch undo snapshot above all, which
          // carries a whole Line) and without a remount clicking another row
          // would let Undo write the previous line's record over this one.
          key={lines[activeIdx]._cid}
          line={lines[activeIdx]}
          idx={activeIdx}
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          missingFields={missingNamesFor(lines[activeIdx])}
          market={marketFor(lines[activeIdx].partNumber)}
          photoCtx={{
            orderId,
            lineId: lines[activeIdx]._dbId ?? null,
            pending: photos.queuedFor(lines[activeIdx]._cid),
            onAddFiles: files => addLinePhotos(lines[activeIdx], files),
            onRemovePending: p => photos.remove(lines[activeIdx]._cid, p),
            onRemoveSaved: async photo => {
              const l = lines[activeIdx];
              if (!orderId || !l._dbId) return;
              try {
                await deleteLinePhoto(orderId, l._dbId, photo.id);
                photos.uploadedFiles.delete(photo.id);
                setLines(ls => ls.map(x =>
                  x._cid === l._cid ? { ...x, photos: (x.photos ?? []).filter(p => p.id !== photo.id) } : x));
              } catch { showErrorDialog(t('linePhotoDeleteFailed')); }
            },
            busy: photos.busy,
          }}
          onConfirmLine={() => handleConfirmLine(activeIdx)}
          onConfirmError={showErrorDialog}
          duplicateOnLines={dupByIdx.get(activeIdx)}
        />
      )}

      {choice && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setChoice(null); }}>
          <div className="modal-shell" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">{t('subSubmitChoiceTitle')}</div>
                <div className="modal-sub">{t('subSubmitChoiceSub')}</div>
              </div>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <button
                className="card"
                disabled={submitting}
                style={{
                  padding: 14, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-elev)',
                }}
                onClick={() => {
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(null); setDupConfirm(dupGroups); return; }
                  void doSubmit();
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceNewPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('subChoiceNewPoSub')}</div>
              </button>

              <div className="card" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceExistingPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2, marginBottom: 10 }}>
                  {t('subChoiceExistingPoSubAny')}
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {targets.map(o => {
                    const sel = choice.selectedId === o.id;
                    return (
                      <button
                        key={o.id}
                        disabled={submitting}
                        onClick={() => setChoice({ selectedId: o.id })}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                          borderRadius: 8, background: sel ? 'var(--accent-soft)' : 'transparent',
                          border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--border)'),
                        }}
                      >
                        <span className="mono" style={{ fontWeight: sel ? 600 : 500, color: sel ? 'var(--accent-strong)' : undefined }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                          {(o.warehouse?.short ?? '—') + ' · ' + t('subTargetMeta', { n: o.lineCount, cost: fmtUSD(o.totalCost ?? 0, locale) }) + ' · ' + fmtDateShort(o.createdAt, locale)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setChoice(null)} disabled={submitting}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={submitting || !choice.selectedId}
                onClick={() => {
                  const target = targets.find(o => o.id === choice.selectedId);
                  if (!target) return;
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(target.id); setDupConfirm(dupGroups); return; }
                  void doSubmitToExisting(target);
                }}
              >
                {submitting ? '…' : t('subChoicePickTarget')}
              </button>
            </div>
          </div>
        </div>
      )}

      {serialIssues && (
        <SerialCheckDialog issues={serialIssues} onClose={() => setSerialIssues(null)} />
      )}

      {dupConfirm && (
        <DupPartDialog
          groups={dupConfirm}
          busy={submitting}
          confirmTone="accent"
          confirmLabel={t('dupPartSubmitAnyway')}
          onClose={() => setDupConfirm(null)}
          onConfirm={async () => {
            setDupConfirm(null);
            const target = pendingTargetId ? targets.find(o => o.id === pendingTargetId) : null;
            setPendingTargetId(null);
            if (target) await doSubmitToExisting(target);
            else await doSubmit();
          }}
        />
      )}

      {pnConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setPnConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="hash" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('pnConfirmTitle')}</div>
                  <div className="modal-sub">{pnConfirm.length === 1 ? t('pnConfirmSubOne') : t('pnConfirmSubMany')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {pnConfirm.map(p => (
                  <li key={p.idx}>
                    {t('pnConfirmRow', { n: p.idx + 1 })} <span className="mono" style={{ fontWeight: 600 }}>{p.value}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPnConfirm(null)}>{t('pnConfirmEdit')}</button>
              <button
                className="btn accent"
                onClick={() => {
                  // Apply the accepted part numbers to a local array and submit
                  // from it directly. updateLine()/setLines is async, so calling
                  // proceedSubmit() against state here would drop these values.
                  const patched = lines.map((l, i) => {
                    const m = pnConfirm.find(p => p.idx === i);
                    return m ? { ...l, partNumber: m.value } : l;
                  });
                  setLines(patched);
                  setPnConfirm(null);
                  proceedSubmit(patched);
                }}
              >
                {t('pnConfirmUse')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

