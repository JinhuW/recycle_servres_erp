import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { detectCarriers, isValidTracking, normalizeTracking, type Carrier } from './carrierDetect';
import { handleFetchError, showErrorDialog } from './errorToast';
import { buildHandoffBody, handoffBlockerKeys, type HandoffDelivery, type HandoffMethod } from './handoff';
import { useT } from './i18n';
import { blobToDataUrl, compressForUpload } from './image-compress';
import { scanPaymentScreenshot } from './packages';
import type { PackageSource } from './packageSource';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from './paypalTxn';
import { scanErrorBanner, type ScanErrorBanner } from './scanError';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from './status';
import type { Order, Warehouse } from './types';
import type { PaymentShot } from './useAddPackageForm';
import { loadWarehouses } from './warehouses';

// The hand-off dialog's whole non-JSX state, shared by the desktop dialog and
// the phone sheet so the two shells can't drift on what a complete hand-off is.
// Each shell keeps only its markup. Tracking detection and the PayPal
// screenshot scan follow useAddPackageForm exactly — same rules, same hints.

export type ChatAttachment = { id: string; filename: string; size: number; mime: string; url: string };

export type HandoffInit = {
  order: Order;
  /** Seeded from the page's current values, which equal the saved order when
   *  the page is clean (the desktop asks for a save first otherwise). */
  warehouseId: string;
  payment: 'company' | 'self';
  paypalTxnId: string;
  /** Manager-only seeds; a purchaser's shell passes neither. */
  ownerId?: string;
  commissionRate?: number | null;
  isManager: boolean;
  currentUser: { id: string; name: string };
};

export function useHandoffForm(init: HandoffInit, onDone: (r: { packageId: string | null }) => void) {
  const { t } = useT();
  const { order } = init;

  const [warehouseId, setWarehouseId] = useState(init.warehouseId);
  const [source, setSource] = useState<PackageSource | null>(order.source ?? null);
  const [delivery, setDelivery] = useState<HandoffDelivery | null>(order.handoffMethod ?? null);
  const [byUserId, setByUserId] = useState(order.handoffBy?.id ?? init.currentUser.id);
  const [raw, setRawState] = useState('');
  const [pick, setPick] = useState<Carrier | null>(null);
  const [paidBy, setPaidBy] = useState<'company' | 'self'>(init.payment);
  const [method, setMethod] = useState<HandoffMethod>(order.paymentMethod ?? 'paypal');
  const [txnId, setTxnIdState] = useState(init.paypalTxnId);
  const [screenshot, setScreenshot] = useState<PaymentShot | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<ScanErrorBanner | null>(null);
  const [chatAtts, setChatAtts] = useState<ChatAttachment[]>(
    order.statusMeta?.['Submission']?.attachments ?? [],
  );
  const [chatUploading, setChatUploading] = useState(false);
  const [ownerId, setOwnerId] = useState(init.ownerId ?? order.userId);
  const [commissionPct, setCommissionPct] = useState(
    init.commissionRate != null ? String(+(init.commissionRate * 100).toFixed(2)) : '',
  );
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWarehouses().then(ws => { if (alive) setWarehouses(ws); }).catch(handleFetchError);
    api.get<{ items: { id: string; name: string }[] }>('/api/members/names')
      .then(r => { if (alive) setMembers(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // ── Tracking, as useAddPackageForm does it ───────────────────────────────
  const tn = normalizeTracking(raw);
  const detected = useMemo(() => detectCarriers(raw), [raw]);
  const carrier = pick ?? (detected.length === 1 ? detected[0] : null);
  const unknownShape = tn.length >= 10 && detected.length === 0;
  const invalidShape = tn.length >= 8 && !isValidTracking(tn);
  const hintKey =
    invalidShape ? 'shipAddTrackingInvalid'
    : carrier != null && detected.length === 1 && !pick ? 'shipAddCarrierAuto'
    : detected.length > 1 && !pick ? 'shipAddCarrierPick'
    : unknownShape && !pick ? 'shipAddCarrierUnknown'
    : null;
  // A new paste clears the manual pick: the number, not the last click, decides.
  const setRaw = (v: string) => { setRawState(v); setPick(null); };

  const setTxnId = (v: string) => setTxnIdState(normalizePaypalTxnInput(v));
  const txnLooksOdd = txnId !== '' && !isStrictPaypalTxnId(txnId);

  // ── PayPal screenshot → OCR, as useAddPackageForm does it ────────────────
  const handlePaymentFile = async (files: FileList | File[] | null) => {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'));
    if (!file) { setScanError({ key: 'aiOnlyImages' }); return; }
    setScanBusy(true);
    setScanError(null);
    setScanNoticeKey(null);
    let local: { compressed: Blob; preview: string };
    try {
      const compressed = await compressForUpload(file);
      local = { compressed, preview: await blobToDataUrl(compressed) };
    } catch {
      setScanError({ key: 'shipPayScanFailed' });
      setScanBusy(false);
      return;
    }
    try {
      const r = await scanPaymentScreenshot(local.compressed, file.name);
      setScreenshot({ key: r.storageKey, url: r.deliveryUrl, preview: local.preview });
      if (r.txnId && r.confidence >= AI_UNREADABLE_FLOOR) {
        setTxnIdState(normalizePaypalTxnInput(r.txnId));
        setScanNoticeKey(r.provider === 'stub' ? 'stubScanWarn'
          : r.confidence < AI_CONFIDENCE_FLOOR ? 'shipPayVerifyTxn' : 'hoShotRead');
      } else {
        setScanNoticeKey('shipPayNoTxnFound');
      }
    } catch (e) {
      setScanError(scanErrorBanner(e));
    } finally {
      setScanBusy(false);
    }
  };
  const removeScreenshot = () => { setScreenshot(null); setScanNoticeKey(null); setScanError(null); };

  // ── Chat history → the order's Submission attachments ────────────────────
  const addChatFiles = async (fl: FileList | File[] | null) => {
    const files = Array.from(fl ?? []);
    if (!files.length) return;
    setChatUploading(true);
    try {
      for (const f of files) {
        if (f.size > 50 * 1024 * 1024) { showErrorDialog(t('fileTooLarge', { name: f.name })); continue; }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: ChatAttachment }>(
          `/api/orders/${order.id}/status-meta/Submission/attachments`, form);
        setChatAtts(prev => [...prev, r.attachment]);
      }
    } catch (e) {
      handleFetchError(e);
    } finally {
      setChatUploading(false);
    }
  };
  const removeChatAtt = async (att: ChatAttachment) => {
    try {
      await api.delete(`/api/orders/${order.id}/status-meta/Submission/attachments/${att.id}`);
      setChatAtts(prev => prev.filter(a => a.id !== att.id));
    } catch (e) {
      handleFetchError(e);
    }
  };

  // ── Blockers and submit ──────────────────────────────────────────────────
  const blockerKeys = handoffBlockerKeys({
    source, delivery, trackingValid: isValidTracking(tn), carrier, paidBy, method, txnId,
    chatAttachmentCount: chatAtts.length,
    saved: { payment: order.payment, txnRequired: order.txnRequired, chatShotRequired: order.chatShotRequired },
  });
  const canSubmit = blockerKeys.length === 0 && !busy && !scanBusy && !chatUploading;

  const submitting = useRef(false);
  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const pct = commissionPct.trim() === '' ? null : Number(commissionPct);
      const body = buildHandoffBody({
        warehouseId, source: source!, delivery: delivery!, byUserId, trackingNumber: tn, carrier,
        paidBy, method, txnId,
        screenshot: screenshot ? { key: screenshot.key, url: screenshot.url } : null,
        ...(init.isManager ? {
          ownerId: ownerId !== order.userId ? ownerId : undefined,
          commissionRate: pct === null || !Number.isFinite(pct) ? undefined : pct / 100,
        } : {}),
      });
      const r = await api.post<{ ok: true; packageId: string | null }>(`/api/orders/${order.id}/handoff`, body);
      onDone({ packageId: r.packageId });
    } catch (e) {
      handleFetchError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return {
    warehouseId, setWarehouseId, warehouses,
    source, setSource,
    delivery, setDelivery,
    byUserId, setByUserId, members,
    raw, setRaw, pick, setPick, tn, detected, carrier, hintKey,
    paidBy, setPaidBy, method, setMethod,
    txnId, setTxnId, txnLooksOdd,
    screenshot, scanBusy, scanNoticeKey, scanError, handlePaymentFile, removeScreenshot,
    chatAtts, chatUploading, addChatFiles, removeChatAtt,
    ownerId, setOwnerId, commissionPct, setCommissionPct,
    blockerKeys, canSubmit, busy, submit,
  };
}

export type HandoffForm = ReturnType<typeof useHandoffForm>;
