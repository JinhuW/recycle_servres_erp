import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { PhTabBar, type View } from './components/PhTabBar';
import { PhDraftPickerSheet } from './components/PhDraftPickerSheet';
import { PhLanguageSheet } from './components/PhLanguageSheet';
import { PhNotificationsSheet } from './components/PhNotificationsSheet';
import { PhAboutSheet } from './components/PhAboutSheet';
import { PhPasswordSheet } from './components/PhPasswordSheet';
import { ErrorDialog, useErrorDialogQueue } from './components/ErrorDialog';

import { Login } from './pages/Login';
import { RolePicker } from './pages/RolePicker';
import { Dashboard } from './pages/Dashboard';
import { Camera } from './pages/Camera';
import { SubmitForm } from './pages/SubmitForm';
import { OrderReview } from './pages/OrderReview';
import { Orders } from './pages/Orders';
import { OrderDetail, type OrderMetaDraft } from './pages/OrderDetail';
import { Market } from './pages/Market';
import { Inventory } from './pages/Inventory';
import { Profile } from './pages/Profile';
import { ShareTarget } from './pages/ShareTarget';

import {
  linePhotos, deleteLinePhoto, uploadedPhotoCount, useLinePhotoBuffer,
  type LinePhoto, type PendingPhoto,
} from './lib/linePhotos';
import { lineRequirements, missingFieldNames } from './lib/lineRequirements';

import { useAuth } from './lib/auth';
import { useEffectiveUser } from './lib/tweaks';
import { useT, I18N } from './lib/i18n';
import { api, ApiError, createDraftOrder, deleteOrder } from './lib/api';
import { handleFetchError, showErrorDialog } from './lib/errorToast';
import {
  navigate, navigateBack, useRoute, match,
  MOBILE_VIEW_TO_PATH, pathToMobileView, readSafeNext,
} from './lib/route';
import type { Category, DraftLine, Notification, Order, OrderLine, OrderSummary, ScanResponse } from './lib/types';
import { buildOrderSubmit, type SubmitMeta } from './lib/orderSubmit';
import { findDuplicateLine } from './lib/dupParts';

// Where a line form goes when it closes. 'detail' is an existing order: the
// form was opened from its detail screen, which owns the order, so the trip
// ends back there rather than on a review screen that would re-ask for the
// order's warehouse/payment/notes.
type ReturnTo = 'idle' | 'review' | 'detail';

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'draftPicker'; drafts: OrderSummary[] }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string; rescanDraft?: DraftLine | null }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; originalLineIds?: string[]; editingLineIdx?: number | null; returnTo: ReturnTo; draftId?: string; rescanDraft?: DraftLine | null }
  // Review holds a heterogeneous list, so it has no single category — each
  // line carries its own. `camera` and `form` keep theirs: they edit ONE line,
  // and both the scan endpoint and the field groups need to know which kind.
  // It only ever holds a NEW order; an existing one never enters this phase.
  // `originalLineIds` is what a RESUMED draft already had on the server, so
  // submit can name the ones deleted since.
  | { phase: 'review';  detected: ScanResponse | null; lines: DraftLine[]; originalLineIds?: string[]; draftId?: string };

type Toast = { msg: string; kind: 'success' | 'error' | 'warn' };

type ReviewMeta = { warehouseId: string; payment: 'company' | 'self'; notes: string };

// An order's line as the capture form wants it. Shared by the draft-resume
// path and the detail screen's line edits so the two can't drift.
const toDraftLine = (l: OrderLine): DraftLine => ({
  id: l.id,
  // It came out of the DB, so it is already there. Without this a resumed
  // draft's lines look brand new to buildOrderSubmit and it appends a second
  // copy of every one of them on submit.
  _confirmed: true,
  category: l.category,
  brand: l.brand,
  capacity: l.capacity,
  type: l.type,
  generation: l.generation,
  classification: l.classification,
  rank: l.rank,
  speed: l.speed,
  interface: l.interface,
  formFactor: l.formFactor,
  description: l.description,
  // Required on an Other line: the save echoes every line back, and the
  // per-line guard reads a missing one as an explicit null.
  itemType: l.itemType,
  partNumber: l.partNumber,
  serialNumber: l.serialNumber,
  chipNumber: l.chipNumber,
  condition: l.condition,
  qty: l.qty,
  unitCost: l.unitCost,
  sellPrice: l.sellPrice ?? null,
  scanImageId: l.scanImageId,
  scanConfidence: l.scanConfidence,
  scanImageUrl: l.scanImageUrl,
  health: l.health,
  rpm: l.rpm,
  label: l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
       : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
       : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
       : ((l.description ?? '').trim() || (l.partNumber ?? '').trim() || 'Item'),
});

function Shell() {
  const { user, loading, logout, pendingRoleChoice } = useAuth();
  // The tab bar follows the effective role so a manager who picked "Continue as
  // Purchaser" sees the purchaser tabs (Market, not Inventory), matching the
  // desktop sidebar and the purchaser-scoped data.
  const effUser = useEffectiveUser();
  const { t, lang } = useT();
  const { path } = useRoute();
  const view: View = pathToMobileView(path);
  // The 'submit' tab triggers the capture flow (onCenterPress) and has no
  // URL of its own, so we ignore it here.
  const setView = (v: View) => {
    if (v === 'submit') return;
    navigate(MOBILE_VIEW_TO_PATH[v]);
  };
  // Lock body overflow on mobile so the phone shell behaves like a native screen.
  useEffect(() => {
    document.body.classList.add('phone-mode');
    document.body.classList.remove('desktop');
    return () => { document.body.classList.remove('phone-mode'); };
  }, []);
  const [capture, setCapture] = useState<CaptureState>({ phase: 'idle' });
  // Order-level fees, held here rather than in OrderReview: that screen
  // unmounts on every trip into a line form, and an order opened for edit
  // arrives carrying the fee it was saved with.
  const [orderFees, setOrderFees] = useState({ amount: '', note: '' });
  // Same reason as the fees above: a resumed draft was saved with a warehouse,
  // a payment type and notes, and the review screen unmounts on every trip
  // into a line form. Left to its own defaults it would offer `warehouses[0]`
  // and blank notes, then write those back over what the draft already had.
  const [reviewMeta, setReviewMeta] = useState<ReviewMeta | null>(null);
  // The draft order is created on demand by `ensureDraftId`, and its id lands
  // in `capture` a round trip later. Hold the in-flight POST here so a second
  // save awaits the same one instead of opening a second order.
  const draftIdPromise = useRef<Promise<string | null> | null>(null);
  // Bumped whenever a capture session ends. An autosave that is mid-flight
  // across the draft-creation round trip reads this after the await to tell
  // whether the session it belongs to is still the live one.
  const captureGen = useRef(0);
  // ── Line photos ──────────────────────────────────────────────────────────
  // Held here rather than in SubmitForm: that screen unmounts the moment a line
  // is saved, and a picked file has to outlive it — a line has nowhere to put a
  // photo until the save gives it an id. Keyed by the line's client id, or its
  // server id for a line that arrived already persisted.
  const [savedPhotos, setSavedPhotos] = useState<Record<string, LinePhoto[]>>({});
  const photoBuffer = useLinePhotoBuffer((key, saved) =>
    setSavedPhotos(prev => ({ ...prev, [key]: [...(prev[key] ?? []), ...saved] })));

  const [toast, setToast] = useState<Toast | null>(null);
  // Errors queue rather than overwrite: a line save and its photo upload can
  // fail in the same tap, and the second problem used to replace the first
  // before it had been read. Shared with the desktop shell.
  const {
    current: errorDialog, push: pushErrorDialog, dismiss: dismissErrorDialog,
  } = useErrorDialogQueue();
  const [langSheet, setLangSheet] = useState(false);
  const [notifSheet, setNotifSheet] = useState(false);
  const [aboutSheet, setAboutSheet] = useState(false);
  const [pwSheet, setPwSheet] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  // The detail screen's unsaved fees / notes / warehouse / payment. Held here
  // because opening a line form unmounts that screen — typing a fee and then
  // adding the line it is for used to blank the fee.
  const [detailMeta, setDetailMeta] = useState<OrderMetaDraft | null>(null);
  const orderDetailMatch = match('/purchase-orders/:id', path);

  // Load notifications when the user is signed in.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.get<{ items: Notification[] }>('/api/notifications')
      .then(r => { if (alive) setNotifs(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [user?.id]);

  // Resume an OAuth authorize that bounced through the login screen. Must be a
  // real navigation, not navigate(), because the target is a backend route.
  // Fires ahead of the RolePicker gate below, which would otherwise strand a
  // manager mid-connect.
  useEffect(() => {
    if (!user) return;
    const next = readSafeNext(window.location.search);
    if (next) window.location.replace(next);
  }, [user]);

  // Drive the order-detail screen from the URL. Suspended while a capture
  // flow is active so the camera/form/review screens take over the shell.
  useEffect(() => {
    if (!orderDetailMatch || capture.phase !== 'idle') {
      if (detailOrder) setDetailOrder(null);
      return;
    }
    if (detailOrder?.id === orderDetailMatch.id) return;
    let alive = true;
    api.get<{ order: Order }>(`/api/orders/${orderDetailMatch.id}`)
      .then(r => { if (alive) setDetailOrder(r.order); })
      .catch((err) => {
        if (!alive) return;
        // Clear the unreachable URL so the failing fetch doesn't re-fire on
        // every re-render, and tell the user why nothing opened. Common case:
        // a manager in role-preview mode follows a link to a PO they don't own.
        navigate('/purchase-orders');
        const status = err instanceof ApiError ? err.status : 0;
        showErrorDialog(
          status === 403 ? t('poNoAccess')
          : status === 404 ? t('poNotFound')
          : t('poOpenFailed'),
        );
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, capture.phase]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // Errors never become toasts: they go to the blocking dialog so the user can
  // read and act on them.
  const showToast = (msg: string, kind: Toast['kind'] = 'success') => {
    if (kind === 'error') { pushErrorDialog({ msg }); return; }
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'warn' ? 4500 : 2600);
  };

  // Register the global hooks so `handleFetchError` / `showErrorDialog` in
  // lib/errorToast.ts can surface errors from anywhere without prop-drilling.
  useEffect(() => {
    window.__showErrorDialog = (msg, details, title) => pushErrorDialog({ msg, details, title });
    window.__showToast = (msg, kind) => {
      if (kind === 'error') { pushErrorDialog({ msg }); return; }
      setToast({ msg, kind: kind === 'warn' ? 'warn' : 'success' });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), kind === 'warn' ? 4500 : 2600);
    };
    return () => { delete window.__showToast; delete window.__showErrorDialog; };
  }, [pushErrorDialog]);

  // ── Line photo handlers ──────────────────────────────────────────────────
  const photoKey = (l: DraftLine) => l._cid ?? l.id ?? '';
  const photosFor = (l: DraftLine): LinePhoto[] => savedPhotos[photoKey(l)] ?? linePhotos(l);
  const pendingFor = (l: DraftLine): PendingPhoto[] => photoBuffer.queuedFor(photoKey(l));
  // The order the line form is writing into. A session that has not needed a
  // draft row yet has none, and neither does a line still being captured.
  const formOrderId = capture.phase === 'form'
    ? (capture.editingId ?? capture.draftId ?? null)
    : null;

  const seedPhotos = (order: Order) => setSavedPhotos(prev => {
    const next = { ...prev };
    for (const l of order.lines) next[l.id] = linePhotos(l);
    return next;
  });

  const addLinePhotos = (l: DraftLine, files: FileList | null) => {
    photoBuffer.add(photoKey(l), uploadedPhotoCount(photosFor(l)), files);
  };

  const removePendingPhoto = (l: DraftLine, p: PendingPhoto) =>
    photoBuffer.remove(photoKey(l), p);

  const removeSavedPhoto = async (l: DraftLine, photo: LinePhoto) => {
    const lineId = l.id;
    if (!lineId || !formOrderId) return;
    const key = photoKey(l);
    const base = photosFor(l);
    try {
      await deleteLinePhoto(formOrderId, lineId, photo.id);
      setSavedPhotos(prev => ({
        ...prev, [key]: (prev[key] ?? base).filter(p => p.id !== photo.id),
      }));
    } catch {
      showErrorDialog(t('linePhotoDeleteFailed'));
    }
  };

  // Sends what was buffered for a line, now that it has an id. Non-fatal: the
  // line itself is already saved, so a photo that fails is a warning — and the
  // buffer keeps it, bytes and preview intact, for the next save to retry.
  const flushLinePhotos = async (l: DraftLine, orderId: string, lineId: string) => {
    const { failed } = await photoBuffer.flush(photoKey(l), orderId, lineId);
    if (failed.length) showErrorDialog(t('linePhotoUploadFailed'));
  };

  // ── Capture flow handlers ────────────────────────────────────────────────
  const startSubmit = async () => {
    // Which PO comes first; the category is a property of a line, and the line
    // list's add row asks for it at the moment it matters. Probing here also
    // keeps every session from silently spawning another empty draft.
    try {
      const r = await api.get<{ orders: OrderSummary[] }>(
        '/api/orders?status=Draft&limit=20&mine=true',
      );
      if (r.orders.length > 0) {
        setCapture({ phase: 'draftPicker', drafts: r.orders });
        return;
      }
    } catch {
      // Better to let them work than to block on a probe failure.
    }
    startNewDraft();
  };
  const cancelCapture = () => {
    // Best-effort delete an abandoned empty draft (nothing confirmed = no real
    // inventory rows were written). Safe: backend 409s if lifecycle != 'draft'.
    if (
      capture.phase === 'camera' ||
      capture.phase === 'form' ||
      capture.phase === 'review'
    ) {
      const { draftId, lines } = capture;
      if (!lines.some(l => l._confirmed)) {
        // The id may not have landed in state yet — a draft POST fired by a
        // save that is still in flight publishes it asynchronously. Resolve the
        // in-flight promise rather than reading state, or cancelling during
        // that window leaves the order (and the line the save is about to
        // append to it) behind as a ghost PO in everyone's draft picker.
        const pending = draftIdPromise.current;
        if (draftId) deleteOrder(draftId).catch(() => {/* best-effort */});
        else if (pending) {
          pending.then(id => { if (id) return deleteOrder(id); }).catch(() => {/* best-effort */});
        }
      }
    }
    captureGen.current++;
    draftIdPromise.current = null;
    setCapture({ phase: 'idle' });
    // The URL is left alone: a capture opened from an order's detail screen
    // (its "Edit items") runs on top of `/purchase-orders/:id`, so dropping the
    // session there uncovers the order the user was editing. Clearing the id
    // dumped them on the full list instead.
  };

  // A new PO opens on its (empty) line list, where the add row asks which kind
  // of thing is going in. Nothing is written until there's a line to write.
  const startNewDraft = () => {
    setCapture({ phase: 'review', detected: null, lines: [] });
    setOrderFees({ amount: '', note: '' });
    captureGen.current++;
    setReviewMeta(null);
    draftIdPromise.current = null;
  };

  // The PO row is created by the first line that needs one, never by opening
  // the flow — a session backed out of at the line list would otherwise leave
  // an empty order behind, and those pile up in everyone's draft picker.
  // Memoised in the ref so two quick saves share one POST; cleared on failure
  // so the next save retries instead of inheriting the rejection.
  const ensureDraftId = (): Promise<string | null> => {
    // No category on the draft: it has no lines to derive one from yet, and the
    // first line will carry its own.
    draftIdPromise.current ??= createDraftOrder()
      .then(r => {
        setCapture(c =>
          c.phase === 'idle' || c.phase === 'draftPicker' ? c : { ...c, draftId: r.id },
        );
        return r.id;
      })
      .catch(() => {
        showToast(t('draftStartFailed'), 'error');
        draftIdPromise.current = null;
        return null;
      });
    return draftIdPromise.current;
  };

  // Reopen an existing draft on the review screen so the user sees the lines
  // they've already accumulated; "Add another item" then routes them back into
  // the scan/form path with the draft id carried through, so new lines merge
  // into the same PO instead of a fresh one.
  const resumeDraft = async (summary: OrderSummary) => {
    try {
      const { order } = await api.get<{ order: Order }>(`/api/orders/${summary.id}`);
      seedPhotos(order);
      setOrderFees({
        amount: order.otherFees ? order.otherFees.toFixed(2) : '',
        note: order.otherFeesNote ?? '',
      });
      setReviewMeta({
        warehouseId: order.warehouse?.id ?? '',
        payment: order.payment,
        notes: order.notes ?? '',
      });
      setCapture({
        phase: 'review',
        detected: null,
        draftId: order.id,
        originalLineIds: order.lines.map(l => l.id),
        lines: order.lines.map(toDraftLine),
      });
    } catch {
      showToast(t('draftOpenFailed'), 'error');
    }
  };

  const onDetected = (s: ScanResponse) => {
    if (capture.phase === 'camera') {
      const pn = (s.extracted?.partNumber as string | undefined) ?? '';
      const dupLine = findDuplicateLine(capture.lines, pn);
      if (dupLine != null && pn) {
        // Surface the alert immediately. The form still opens so the user
        // can compare against the existing line and decide whether to save.
        showToast(t('dupPartScanWarn', { pn, line: dupLine }), 'error');
      }
    }
    setCapture(c => c.phase === 'camera' ? { ...c, phase: 'form', detected: s } : c);
  };

  // Maps a DraftLine to the wire shape for PATCH /api/orders/:id addLines.
  const toWireLine = (l: DraftLine) => ({
    category: l.category,
    sellPrice: l.sellPrice == null ? null : Number(l.sellPrice),
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
    // Required on an Other line — omitting it 400'd every autosave of one.
    itemType: l.itemType ?? null,
    partNumber: l.partNumber ?? null,
    serialNumber: l.serialNumber ?? null,
    chipNumber: l.chipNumber ?? null,
    condition: l.condition ?? 'Pulled — Tested',
    qty: Number(l.qty) || 1,
    unitCost: Number(l.unitCost) || 0,
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    status: 'In Transit' as const,
    scanImageId: l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  });

  // Returns the reason a line can't be auto-saved to the server yet, or null
  // when it's ready (identity — brand, or description for Other — a positive
  // qty, and a non-negative unit cost). Surfaced to the user so a line never
  // fails to sync silently.
  // The backstop before a line is written to the server. The form gates on the
  // same shared rule first, so reaching this with something missing means the
  // line arrived from somewhere else — a resumed draft, or a category switch
  // that emptied the fields the new category needs.
  const lineSyncBlock = (l: DraftLine): string | null => {
    const fields = missingFieldNames(lineRequirements(l).missingKeys, t, lang);
    if (fields) return t('drawerStillNeeded', { fields });
    if (!(Number(l.unitCost) >= 0)) return t('syncNeedCost');
    return null;
  };

  const onSaveLine = async (line: DraftLine) => {
    // Capture current state synchronously so we can read draftId and compute
    // the new lines array before the async PATCH.
    if (capture.phase !== 'form') return;
    const { draftId, editingLineIdx, category, editingId, returnTo, originalLineIds } = capture;
    const gen = captureGen.current;

    // Build the updated lines array.
    const newLines = (editingLineIdx != null)
      ? capture.lines.map((l, i) => i === editingLineIdx ? line : l)
      : [...capture.lines, line];

    // An existing order has no review step and no Submit — the PATCH below is
    // the whole save. Hold the form until it lands so the detail screen can't
    // refetch ahead of the write, and so a failure leaves the user somewhere
    // they can retry from rather than back on a screen with no save button.
    const backToDetail = returnTo === 'detail' && !!editingId;
    const doneToDetail = () => {
      setCapture({ phase: 'idle' });
      navigate('/purchase-orders/' + editingId);
      showToast(t('savedShort'));
    };

    if (!backToDetail) {
      // Move to review immediately (optimistic UI).
      setCapture({ phase: 'review', detected: null, lines: newLines, draftId, originalLineIds });
    }

    // A line that already exists in the DB carries an id — an existing-order
    // line opened for edit, or a draft line we autosaved earlier. Re-saving it
    // must UPDATE that row so the edit syncs now, instead of sitting
    // browser-only until final submit (or being dropped as a "confirmed" line).
    if (line.id) {
      const blocked = lineSyncBlock(line);
      if (blocked) {
        showToast(blocked, 'error');
        return;
      }
      const orderId = editingId ?? draftId ?? await ensureDraftId();
      if (!orderId) {
        showToast(t('syncNoDraft'), 'error');
        return;
      }
      // Cancelled while the draft POST was in flight — cancelCapture is already
      // deleting that order, so writing to it now would resurrect a PO the user
      // discarded.
      if (gen !== captureGen.current) return;
      try {
        // Omit status: the backend COALESCEs it, so leaving it out preserves
        // the line's lifecycle (Done, etc.) instead of forcing In Transit.
        const { status, ...fields } = toWireLine(line);
        void status;
        await api.patch('/api/orders/' + orderId, { lines: [{ id: line.id, ...fields }] });
        await flushLinePhotos(line, orderId, line.id);
        if (backToDetail) doneToDetail();
      } catch (e) {
        // The backend refuses line edits from a purchaser past Draft. The
        // detail screen hides the affordance, but say why if one gets through.
        handleFetchError(e);
      }
      return;
    }

    // Brand-new line (no DB id yet). Autosave it whether this is a fresh draft
    // or an existing order opened for edit — both append via addLines. Without
    // targeting editingId here, a line added to an existing order sat
    // browser-only until final submit (the reported "Add item doesn't sync").

    // Never skip silently: if the line isn't complete enough to persist, tell
    // the user exactly which field is missing.
    const blocked = lineSyncBlock(line);
    if (blocked) {
      showToast(blocked, 'error');
      return;
    }

    // The existing order being edited, or the new draft — whose creation is
    // async, so on a fast Save await the in-flight POST instead of dropping the
    // line to local-only.
    const mintedHere = !editingId && !draftId;
    const targetId = editingId ?? draftId ?? await ensureDraftId();
    if (!targetId) {
      showToast(t('syncNoDraft'), 'error');
      return;
    }
    if (gen !== captureGen.current) return;

    try {
      // Capture the inserted row's id so a later re-edit UPDATEs it in place
      // (and the final submit updates rather than inserting a duplicate).
      const res = await api.patch<{ addedLineIds?: string[] }>(
        '/api/orders/' + targetId, { addLines: [toWireLine(line)] },
      );
      const newId = res.addedLineIds?.[0];
      if (newId) await flushLinePhotos(line, targetId, newId);
      if (backToDetail) { doneToDetail(); return; }
      // Match by stable client id, not array index: the user may have added,
      // removed, or navigated past this line before the PATCH resolved.
      setCapture(c => {
        if (c.phase === 'idle' || c.phase === 'draftPicker') return c;
        const updated = c.lines.map(l =>
          l._cid === line._cid ? { ...l, _confirmed: true, id: newId ?? l.id } : l,
        );
        // Track what the draft holds server-side, not just what the screen
        // shows: a line autosaved and then deleted here has to be named in
        // removeLineIds at submit or it ships as stock nobody bought.
        const known = c.originalLineIds ?? [];
        const originalLineIds = newId && !known.includes(newId) ? [...known, newId] : known;
        return { ...c, lines: updated, originalLineIds };
      });
    } catch (e) {
      // Keep the line locally unconfirmed; it will be sent on final submit.
      // On the detail path there is no final submit, so the reason matters.
      if (backToDetail) { handleFetchError(e); return; }
      showToast(t('syncFailed'), 'error');
      // The order was minted for this line and the line didn't land, so the
      // order is empty and nothing points at it — take it back out. Submit
      // creates it again, atomically, from the whole list.
      if (mintedHere) {
        deleteOrder(targetId).catch(() => {/* best-effort */});
        draftIdPromise.current = null;
        setCapture(c =>
          c.phase === 'idle' || c.phase === 'draftPicker' ? c : { ...c, draftId: undefined },
        );
      }
    }
  };

  // `cat` comes from the four-button row on the review screen, so adding a
  // different kind of item is one tap and the PO is never in a category mode.
  const addAnotherItem = (cat: Category) => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return {
        phase: 'form', category: cat, detected: null,
        lines: c.lines, draftId: c.draftId, originalLineIds: c.originalLineIds,
        editingLineIdx: null, returnTo: 'review',
      };
    });
  };

  const editLine = (idx: number) => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return {
        phase: 'form',
        // From the LINE, not the session — the list is mixed.
        category: c.lines[idx]?.category ?? 'RAM',
        detected: null,
        lines: c.lines,
        editingLineIdx: idx,
        returnTo: 'review',
        draftId: c.draftId,
        originalLineIds: c.originalLineIds,
      };
    });
  };

  // ── Line edits on an order that already exists ───────────────────────────
  // Both open the line form directly. There is no review step: the order has
  // already answered for its warehouse, payment and notes, and its detail
  // screen is what owns them.
  const startEditLine = (order: Order, idx: number) => {
    seedPhotos(order);
    setCapture({
      phase: 'form',
      category: (order.lines[idx]?.category as Category) ?? 'RAM',
      detected: null,
      lines: order.lines.map(toDraftLine),
      editingId: order.id,
      editingLineIdx: idx,
      returnTo: 'detail',
    });
  };

  const startAddLine = (order: Order, cat: Category) => {
    seedPhotos(order);
    setCapture({
      phase: 'form',
      category: cat,
      detected: null,
      lines: order.lines.map(toDraftLine),
      editingId: order.id,
      editingLineIdx: null,
      returnTo: 'detail',
    });
  };

  const goBack = () => {
    if (
      (capture.phase === 'camera' || capture.phase === 'form') &&
      capture.returnTo === 'detail' && capture.editingId
    ) {
      const id = capture.editingId;
      setCapture({ phase: 'idle' });
      navigate('/purchase-orders/' + id);
      return;
    }
    setCapture(c => {
      if (c.phase !== 'camera' && c.phase !== 'form') return c;
      if (c.returnTo === 'review') {
        return { phase: 'review', detected: null, lines: c.lines, draftId: c.draftId, originalLineIds: c.originalLineIds };
      }
      return { phase: 'idle' };
    });
  };

  // Re-open the Camera page from the RAM form. The in-progress draft is
  // carried through so the new scan merges into it (auto-fill semantics)
  // rather than rebuilding the line from scratch.
  const rescanRam = (draft: DraftLine) => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'camera', category: c.category, detected: null, lines: c.lines,
        editingId: c.editingId, originalLineIds: c.originalLineIds, editingLineIdx: c.editingLineIdx ?? null,
        returnTo: c.returnTo, draftId: c.draftId, rescanDraft: draft,
      };
    });
  };

  const removeLine = (idx: number) => {
    setCapture(c => c.phase === 'review' ? { ...c, lines: c.lines.filter((_, i) => i !== idx) } : c);
  };

  const submitOrder = async (meta: SubmitMeta) => {
    if (capture.phase !== 'review') return;

    // A draft that exists is PATCHed; a session whose lines never synced (so
    // no order was ever created) POSTs the whole thing at once — atomic, so an
    // invalid line 400s without leaving an empty PO behind.
    const req = buildOrderSubmit(
      { draftId: capture.draftId, lines: capture.lines, originalLineIds: capture.originalLineIds },
      meta,
    );
    if (req.kind === 'error') {
      showToast(req.message, 'error');
      return;
    }
    try {
      if (req.kind === 'create') await api.post(req.url, req.body);
      else await api.patch(req.url, req.body);
      setCapture({ phase: 'idle' });
      setView('history');
      showToast(t('orderSubmitted'));
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('subSubmitFailed'), 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="phone-app" style={{ display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)' }}>{t('loadingApp')}</div>;
  }

  if (!user) return <Login />;
  // Fresh manager login: gate the app until they pick a role to enter as.
  if (pendingRoleChoice && user.role === 'manager') return <RolePicker variant="mobile" />;
  // Web Share Target landing — the SW redirects POST /share-target here so
  // the page can claim the stashed file and forward it into the AI flow.
  // Placed after the auth gate so the downstream /api/scan/label call has a
  // session; unauth users bounce through Login first.
  if (path === '/share-target' || path.startsWith('/share-target?')) return <ShareTarget />;

  // Full-screen camera/form/review intercept the normal tab UI
  // The capture-flow screens (camera/form/review) are early returns, so the
  // toast/dialog block in the main shell below never mounts while they're on
  // screen — every error raised during scan / line-save / submit was set into
  // state but rendered nowhere, leaving buttons that look like they did
  // nothing. Render these alongside each of those screens too. Fixed
  // positioning anchors them to the viewport regardless of which screen's root
  // is mounted.
  const overlayEl = (
    <>
      {toast && (
        <div className="ph-toast-wrap" style={{ position: 'fixed', left: 16, right: 16, bottom: 96, display: 'flex', justifyContent: 'center', zIndex: 50 }}>
          <div className={'ph-toast ' + (toast.kind || '')}>
            <Icon name={toast.kind === 'warn' ? 'alert' : 'check2'} size={14} /><span>{toast.msg}</span>
          </div>
        </div>
      )}
      {/* Keyed on the entry so the next problem in the queue mounts its own
          dialog — focus and the OK button belong to one message at a time. */}
      {errorDialog && (
        <ErrorDialog
          key={errorDialog.seq}
          content={errorDialog}
          onClose={dismissErrorDialog}
        />
      )}
    </>
  );

  if (capture.phase === 'camera') {
    return (
      <>
        <Camera
          category={capture.category}
          onDetected={onDetected}
          onClose={cancelCapture}
          onBack={goBack}
        />
        {overlayEl}
      </>
    );
  }
  if (capture.phase === 'form') {
    const existing = capture.editingLineIdx != null ? capture.lines[capture.editingLineIdx] : undefined;
    return (
      <>
        <SubmitForm
          category={capture.category}
          detected={capture.detected}
          lineCount={capture.lines.length}
          editingLineIdx={capture.editingLineIdx ?? null}
          existingLine={existing}
          onSaveLine={onSaveLine}
          onCancel={cancelCapture}
          onBack={goBack}
          onRescan={rescanRam}
          rescanDraft={capture.rescanDraft ?? null}
          photoCtx={{
            photosFor,
            pendingFor,
            busy: photoBuffer.busy,
            onAddFiles: addLinePhotos,
            onRemovePending: removePendingPhoto,
            onRemoveSaved: removeSavedPhoto,
          }}
        />
        {overlayEl}
      </>
    );
  }
  if (capture.phase === 'review') {
    return (
      <>
        <OrderReview
          lines={capture.lines}
          initialMeta={reviewMeta}
          onAddItem={addAnotherItem}
          fees={orderFees}
          onFeesChange={setOrderFees}
          onEditLine={editLine}
          onRemoveLine={removeLine}
          onSubmit={submitOrder}
          onCancel={cancelCapture}
        />
        {overlayEl}
      </>
    );
  }

  const unreadCount = notifs.filter(n => n.unread).length;
  const orderDetailOpen = view === 'history' && !!orderDetailMatch && !!detailOrder;

  return (
    <div className="phone-app">
      {view === 'dashboard' && (
        <Dashboard
          goSubmit={startSubmit}
          goHistory={() => setView('history')}
          onOpenNotifications={() => setNotifSheet(true)}
          unreadCount={unreadCount}
        />
      )}
      {orderDetailOpen && (
        <OrderDetail
          order={detailOrder}
          meta={detailMeta}
          onMetaChange={setDetailMeta}
          onCancel={() => navigateBack('/purchase-orders')}
          onSaved={(msg) => showToast(msg)}
          onDeleted={() => navigate('/purchase-orders')}
          onEditLine={startEditLine}
          onAddLine={startAddLine}
        />
      )}
      {view === 'history' && (!orderDetailMatch || !detailOrder) && (
        <Orders onEdit={(o) => navigate('/purchase-orders/' + o.id)} onToast={showToast} />
      )}
      {view === 'market' && <Market />}
      {view === 'inventory' && <Inventory onNewEntry={startSubmit} />}
      {view === 'me' && (
        <Profile
          onOpenLanguage={() => setLangSheet(true)}
          onOpenNotifications={() => setNotifSheet(true)}
          onOpenAbout={() => setAboutSheet(true)}
          onOpenSecurity={() => setPwSheet(true)}
        />
      )}

      {capture.phase === 'draftPicker' && (
        <PhDraftPickerSheet
          drafts={capture.drafts}
          onResume={resumeDraft}
          onStartNew={startNewDraft}
          onClose={cancelCapture}
        />
      )}

      {notifSheet && (
        <PhNotificationsSheet
          items={notifs}
          onClose={() => setNotifSheet(false)}
          onMarkAllRead={async () => {
            setNotifs(ns => ns.map(n => ({ ...n, unread: false })));
            try { await api.post('/api/notifications/mark-read', {}); } catch {}
          }}
        />
      )}

      {aboutSheet && <PhAboutSheet onClose={() => setAboutSheet(false)} />}

      {pwSheet && (
        <PhPasswordSheet
          onClose={() => setPwSheet(false)}
          onSuccess={(msg) => showToast(msg, 'success')}
        />
      )}

      {langSheet && (
        <PhLanguageSheet onClose={(picked) => {
          setLangSheet(false);
          if (picked) showToast(I18N[picked].saved);
        }} />
      )}

      {/* The order screen owns the bottom of the phone: its action bar sits at
          z-index 25 and the tab bar at 30, so every control down there — save,
          download, archive, delete — was covered by the nav and untappable.
          It is a focused task screen like the capture flow, and the header's
          back button is the way out of it. */}
      {!orderDetailOpen && (
        <PhTabBar view={view} setView={setView} onCenterPress={startSubmit} role={effUser?.role ?? user.role} />
      )}

      {overlayEl}
    </div>
  );
}

// MobileApp is mounted by App.tsx when the viewport is phone-sized.
// LangProvider is set up at the top of App.tsx so both shells share state.
export function MobileApp() {
  return <Shell />;
}
