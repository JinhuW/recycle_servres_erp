import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Carrier } from './carrierDetect';
import { handleFetchError } from './errorToast';
import { buildHandoffBody, type HandoffDelivery, type HandoffMethod } from './handoff';
import type { PackageSource } from './packageSource';
import { normalizePaypalTxnInput } from './paypalTxn';
import { poEffectiveCost } from './poTotals';
import { poReadiness, readinessBlockerKeys } from './poReadiness';
import type { Order, Warehouse } from './types';
import type { PaymentProof } from './usePaymentProof';
import { useTrackingInput } from './useTrackingInput';
import { loadWarehouses } from './warehouses';

// The hand-off checkpoint's whole non-JSX state, shared by the desktop dialog
// and the phone sheet so the two shells can't drift on what a complete
// hand-off is. Each shell keeps only its markup. Seeded from what the page
// already holds — the saved facts, the linked package's number — so a section
// the order has answered folds to a ✓ row and only the missing ones open.
// Tracking detection is lib/useTrackingInput.ts, the same as the Delivery
// section's; the payment proof is the page's own usePaymentProof instance,
// handed in — a second copy seeded from the `order` prop went stale the moment
// the page uploaded a file, and the dialog then asked for a screenshot that
// was already on file.

export type HandoffInit = {
  order: Order;
  /** Seeded from the page's current values, which equal the saved order when
   *  the page is clean (the desktop asks for a save first otherwise). */
  warehouseId: string;
  payment: 'company' | 'self';
  paymentMethod: HandoffMethod | null;
  paypalTxnId: string;
  /** The page's proof hook, shared so both surfaces see one attachment list. */
  proof: PaymentProof;
  currentUser: { id: string; name: string };
};

export function useHandoffForm(init: HandoffInit, onDone: (r: { packageId: string | null }) => void) {
  const { order } = init;

  const [warehouseId, setWarehouseId] = useState(init.warehouseId);
  const [source, setSource] = useState<PackageSource | null>(order.source ?? null);
  const [delivery, setDelivery] = useState<HandoffDelivery | null>(order.handoffMethod ?? null);
  const [byUserId, setByUserId] = useState(order.handoffBy?.id ?? init.currentUser.id);
  const tracking = useTrackingInput(
    order.handoffMethod === 'label' ? order.package?.trackingNumber ?? '' : '',
    order.handoffMethod === 'label' ? (order.package?.carrier as Carrier | undefined) ?? null : null,
  );
  const [paidBy, setPaidBy] = useState<'company' | 'self'>(init.payment);
  // A company order that was never asked stays null and the dialog asks —
  // defaulting to PayPal here is how a cash deal ended up chasing an id.
  const [method, setMethod] = useState<HandoffMethod | null>(init.paymentMethod);
  const [txnId, setTxnIdState] = useState(init.paypalTxnId);
  const { proof } = init;
  // A PayPal screenshot scanned here lands in the page's id field (the shared
  // hook's setter is the page's); follow it into the dialog's own field. Only
  // the page's value moving fires this, so typing here is never overwritten.
  useEffect(() => { setTxnIdState(init.paypalTxnId); }, [init.paypalTxnId]);
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

  const { raw, setRaw, pick, setPick, tn, detected, carrier, hintKey } = tracking;

  const setTxnId = (v: string) => setTxnIdState(normalizePaypalTxnInput(v));

  // ── Readiness and submit ─────────────────────────────────────────────────
  // Judged from the form: everything here is the user's live answer, and the
  // server's list is what the page showed before the dialog opened.
  const goods = poEffectiveCost({
    lineSubtotal: order.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0),
    totalCostOverride: order.totalCost,
  }).goods;
  const readiness = poReadiness({
    rules: {
      source, delivery, trackingValid: tracking.valid, carrier, paidBy, method, txnId,
      chatAttachmentCount: proof.chatAtts.length,
      proofAttachmentCount: proof.proofAtts.length,
      saved: {
        payment: order.payment, paymentMethod: order.paymentMethod, txnRequired: order.txnRequired,
        chatShotRequired: order.chatShotRequired, cashShotRequired: order.cashShotRequired,
      },
    },
    lines: { count: order.lines.length, goods, everSubmitted: order.everSubmitted === true },
  });
  const blockerKeys = readinessBlockerKeys(readiness);
  const canSubmit = blockerKeys.length === 0 && !busy && !proof.busy;

  const submitting = useRef(false);
  const submit = async () => {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const body = buildHandoffBody({
        warehouseId, source: source!, delivery: delivery!, byUserId, trackingNumber: tn, carrier,
        paidBy, method, txnId,
        screenshot: proof.screenshot ? { key: proof.screenshot.key, url: proof.screenshot.url } : null,
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
    order,
    warehouseId, setWarehouseId, warehouses,
    source, setSource,
    delivery, setDelivery,
    byUserId, setByUserId, members,
    raw, setRaw, pick, setPick, tn, detected, carrier, hintKey,
    paidBy, setPaidBy, method, setMethod,
    txnId, setTxnId, proof,
    readiness, blockerKeys, canSubmit, busy, submit,
  };
}

export type HandoffForm = ReturnType<typeof useHandoffForm>;
