import { useState } from 'react';
import { api } from './api';
import { handleFetchError, showErrorDialog } from './errorToast';
import { useT } from './i18n';
import { blobToDataUrl, compressForUpload } from './image-compress';
import { scanPaymentScreenshot } from './packages';
import { normalizePaypalTxnInput } from './paypalTxn';
import { scanErrorBanner, type ScanErrorBanner } from './scanError';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from './status';
import type { PaymentShot } from './useAddPackageForm';

// The proof half of a PO's payment: the PayPal screenshot scan, the chat with
// the seller (Submission attachments) and the cash screenshot (Payment
// attachments). One hook behind every PaymentFields — the hand-off dialog, the
// phone sheet and both PO pages — so what counts as "on file" cannot drift
// between them. The picker half (paid by / method / id) stays with whoever
// owns the form: the pages keep it in their own draft state.

export type ProofAttachment = { id: string; filename: string; size: number; mime: string; url: string };

export type ProofBucket = 'Submission' | 'Payment';

export type PaymentProofInit = {
  /** Null on the create pages: nothing can be attached before the order exists. */
  orderId: string | null;
  chatAtts?: ProofAttachment[];
  proofAtts?: ProofAttachment[];
  /** Where a transaction id read off a PayPal screenshot goes. */
  setTxnId: (v: string) => void;
};

export function usePaymentProof(init: PaymentProofInit) {
  const { t } = useT();
  const { orderId, setTxnId } = init;

  // ── PayPal screenshot → OCR, as useAddPackageForm does it ────────────────
  const [screenshot, setScreenshot] = useState<PaymentShot | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<ScanErrorBanner | null>(null);

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
        setTxnId(normalizePaypalTxnInput(r.txnId));
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

  // ── The two attachment buckets ───────────────────────────────────────────
  const [chatAtts, setChatAtts] = useState<ProofAttachment[]>(init.chatAtts ?? []);
  const [proofAtts, setProofAtts] = useState<ProofAttachment[]>(init.proofAtts ?? []);
  const [uploading, setUploading] = useState<ProofBucket | null>(null);

  const setterFor = (bucket: ProofBucket) => (bucket === 'Submission' ? setChatAtts : setProofAtts);

  const addFiles = async (bucket: ProofBucket, fl: FileList | File[] | null) => {
    const files = Array.from(fl ?? []);
    if (!files.length || !orderId) return;
    setUploading(bucket);
    try {
      for (const f of files) {
        // 50 MiB server hard cap; oversized images are shrunk server-side.
        if (f.size > 50 * 1024 * 1024) { showErrorDialog(t('fileTooLarge', { name: f.name })); continue; }
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

  /** Re-seed both lists from a fresh server read. The pages call this when
   *  the order's version moves — never on a mere refetch that returned the
   *  same thing, which would wipe an upload still settling. */
  const sync = (chat: ProofAttachment[], proof: ProofAttachment[]) => {
    setChatAtts(chat);
    setProofAtts(proof);
  };

  return {
    canAttach: orderId !== null,
    screenshot, scanBusy, scanNoticeKey, scanError, handlePaymentFile, removeScreenshot,
    chatAtts, proofAtts,
    chatUploading: uploading === 'Submission',
    proofUploading: uploading === 'Payment',
    addChatFiles: (fl: FileList | File[] | null) => addFiles('Submission', fl),
    removeChatAtt: (att: ProofAttachment) => removeAtt('Submission', att),
    addProofFiles: (fl: FileList | File[] | null) => addFiles('Payment', fl),
    removeProofAtt: (att: ProofAttachment) => removeAtt('Payment', att),
    busy: scanBusy || uploading !== null,
    sync,
  };
}

export type PaymentProof = ReturnType<typeof usePaymentProof>;
