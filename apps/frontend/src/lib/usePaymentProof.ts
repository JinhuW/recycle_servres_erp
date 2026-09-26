import { useState } from 'react';
import { api, MAX_UPLOAD_BYTES } from './api';
import { handleFetchError, showErrorDialog } from './errorToast';
import { useT } from './i18n';
import { compressForUpload } from './image-compress';
import { readPaypalScan } from './paypalTxn';
import { scanErrorBanner, type ScanErrorBanner } from './scanError';

// The proof half of a PO's payments: the chat with the seller (Submission
// attachments), the PayPal or cash screenshot (Payment attachments) and the
// commission-payment screenshot (Commission attachments — the second payment
// on the order, what the purchaser was paid). One hook behind every
// PaymentFields — the hand-off dialog, the phone sheet and both PO pages — so
// what counts as "on file" cannot drift between them. The picker half (paid
// by / method / id) stays with whoever owns the form: the pages keep it in
// their own draft state.

export type ProofAttachment = { id: string; filename: string; size: number; mime: string; url: string };

export type ProofBucket = 'Submission' | 'Payment' | 'Commission';

export type PaymentProofInit = {
  /** Null on the create pages: nothing can be attached before the order exists. */
  orderId: string | null;
  chatAtts?: ProofAttachment[];
  proofAtts?: ProofAttachment[];
  commissionAtts?: ProofAttachment[];
  /** Where a transaction id read off a PayPal screenshot goes. */
  setTxnId: (v: string) => void;
};

export function usePaymentProof(init: PaymentProofInit) {
  const { t } = useT();
  const { orderId, setTxnId } = init;

  // ── The three attachment buckets ─────────────────────────────────────────
  const [chatAtts, setChatAtts] = useState<ProofAttachment[]>(init.chatAtts ?? []);
  const [proofAtts, setProofAtts] = useState<ProofAttachment[]>(init.proofAtts ?? []);
  const [commissionAtts, setCommissionAtts] = useState<ProofAttachment[]>(init.commissionAtts ?? []);
  const [uploading, setUploading] = useState<ProofBucket | null>(null);

  const setterFor = (bucket: ProofBucket) =>
    bucket === 'Submission' ? setChatAtts : bucket === 'Payment' ? setProofAtts : setCommissionAtts;

  const addFiles = async (bucket: ProofBucket, fl: FileList | File[] | null) => {
    const files = Array.from(fl ?? []);
    if (!files.length || !orderId) return;
    setUploading(bucket);
    try {
      for (const f of files) {
        // 50 MiB server hard cap; oversized images are shrunk server-side.
        if (f.size > MAX_UPLOAD_BYTES) { showErrorDialog(t('fileTooLarge', { name: f.name })); continue; }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: ProofAttachment }>(
          `/api/orders/${orderId}/status-meta/${bucket}/attachments`, form);
        setterFor(bucket)(prev => [...prev, r.attachment]);
      }
    } catch (e) {
      handleFetchError(e);
    } finally {
      setUploading(null);
    }
  };
  const removeAtt = async (bucket: ProofBucket, att: ProofAttachment) => {
    if (!orderId) return;
    try {
      await api.delete(`/api/orders/${orderId}/status-meta/${bucket}/attachments/${att.id}`);
      setterFor(bucket)(prev => prev.filter(a => a.id !== att.id));
    } catch (e) {
      handleFetchError(e);
    }
  };

  // ── PayPal screenshot: stored as a Payment attachment, id read in passing ──
  // The upload is the record; the transaction id it yields is a convenience
  // the user can type themselves, so a failed read keeps the file.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<ScanErrorBanner | null>(null);

  const handlePaymentFile = async (files: FileList | File[] | null) => {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'));
    if (!file) { setScanError({ key: 'aiOnlyImages' }); return; }
    if (!orderId) return;
    setScanBusy(true);
    setScanError(null);
    setScanNoticeKey(null);
    let upload: File;
    try {
      const compressed = await compressForUpload(file);
      // Compression re-encodes as JPEG; the stored name should say so.
      const name = compressed.type === 'image/jpeg' ? file.name.replace(/\.[^.]+$/, '') + '.jpg' : file.name;
      upload = new File([compressed], name, { type: compressed.type || file.type });
    } catch {
      setScanError({ key: 'shipPayScanFailed' });
      setScanBusy(false);
      return;
    }
    try {
      const form = new FormData();
      form.append('file', upload);
      const r = await api.upload<{
        attachment: ProofAttachment;
        // Null when the OCR failed; absent from a backend that predates it.
        scan?: { txnId: string | null; confidence: number; provider: string } | null;
      }>(`/api/orders/${orderId}/status-meta/Payment/attachments?scan=paypal`, form);
      setProofAtts(prev => [...prev, r.attachment]);
      // Absent (a backend that never ran a scan) is not a failed read: only
      // an explicit null means the OCR threw.
      if (r.scan === undefined) return;
      if (r.scan === null) { setScanError({ key: 'shipPayScanFailed' }); return; }
      const read = readPaypalScan(r.scan);
      if (read.txnId) setTxnId(read.txnId);
      setScanNoticeKey(read.noticeKey);
    } catch (e) {
      setScanError(scanErrorBanner(e));
    } finally {
      setScanBusy(false);
    }
  };

  /** Re-seed the lists from a fresh server read. The pages call this when
   *  the order's version moves — never on a mere refetch that returned the
   *  same thing, which would wipe an upload still settling. */
  const sync = (chat: ProofAttachment[], proof: ProofAttachment[], commission: ProofAttachment[]) => {
    setChatAtts(chat);
    setProofAtts(proof);
    setCommissionAtts(commission);
  };

  return {
    canAttach: orderId !== null,
    scanBusy, scanNoticeKey, scanError, handlePaymentFile,
    chatAtts, proofAtts,
    chatUploading: uploading === 'Submission',
    proofUploading: uploading === 'Payment',
    addChatFiles: (fl: FileList | File[] | null) => addFiles('Submission', fl),
    removeChatAtt: (att: ProofAttachment) => removeAtt('Submission', att),
    addProofFiles: (fl: FileList | File[] | null) => addFiles('Payment', fl),
    removeProofAtt: (att: ProofAttachment) => removeAtt('Payment', att),
    commissionAtts,
    commissionUploading: uploading === 'Commission',
    addCommissionFiles: (fl: FileList | File[] | null) => addFiles('Commission', fl),
    removeCommissionAtt: (att: ProofAttachment) => removeAtt('Commission', att),
    // The hand-off's "is anything still settling" — the commission screenshot
    // is not the hand-off's business, so it does not hold its Confirm.
    busy: scanBusy || (uploading !== null && uploading !== 'Commission'),
    sync,
  };
}

export type PaymentProof = ReturnType<typeof usePaymentProof>;
