import { useMemo, useRef, useState } from 'react';
import { detectCarriers, normalizeTracking, type Carrier } from './carrierDetect';
import { handleFetchError } from './errorToast';
import { blobToDataUrl, compressForUpload } from './image-compress';
import { addPackage, scanPaymentScreenshot } from './packages';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from './paypalTxn';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from './status';

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
  const [raw, setRawState] = useState('');
  const [pick, setPick] = useState<Carrier | null>(null);
  const [sellerName, setSellerName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [paypalTxnId, setPaypalTxnIdState] = useState('');
  const [screenshot, setScreenshot] = useState<PaymentShot | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // i18n key for the scan-result banner (stub / unreadable / verify), or null.
  const [scanNoticeKey, setScanNoticeKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const tn = normalizeTracking(raw);
  const detected = useMemo(() => detectCarriers(raw), [raw]);
  // A single detection selects itself; ambiguity or no match leaves the pick
  // to the user. A manual pick always wins.
  const carrier = pick ?? (detected.length === 1 ? detected[0] : null);
  const unknownShape = tn.length >= 10 && detected.length === 0;
  // A mid-scan submit would race the screenshot reference; wait it out.
  const canSubmit = tn.length >= 8 && carrier != null && !busy && !scanBusy;

  /** i18n key for the live hint line, or null for the quiet placeholder. */
  const hintKey =
    carrier != null && detected.length === 1 && !pick ? 'shipAddCarrierAuto'
    : detected.length > 1 && !pick ? 'shipAddCarrierPick'
    : unknownShape && !pick ? 'shipAddCarrierUnknown'
    : null;

  // A new paste invalidates the manual pick — the shape rules re-decide.
  const setRaw = (v: string) => { setRawState(v); setPick(null); };

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
      if (files.length) setScanError('images-only');
      return;
    }
    setScanBusy(true);
    setScanError(null);
    setScanNoticeKey(null);
    try {
      const compressed = await compressForUpload(file);
      const preview = await blobToDataUrl(compressed);
      const scan = await scanPaymentScreenshot(compressed, file.name);
      setScreenshot({ key: scan.storageKey, url: scan.deliveryUrl, preview });
      // Scan wins, the user corrects after — same contract as the label scan.
      setPaypalTxnIdState(scan.txnId ?? '');
      if (scan.provider === 'stub') setScanNoticeKey('stubScanWarn');
      else if (scan.txnId === null || scan.confidence < AI_UNREADABLE_FLOOR) setScanNoticeKey('shipPayNoTxnFound');
      else if (scan.confidence < AI_CONFIDENCE_FLOOR) setScanNoticeKey('shipPayVerifyTxn');
    } catch (e) {
      // A failed scan never blocks the package: the id can be typed by hand.
      setScanError(e instanceof Error ? e.message : 'scan failed');
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
    if (!canSubmit || carrier == null || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await addPackage({
        trackingNumber: tn, carrier, sellerName, note,
        ...(paypalTxnId ? { paypalTxnId } : {}),
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
    busy, tn, detected, carrier, canSubmit, hintKey, submit,
    paypalTxnId, setPaypalTxnId, txnLooksOdd,
    screenshot, scanBusy, scanNoticeKey, scanError, handlePaymentFile, removeScreenshot,
  };
}
