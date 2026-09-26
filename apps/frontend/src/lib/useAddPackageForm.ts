import { useRef, useState } from 'react';
import type { Carrier } from './carrierDetect';
import { handleFetchError, showErrorDialog } from './errorToast';
import { useT } from './i18n';
import { blobToDataUrl, compressForUpload } from './image-compress';
import { addPackage, scanPaymentScreenshot } from './packages';
import type { PackageSource } from './packageSource';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from './paypalTxn';
import { scanErrorBanner, type ScanErrorBanner } from './scanError';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from './status';
import { useTrackingInput } from './useTrackingInput';

// The add-package form's whole non-JSX state machine, shared by the desktop
// page and the phone screen so the two shells can't drift on what a valid
// paste is — auto-pick rule, hint priority, submit threshold, double-submit
// guard. Each shell keeps only its markup.

export const FMT_HINT_KEY: Record<Carrier, string> = {
  UPS: 'shipFmtUps',
  FedEx: 'shipFmtFedex',
  USPS: 'shipFmtUsps',
};

export type PaymentShot = { key: string; url: string; preview: string };

export function useAddPackageForm(onAdded: (added: { carrier: Carrier; tn: string }) => void) {
  const { t } = useT();
  const { raw, setRaw, pick, setPick, tn, detected, carrier, valid, hintKey } = useTrackingInput();
  const [sellerName, setSellerName] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<PackageSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [paypalTxnId, setPaypalTxnIdState] = useState('');
  const [screenshot, setScreenshot] = useState<PaymentShot | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // i18n key for the scan-result banner (stub / unreadable / verify), or null.
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<ScanErrorBanner | null>(null);

  // A mid-scan submit would race the screenshot reference; wait it out.
  const canSubmit = valid && carrier != null && source != null && !busy && !scanBusy;

  // Typing keeps the server's canon live in the input, so what the user reads
  // is exactly what submit sends and the PO later diffs against.
  const setPaypalTxnId = (v: string) => setPaypalTxnIdState(normalizePaypalTxnInput(v));
  // Non-empty but not the canonical 17-char shape → the shell shows a
  // double-check hint. Not a submit gate: edge-case ids exist.
  const txnLooksOdd = paypalTxnId !== '' && !isStrictPaypalTxnId(paypalTxnId);

  /** Scan a dropped/picked PayPal screenshot; autofills the txn input. */
  const handlePaymentFile = async (files: FileList | File[] | null) => {
    if (scanBusy || !files) return;
    const file = Array.from(files).find(f => f.type.startsWith('image/'));
    if (!file) {
      if (files.length) setScanError({ key: 'aiOnlyImages' });
      return;
    }
    setScanBusy(true);
    setScanError(null);
    setScanNoticeKey(null);
    try {
      // Compression and the preview are local canvas work. A HEIC or a corrupt
      // screenshot throws here, and it is not an ApiError — reported through
      // the same classifier it would read as an outage and send the user off
      // to escalate, when re-saving as JPEG is the actual fix.
      const local = await compressForUpload(file)
        .then(async (compressed) => ({ compressed, preview: await blobToDataUrl(compressed) }))
        .catch((e: unknown) => { console.error('[scan] could not read the image locally', e); return null; });
      if (!local) {
        setScanError({ key: 'shipPayScanFailed' });
        return;
      }
      const scan = await scanPaymentScreenshot(local.compressed, file.name);
      setScreenshot({ key: scan.storageKey, url: scan.deliveryUrl, preview: local.preview });
      // Scan wins, the user corrects after — same contract as the label scan.
      setPaypalTxnIdState(scan.txnId ?? '');
      // Only when the scan actually read one: a screenshot whose id is legible
      // but whose name isn't must not wipe a name the user already typed.
      if (scan.sellerName) setSellerName(scan.sellerName);
      if (scan.provider === 'stub') setScanNoticeKey('stubScanWarn');
      else if (scan.txnId === null || scan.confidence < AI_UNREADABLE_FLOOR) setScanNoticeKey('shipPayNoTxnFound');
      else if (scan.confidence < AI_CONFIDENCE_FLOOR) setScanNoticeKey('shipPayVerifyTxn');
    } catch (e) {
      // A failed scan never blocks the package: the id can be typed by hand.
      // The pipeline being down reads differently from a 4xx the backend has
      // already explained (rate limit, unsupported type, too large), so keep
      // its own words rather than collapsing them into "couldn't read it".
      setScanError(scanErrorBanner(e));
    } finally {
      setScanBusy(false);
    }
  };

  const removeScreenshot = () => {
    setScreenshot(null);
    setScanNoticeKey(null);
    setScanError(null);
  };

  // setBusy hasn't rendered yet when Enter fires twice in one tick — the ref
  // is the same-tick guard the state can't be.
  const submitting = useRef(false);
  const submit = async () => {
    if (!canSubmit || carrier == null || source == null || submitting.current) return;
    // The id is what reconciles this box's payment to its PO later — it carries
    // onto the order and banktx auto-links on it. The Payments page is
    // manager-only, so a purchaser who doesn't have it has to ask, not skip.
    // Held before the double-submit latch: an early return past it would swallow
    // every later attempt in silence.
    if (!paypalTxnId) {
      showErrorDialog(t('errCantSubmitMsg'), [t('shipPayTxnRequired')], t('errCantSubmitTitle'));
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await addPackage({
        trackingNumber: tn, carrier, source, sellerName, note,
        paypalTxnId,
        ...(screenshot ? { paymentScreenshotKey: screenshot.key, paymentScreenshotUrl: screenshot.url } : {}),
      });
      onAdded({ carrier, tn });
    } catch (e) {
      handleFetchError(e);
      submitting.current = false;
      setBusy(false);
    }
  };

  return {
    raw, setRaw, pick, setPick, sellerName, setSellerName, note, setNote,
    source, setSource,
    busy, tn, detected, carrier, canSubmit, hintKey, submit,
    paypalTxnId, setPaypalTxnId, txnLooksOdd,
    screenshot, scanBusy, scanNoticeKey, scanError, handlePaymentFile, removeScreenshot,
  };
}
