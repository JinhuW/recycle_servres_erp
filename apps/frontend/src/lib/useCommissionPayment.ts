import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import type { HandoffMethod } from './handoff';
import { normalizePaypalTxnInput, readPaypalScan } from './paypalTxn';
import { scanErrorBanner, type ScanErrorBanner } from './scanError';
import type { ProofAttachment } from './usePaymentProof';

// How the purchaser was paid their commission — method, PayPal id and the
// screenshot — behind the desktop Commission tab and the phone fold. Unlike
// the cost payment this is not part of the page's draft and Save: the
// commission is paid once the PO is a closed book, where Save is off and
// PATCH refuses to write, so every change here goes straight to the server
// the way the evidence uploads already do. Nothing is shown as saved before
// the server said so: a failed write leaves the form where the record is.

type Scan = { txnId: string | null; confidence: number; provider: string } | null;

export type CommissionPaymentInit = {
  orderId: string;
  method: HandoffMethod | null;
  txnId: string;
  atts: ProofAttachment[];
  /** After every successful write — the pages refresh their activity log. */
  onMutated?: () => void;
};

const TXN_SAVE_DELAY_MS = 800;

export function useCommissionPayment(init: CommissionPaymentInit) {
  const { orderId, onMutated } = init;
  const path = `/api/orders/${orderId}/commission-payment`;

  const [method, setMethodState] = useState<HandoffMethod | null>(init.method);
  const [txnId, setTxnIdState] = useState(init.txnId);
  const [atts, setAtts] = useState<ProofAttachment[]>(init.atts);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<ScanErrorBanner | null>(null);

  // The id is typed, so it saves on a pause, on blur and on Enter. The timer
  // reads what is in the box *now* (the ref), never the render it was armed
  // in, and the last value sent is recorded when the request starts, so blur
  // followed by the timer cannot send the same thing twice.
  const txnRef = useRef(init.txnId);
  const lastSavedTxn = useRef(init.txnId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clearTimer, []);

  const putTxnId = async (value: string) => {
    lastSavedTxn.current = value;
    try {
      const r = await api.put<{ commissionTxnId: string | null }>(path, { txnId: value || null });
      const saved = r.commissionTxnId ?? '';
      lastSavedTxn.current = saved;
      // Only echo the server if the user has not typed on since.
      if (txnRef.current === value && saved !== value) { txnRef.current = saved; setTxnIdState(saved); }
      onMutated?.();
    } catch (e) {
      handleFetchError(e);
    }
  };
  const flushTxnId = () => {
    clearTimer();
    const value = txnRef.current;
    if (value !== lastSavedTxn.current) void putTxnId(value);
  };
  const setTxnId = (raw: string) => {
    const value = normalizePaypalTxnInput(raw);
    txnRef.current = value;
    setTxnIdState(value);
    clearTimer();
    timer.current = setTimeout(flushTxnId, TXN_SAVE_DELAY_MS);
  };

  // Picking PayPal on a record that has none still writes it: the picker
  // showed PayPal, but the record said nothing until now.
  const setMethod = async (m: HandoffMethod) => {
    if (m === method || saving) return;
    setSaving(true);
    try {
      const r = await api.put<{ commissionMethod: HandoffMethod | null }>(path, { method: m });
      setMethodState(r.commissionMethod);
      onMutated?.();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSaving(false);
    }
  };

  // One screenshot at a time. The server stores it under the order and reads
  // it for a PayPal id on the way; an empty box takes that id and saves it at
  // once, a box with something in it is left alone and told so. No client
  // compression: the server shrinks before storing and before reading, as it
  // does for the cost-payment proof.
  const addShot = async (files: FileList | File[] | null) => {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'));
    if (!file) { setScanError({ key: 'aiOnlyImages' }); return; }
    setUploading(true);
    setScanError(null);
    setScanNoticeKey(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.upload<{ attachment: ProofAttachment; scan?: Scan }>(
        `/api/orders/${orderId}/status-meta/Commission/attachments`, form);
      setAtts(prev => [...prev, r.attachment]);
      onMutated?.();
      if (r.scan) {
        const read = readPaypalScan(r.scan);
        if (read.txnId && txnRef.current === '') {
          setTxnId(read.txnId);
          flushTxnId();
          setScanNoticeKey(read.noticeKey);
        } else {
          setScanNoticeKey(read.txnId ? 'cpShotKeptId' : read.noticeKey);
        }
      }
    } catch (e) {
      setScanError(scanErrorBanner(e));
    } finally {
      setUploading(false);
    }
  };

  const removeShot = async (att: ProofAttachment) => {
    try {
      await api.delete(`/api/orders/${orderId}/status-meta/Commission/attachments/${att.id}`);
      setAtts(prev => prev.filter(a => a.id !== att.id));
      onMutated?.();
    } catch (e) {
      handleFetchError(e);
    }
  };

  /** Re-seed from a fresh server read. The phone page calls this when the
   *  order's version moves; a save still pending for the value it replaces is
   *  dropped rather than let overwrite it. */
  const sync = (m: HandoffMethod | null, id: string, list: ProofAttachment[]) => {
    clearTimer();
    txnRef.current = id;
    lastSavedTxn.current = id;
    setMethodState(m);
    setTxnIdState(id);
    setAtts(list);
  };

  return {
    /** What the picker shows: the record, or PayPal until one is made. */
    method: method ?? 'paypal',
    txnId, atts, saving, uploading, scanNoticeKey, scanError,
    setMethod, setTxnId, flushTxnId, addShot, removeShot, sync,
    /** Whether anything has been recorded yet — an id or a screenshot. */
    onFile: txnId !== '' || atts.length > 0,
  };
}

export type CommissionPayment = ReturnType<typeof useCommissionPayment>;
