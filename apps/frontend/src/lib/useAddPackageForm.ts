import { useMemo, useRef, useState } from 'react';
import { detectCarriers, normalizeTracking, type Carrier } from './carrierDetect';
import { handleFetchError } from './errorToast';
import { addPackage } from './packages';

// The add-package form's whole non-JSX state machine, shared by the desktop
// page and the phone screen so the two shells can't drift on what a valid
// paste is — auto-pick rule, hint priority, submit threshold, double-submit
// guard. Each shell keeps only its markup.

export const FMT_HINT_KEY: Record<Carrier, string> = {
  UPS: 'shipFmtUps',
  FedEx: 'shipFmtFedex',
  USPS: 'shipFmtUsps',
};

export function useAddPackageForm(onAdded: (added: { carrier: Carrier; tn: string }) => void) {
  const [raw, setRawState] = useState('');
  const [pick, setPick] = useState<Carrier | null>(null);
  const [sellerName, setSellerName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const tn = normalizeTracking(raw);
  const detected = useMemo(() => detectCarriers(raw), [raw]);
  // A single detection selects itself; ambiguity or no match leaves the pick
  // to the user. A manual pick always wins.
  const carrier = pick ?? (detected.length === 1 ? detected[0] : null);
  const unknownShape = tn.length >= 10 && detected.length === 0;
  const canSubmit = tn.length >= 8 && carrier != null && !busy;

  /** i18n key for the live hint line, or null for the quiet placeholder. */
  const hintKey =
    carrier != null && detected.length === 1 && !pick ? 'shipAddCarrierAuto'
    : detected.length > 1 && !pick ? 'shipAddCarrierPick'
    : unknownShape && !pick ? 'shipAddCarrierUnknown'
    : null;

  // A new paste invalidates the manual pick — the shape rules re-decide.
  const setRaw = (v: string) => { setRawState(v); setPick(null); };

  // setBusy hasn't rendered yet when Enter fires twice in one tick — the ref
  // is the same-tick guard the state can't be.
  const submitting = useRef(false);
  const submit = async () => {
    if (!canSubmit || carrier == null || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await addPackage({ trackingNumber: tn, carrier, sellerName, note });
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
  };
}
