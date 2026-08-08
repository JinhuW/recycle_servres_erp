import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { AttachmentChip } from '../../components/AttachmentChip';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { useT } from '../../lib/i18n';
import { api, createOrder, deleteOrder } from '../../lib/api';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { poEffectiveCost, parseFeeInput } from '../../lib/poTotals';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { Category, ScanResponse, Warehouse, OrderSummary } from '../../lib/types';
import { LineDrawer } from './submit/LineDrawer';
import { AddLineMenu } from './submit/AddLineMenu';
import { eligibleDraftTargets } from './submit/eligibleTargets';
import { usePreference } from '../../lib/preferences';
import { useMarketLookup } from '../../lib/useMarketLookup';
import { groupLines, shouldGroup } from '../../lib/lineGroups';
import { CostTape } from '../../components/CostTape';
import { useAuth } from '../../lib/auth';
import { synthesizePartNumber, serialIssue } from '@recycle-erp/shared';
import { missingRamFields } from '../../lib/ramRequired';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { type PendingPhoto } from '../../components/LinePhotoStrip';
import {
  uploadLinePhoto, deleteLinePhoto, limitPhotoPick, planPhotoCarry, photoSourceFile,
  LINE_PHOTO_CAP, type LinePhoto, type LineCarryPlan,
} from '../../lib/linePhotos';

// ─── Public component ────────────────────────────────────────────────────────
// OrderForm — line-item table + right-side drawer for editing one line, plus a
// sticky bottom card with order meta + totals + submit action. There is no
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

// ─── OrderForm ───────────────────────────────────────────────────────────────
// Exported so DesktopEditOrder can reuse the same line-drawer pattern (table
// row → right-side drawer with full per-category fields) without duplicating
// the components.
export type Line = {
  category: Category;
  brand?: string;
  capacity?: string;
  generation?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
  interface?: string;
  formFactor?: string;
  description?: string;
  itemType?: string;
  partNumber?: string;
  serialNumber?: string;
  chipNumber?: string;
  condition: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string;
  health?: number | null;
  rpm?: number | null;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
  _confirmed?: boolean;
  _cid: string;                  // stable client id for React keys (never sent to the API)
  // DB id, once the line has been persisted. Null before that — which is why
  // photos are buffered rather than uploaded as they're picked.
  _dbId?: string | null;
  photos?: LinePhoto[];
};

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
  notes: string;
  // Charged on top of the goods total, so it is its own field rather than
  // something folded into the override.
  otherFees: string;
  otherFeesNote: string;
};


export function blankLine(cat: Category): Line {
  return {
    _cid: crypto.randomUUID(),
    category: cat, qty: '', unitCost: '',
    condition: '',
    scanImageUrl: null,
  };
}

export type DuplicatePartGroup = { partNumber: string; lineNums: number[] };

// Two lines sharing a part number on the same PO is almost always a paste-error
// or a forgotten-already-added — surface it so the user can merge or confirm.
// Comparison is case-insensitive and trims whitespace; blanks are ignored. The
// returned `partNumber` carries the first-seen casing for display.
export function findDuplicatePartNumbers(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
): DuplicatePartGroup[] {
  const groups = new Map<string, DuplicatePartGroup>();
  lines.forEach((l, i) => {
    const raw = (l.partNumber ?? '').trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    const g = groups.get(key);
    if (g) g.lineNums.push(i + 1);
    else groups.set(key, { partNumber: raw, lineNums: [i + 1] });
  });
  return [...groups.values()].filter(g => g.lineNums.length >= 2);
}

// Build a Line patch from an AI scan response — mirrors the mobile aiDefaults
// in SubmitForm.tsx so all flows share the same field-mapping. Returned as a
// Partial so callers can either spread it onto blankLine() (new line) or pass
// it through onChange() (live edit in the drawer).
// Low-confidence extractions are still prefilled (a rough draft beats an empty
// form); scanConfidence rides along so the drawer can flag it for review.
export function scanToLinePatch(scan: ScanResponse): Partial<Line> {
  const f = scan.extracted ?? {};
  return {
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
    scanImageUrl: scan.deliveryUrl ?? null,
    ...(f.brand        ? { brand: f.brand }               : {}),
    ...(f.capacity     ? { capacity: f.capacity }         : {}),
    ...(f.generation   ? { generation: f.generation }     : {}),
    ...(f.type         ? { type: f.type }                 : {}),
    ...(f.classification ? { classification: f.classification } : {}),
    ...(f.rank         ? { rank: f.rank }                 : {}),
    ...(f.speed        ? { speed: f.speed }               : {}),
    ...(f.interface    ? { interface: f.interface }       : {}),
    ...(f.formFactor   ? { formFactor: f.formFactor }     : {}),
    ...(f.description  ? { description: f.description }   : {}),
    ...(f.partNumber   ? { partNumber: f.partNumber }     : {}),
  };
}

function OrderForm({
  onDone,
}: {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
}) {
  const { t, lang } = useT();
  const { user } = useAuth();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => setWarehouses(r.items))
      .catch(handleFetchError);
  }, []);

  // Which category the next line defaults to. Persisted so a purchaser who
  // works through a pallet of drives doesn't re-pick on every session; the
  // add control offers all four regardless, so this only sets the first line.
  const [lastCat, setLastCat] = usePreference('submit.lastCategory', 'RAM');
  const [lines, setLines] = useState<Line[]>([blankLine(lastCat as Category)]);
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [meta, setMeta] = useState<OrderMeta>({
    warehouseId: '',
    payment: 'Company',
    notes: '',
    otherFees: '',
    otherFeesNote: '',
  });

  // Photos picked before their line exists. Keyed by _cid because that is the
  // only stable handle a line has before it is persisted; flushed by
  // flushPhotos once the DB id lands. Mirrors the evidenceFiles deferral below.
  const [pendingPhotos, setPendingPhotos] = useState<Record<string, PendingPhoto[]>>({});
  const [photoBusy, setPhotoBusy] = useState(false);

  // The live object URLs, held in a ref rather than read off state at cleanup
  // time: an unmount effect with an empty dep list closes over the FIRST
  // render's `pendingPhotos` — `{}` — and revokes nothing at all.
  const pendingUrlsRef = useRef<Set<string>>(new Set());
  const revokePending = (url: string) => {
    URL.revokeObjectURL(url);
    pendingUrlsRef.current.delete(url);
  };
  useEffect(() => () => {
    for (const url of pendingUrlsRef.current) URL.revokeObjectURL(url);
    pendingUrlsRef.current.clear();
  }, []);

  // The File behind every photo this session uploaded, keyed by photo id. The
  // merge path deletes the draft those photos hang off, and R2 goes with it —
  // re-uploading bytes we still hold is what lets them survive the move.
  const uploadedFilesRef = useRef<Map<string, File>>(new Map());

  const addPendingPhotos = (l: Line, files: FileList | null) => {
    const held = (l.photos?.length ?? 0) + (pendingPhotos[l._cid]?.length ?? 0);
    const { accepted, overCap } = limitPhotoPick(files, held);
    if (overCap > 0) showErrorDialog(t('linePhotoCapReached', { max: LINE_PHOTO_CAP }));
    if (!accepted.length) return;
    // Created out here, not inside the updater: React may run a state updater
    // twice, and each extra run would mint an object URL nothing revokes.
    const added = accepted.map(f => {
      const url = URL.createObjectURL(f);
      pendingUrlsRef.current.add(url);
      return { file: f, url };
    });
    setPendingPhotos(prev => ({ ...prev, [l._cid]: [...(prev[l._cid] ?? []), ...added] }));
  };
  const removePendingPhoto = (cid: string, p: PendingPhoto) => {
    revokePending(p.url);
    setPendingPhotos(prev => ({ ...prev, [cid]: (prev[cid] ?? []).filter(x => x !== p) }));
  };

  // Upload whatever was buffered for this line, now that it has an id.
  // Non-fatal: the line itself is already saved, so a failed photo is a
  // warning, not a lost line.
  const flushPhotos = async (cid: string, poId: string, lineId: string): Promise<void> => {
    const queued = pendingPhotos[cid];
    if (!queued?.length) return;
    setPhotoBusy(true);
    let results: { p: PendingPhoto; photo: LinePhoto | null }[];
    try {
      // Concurrent: the server assigns `position` under a FOR UPDATE lock on
      // the parent line, so racing uploads for one line are already serialised
      // where it matters.
      results = await Promise.all(queued.map(async p => {
        try { return { p, photo: (await uploadLinePhoto(poId, lineId, p.file)).photo }; }
        catch { return { p, photo: null }; }
      }));
    } finally {
      setPhotoBusy(false);
    }

    const saved: LinePhoto[] = [];
    const failed: PendingPhoto[] = [];
    for (const r of results) {
      if (!r.photo) { failed.push(r.p); continue; }
      saved.push(r.photo);
      uploadedFilesRef.current.set(r.photo.id, r.p.file);
      revokePending(r.p.url);
    }
    // A photo whose upload failed stays queued — dropping it here discarded the
    // only copy that existed, with its preview still on screen and no retry.
    setPendingPhotos(prev => {
      const next = { ...prev };
      if (failed.length) next[cid] = failed; else delete next[cid];
      return next;
    });
    if (saved.length) {
      setLines(ls => ls.map(l => (l._cid === cid ? { ...l, photos: [...(l.photos ?? []), ...saved] } : l)));
    }
    if (failed.length) showErrorDialog(t('linePhotoUploadFailed'));
  };

  // Order-level error banner — populated by submit/confirm failures. AI scan
  // failures live inside the LineDrawer, alongside the dropzone that produces
  // them.
  const [submitting, setSubmitting] = useState(false);

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
      if (f.size > 50 * 1024 * 1024) { showErrorDialog(t('fileTooLarge', { name: f.name })); return false; }
      return true;
    });
    if (picked.length) setEvidenceFiles(prev => [...prev, ...picked]);
  };

  // Upload buffered evidence to the FINAL order id (the new draft, or the merge
  // target). Returns true if every file uploaded. Non-fatal: a false result
  // surfaces a warning but the order is already submitted.
  const uploadEvidence = async (finalId: string): Promise<boolean> => {
    let ok = true;
    for (const f of evidenceFiles) {
      try {
        const form = new FormData();
        form.append('file', f);
        await api.upload(`/api/orders/${finalId}/status-meta/Submission/attachments`, form);
      } catch { ok = false; }
    }
    return ok;
  };

  // The PO is created lazily — only when its first line is persisted (see
  // persistLines) — so abandoning the form never writes an empty draft. Null
  // until then, then holds the real PO id.
  const [orderId, setOrderId] = useState<string | null>(null);

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

  // Default the warehouse to the first one once they load.
  useEffect(() => {
    if (warehouses.length && !meta.warehouseId) {
      setMeta(m => ({ ...m, warehouseId: warehouses[0].id }));
    }
  }, [warehouses, meta.warehouseId]);

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

  // No goods-total override on capture: the goods total is the sum of the
  // lines, and anything paid on top of the goods is the fee — so line costs
  // plus fee is what the purchaser actually paid, with no second field to
  // reconcile against the first.

  // One batched lookup for every part number on the form, so the drawer can
  // show what the part is worth while the buy price is still being decided.
  const marketFor = useMarketLookup(lines.map(l => l.partNumber));

  const groups = useMemo(() => groupLines(lines), [lines]);
  const grouped = useMemo(() => shouldGroup(lines), [lines]);

  // Revenue and profit over the lines that actually carry a sell price. An
  // unpriced line contributes nothing rather than being scored as a loss.
  const priced = useMemo(() => {
    let revenue = 0, cost = 0, count = 0;
    for (const l of lines) {
      const sp = Number(l.sellPrice);
      if (!(sp > 0)) continue;
      const q = Number(l.qty) || 0;
      revenue += q * sp;
      cost += q * (Number(l.unitCost) || 0);
      count += 1;
    }
    return { revenue, cost, profit: revenue - cost, count };
  }, [lines]);

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  const dupByIdx = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of dupGroups) {
      for (const ln of g.lineNums) {
        m.set(ln - 1, g.lineNums.filter(n => n !== ln));
      }
    }
    return m;
  }, [dupGroups]);
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
        if (!lineReady(cur)) {
          showErrorDialog(t('subFillThisLine'));
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

  const lineReady = (l: Line) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other'
      ? !!l.description && !!(l.itemType ?? '').trim()
      : !!l.brand;
    const specsComplete = l.category !== 'RAM' || missingRamFields(l).length === 0;
    return qty > 0 && cost >= 0 && hasIdentity && specsComplete;
  };

  // Localized "Brand, Speed (MHz), …" list for missing-field messages.
  const missingFieldNames = (l: Line): string | null => {
    if (l.category !== 'RAM') return null;
    const missing = missingRamFields(l);
    return missing.length ? missing.map(k => t(k)).join(lang === 'zh' ? '、' : ', ') : null;
  };

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
    const r = await createOrder({ lines: wireLines, ...m });
    setOrderId(r.id);
    return { orderId: r.id, lineIds: r.lineIds ?? [] };
  };

  const wireMeta = (): WireMeta => ({
    ...(meta.warehouseId ? { warehouseId: meta.warehouseId } : {}),
    payment: meta.payment === 'Company' ? 'company' : 'self',
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
    if (!lineReady(l)) {
      const fields = missingFieldNames(l);
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
    if (dbId) void flushPhotos(l._cid, saved.orderId, dbId);
  };

  // Escape closes the drawer.
  useEscapeKey(useCallback(() => setActiveIdx(null), []), activeIdx !== null);

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
      // Same deferral as a per-line confirm, for lines submitted without one.
      await Promise.all(unconfirmedLines.map((l, i) =>
        saved.lineIds[i] ? flushPhotos(l._cid, finalId, saved.lineIds[i]) : Promise.resolve()));
      // An already-confirmed line can still be holding photos — one whose
      // upload failed, or one picked after the confirm. Submit is the last
      // moment they can be attached.
      await Promise.all(submitLines
        .filter(l => l._dbId && pendingPhotos[l._cid]?.length)
        .map(l => flushPhotos(l._cid, finalId, l._dbId!)));
      if (evidenceFiles.length > 0) {
        const ok = await uploadEvidence(finalId);
        onDone(ok
          ? { msg: t('orderSubmitted'), kind: 'success' }
          : { msg: t('poSubmitUploadWarning'), kind: 'error' });
        return;
      }
      onDone({ msg: t('orderSubmitted'), kind: 'success' });
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('subSubmitFailed'));
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
          pending: pendingPhotos[l._cid] ?? [],
          photos: l.photos,
          scanImageId: l.scanImageId,
          scanImageUrl: l.scanImageUrl,
        })),
        uploadedFilesRef.current,
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
  : lines.flatMap((l, i) => {
      if (lineReady(l)) return [];
      const fields = missingFieldNames(l);
      if (fields) {
        return [lines.length === 1
          ? t('subMissingFieldsThis', { fields })
          : t('subMissingFieldsLine', { n: i + 1, fields })];
      }
      return [lines.length === 1 ? t('subFillThisLine') : t('subFillLineN', { n: i + 1 })];
    });

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
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()}
                          {l.category === 'HDD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()}
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
            coveragePct={totals.cost > 0 ? (priced.cost / totals.cost) * 100 : 100}
            locale={locale}
            feeField={
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span className="mono oe-ledger-currency" aria-hidden="true">$</span>
                <input
                  id="sub-other-fees"
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

      {/* Sticky bottom: meta + totals + submit */}
      <div className="card" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: '0 12px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('warehouse')} <span className="req">*</span></label>
              <select
                className="select"
                value={meta.warehouseId}
                onChange={e => setMeta(m => ({ ...m, warehouseId: e.target.value }))}
              >
                {warehouses.length === 0 && <option value="">{t('loadingApp')}</option>}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('payment')} <span className="req">*</span></label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  className={meta.payment === 'Company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Company' }))}
                >{t('payCompanyShort')}</button>
                <button
                  className={meta.payment === 'Self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Self' }))}
                >{t('paySelfShort')}</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('orderNotes')}</label>
              <input
                className="input"
                value={meta.notes}
                onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
                placeholder={t('subOptional')}
              />
            </div>
          </div>
        </div>

        <div style={{ padding: '0 16px 16px' }}>
          {/* Vendors send lot manifests / price lists as spreadsheets, so this
              dropzone takes sheets on top of the usual receipt formats. Other
              attachment surfaces keep the narrower picker. */}
          <AttachmentDropzone
            label={t('poSubmitAttachLabel')}
            boxHint={t('uploadHintSheets')}
            accept={SUBMIT_ATTACH_ACCEPT}
            onFiles={addEvidenceFiles}
          />
          {evidencePreviews.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
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

        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 18, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('lines')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('subTotalUnits')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.units}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              {t('totalCost')}
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
            {/* Leaves the form. Confirmed lines are already persisted to the
                draft, so nothing entered is lost — this is not a discard. */}
            <button className="btn" onClick={() => onDone()}>{t('cancel')}</button>
            <button
              className="btn accent"
              disabled={submitting}
              title={submitBlockers[0]}
              onClick={onSubmitClick}
            >
              {t('submitOrder')} <Icon name="check" size={14} />
            </button>
          </div>
        </div>
      </div>

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
          market={marketFor(lines[activeIdx].partNumber)}
          photoCtx={{
            orderId,
            lineId: lines[activeIdx]._dbId ?? null,
            pending: pendingPhotos[lines[activeIdx]._cid] ?? [],
            onAddFiles: files => addPendingPhotos(lines[activeIdx], files),
            onRemovePending: p => removePendingPhoto(lines[activeIdx]._cid, p),
            onRemoveSaved: async photo => {
              const l = lines[activeIdx];
              if (!orderId || !l._dbId) return;
              try {
                await deleteLinePhoto(orderId, l._dbId, photo.id);
                uploadedFilesRef.current.delete(photo.id);
                setLines(ls => ls.map(x =>
                  x._cid === l._cid ? { ...x, photos: (x.photos ?? []).filter(p => p.id !== photo.id) } : x));
              } catch { showErrorDialog(t('linePhotoDeleteFailed')); }
            },
            busy: photoBusy,
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
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setDupConfirm(null); }}>
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
              <button className="btn" onClick={() => setDupConfirm(null)} disabled={submitting}>
                {t('dupPartReview')}
              </button>
              <button
                className="btn accent"
                disabled={submitting}
                onClick={async () => {
                  setDupConfirm(null);
                  const target = pendingTargetId ? targets.find(o => o.id === pendingTargetId) : null;
                  setPendingTargetId(null);
                  if (target) await doSubmitToExisting(target);
                  else await doSubmit();
                }}
              >
                {submitting ? '…' : t('dupPartSubmitAnyway')}
              </button>
            </div>
          </div>
        </div>
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

// LineDrawer + the per-category field groups (RamFields/SsdFields/HddFields/
// OtherFields/CatSelect) were extracted verbatim into ./submit/* — re-exported
// here so external importers (DesktopEditOrder) keep their existing import path.
export { LineDrawer };
