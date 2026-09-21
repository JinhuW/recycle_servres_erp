import { useMemo, useState } from 'react';
import { detectCarriers, isValidTracking, normalizeTracking, type Carrier } from './carrierDetect';

// A pasted tracking number and the carrier it implies, as the add-package form
// and the hand-off do it: the number's shape picks the carrier when it can,
// a manual pick wins when it can't, and a new paste clears the pick — the
// number, not the last click, decides. Shared by the checkpoint and both
// shells' Delivery sections so the three can't recognise a label differently.

export type TrackingResolved = {
  tn: string;
  detected: Carrier[];
  carrier: Carrier | null;
  valid: boolean;
  hintKey: string | null;
};

/** The pure half, for a caller whose state lives elsewhere (the phone's
 *  order draft). */
export function resolveTracking(raw: string, pick: Carrier | null): TrackingResolved {
  const tn = normalizeTracking(raw);
  const detected = detectCarriers(raw);
  const carrier = pick ?? (detected.length === 1 ? detected[0] : null);
  const valid = isValidTracking(tn);
  const unknownShape = tn.length >= 10 && detected.length === 0;
  const invalidShape = tn.length >= 8 && !valid;
  const hintKey =
    invalidShape ? 'shipAddTrackingInvalid'
    : carrier != null && detected.length === 1 && !pick ? 'shipAddCarrierAuto'
    : detected.length > 1 && !pick ? 'shipAddCarrierPick'
    : unknownShape && !pick ? 'shipAddCarrierUnknown'
    : null;
  return { tn, detected, carrier, valid, hintKey };
}

export function useTrackingInput(initial = '', initialCarrier: Carrier | null = null) {
  const [raw, setRawState] = useState(initial);
  const [pick, setPick] = useState<Carrier | null>(initialCarrier);
  const resolved = useMemo(() => resolveTracking(raw, pick), [raw, pick]);
  const setRaw = (v: string) => { setRawState(v); setPick(null); };
  /** Reseed from a saved value without clearing an explicit carrier. */
  const reset = (value: string, c: Carrier | null) => { setRawState(value); setPick(c); };
  return { raw, setRaw, pick, setPick, ...resolved, reset };
}

export type TrackingInput = ReturnType<typeof useTrackingInput>;
