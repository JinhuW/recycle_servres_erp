// One answer to "what still stands between this Draft and In Transit", for
// every surface that asks: the phone's *Before you submit* list, the desktop's
// status panel and tab dots, and the hand-off checkpoint. Wraps the per-field
// rule in ./handoff.ts and the products/cost rule the two shells each used to
// carry, and prefers the server's own list (`order.blockers`) for anything the
// user has not touched since it was saved — the server knows the cutoffs and
// what PayPal has synced; the form knows what was just typed.

import { handoffBlockerKeys, type HandoffRules } from './handoff';

export type ReadinessTab = 'products' | 'delivery' | 'payment' | 'commission';

export type ReadinessItem = {
  tab: ReadinessTab;
  ok: boolean;
  /** False for the commission row: a rate is asked for, never required. */
  blocking: boolean;
  /** i18n keys naming what is missing, in display order. Empty when `ok`. */
  needKeys: string[];
};

export type ReadinessInput = {
  /** The hand-off rule's view of the order with the form's values overlaid. */
  rules: HandoffRules;
  lines: { count: number; goods: number; everSubmitted: boolean };
  /** Present for a manager, who owns the rate; absent hides the row. */
  commission?: { rate: number | null } | null;
  /** `order.blockers` as GET reported it, for a Draft. Null or undefined
   *  (an older backend, a non-Draft) means "form only". */
  serverBlockers?: string[] | null;
  /** Tabs whose fields differ from the saved order: those are judged from the
   *  form, the rest from the server's list. */
  dirty?: Partial<Record<ReadinessTab, boolean>>;
};

/** Which section owns each local blocker key. */
export const BLOCKER_TAB: Record<string, ReadinessTab> = {
  poReadyNoProducts: 'products',
  poReadyNoCost: 'products',
  hoNeedSource: 'delivery',
  hoNeedDelivery: 'delivery',
  hoNeedTracking: 'delivery',
  hoNeedCarrier: 'delivery',
  hoNeedMethod: 'payment',
  poTxnRequired: 'payment',
  poTxnUnknown: 'payment',
  hoNeedCashShot: 'payment',
  hoNeedChatShot: 'payment',
};

/** The server's blocker kinds, spelled as the i18n key the shells show. */
export const SERVER_BLOCKER_KEY: Record<string, string> = {
  noCost: 'poReadyNoCost',
  missingSource: 'hoNeedSource',
  missingDelivery: 'hoNeedDelivery',
  missingTracking: 'hoNeedTracking',
  missingMethod: 'hoNeedMethod',
  missingTxnId: 'poTxnRequired',
  unknownTxnId: 'poTxnUnknown',
  missingChatShot: 'hoNeedChatShot',
  missingCashShot: 'hoNeedCashShot',
};

/** A few words per blocker, for a list that names several at once. The
 *  full sentences (the keys themselves) stay for the checkpoint's footer. */
export const NEED_SHORT_KEY: Record<string, string> = {
  poReadyNoProducts: 'rdNoProducts',
  poReadyNoCost: 'rdNoCost',
  hoNeedSource: 'rdSource',
  hoNeedDelivery: 'rdDelivery',
  hoNeedTracking: 'rdTracking',
  hoNeedCarrier: 'rdCarrier',
  hoNeedMethod: 'rdMethod',
  poTxnRequired: 'rdTxn',
  poTxnUnknown: 'rdTxnUnknown',
  hoNeedCashShot: 'rdCashShot',
  hoNeedChatShot: 'rdChatShot',
  poReadyCommissionUnset: 'rdRate',
};

const TABS: ReadinessTab[] = ['products', 'delivery', 'payment'];

export function poReadiness(input: ReadinessInput): ReadinessItem[] {
  const local: string[] = [];
  if (input.lines.count === 0) local.push('poReadyNoProducts');
  else if (!(input.lines.goods > 0) && !input.lines.everSubmitted) local.push('poReadyNoCost');
  local.push(...handoffBlockerKeys(input.rules));

  const server = Array.isArray(input.serverBlockers)
    ? input.serverBlockers.map(k => SERVER_BLOCKER_KEY[k]).filter((k): k is string => !!k)
    : null;

  const items: ReadinessItem[] = TABS.map(tab => {
    const useServer = server !== null && !input.dirty?.[tab];
    const from = useServer ? server : local;
    const needKeys = from.filter(k => BLOCKER_TAB[k] === tab);
    return { tab, ok: needKeys.length === 0, blocking: true, needKeys };
  });
  if (input.commission) {
    const ok = input.commission.rate != null;
    items.push({ tab: 'commission', ok, blocking: false, needKeys: ok ? [] : ['poReadyCommissionUnset'] });
  }
  return items;
}

/** The blocking keys, flat — what the checkpoint's footer lists. */
export function readinessBlockerKeys(items: ReadinessItem[]): string[] {
  return items.filter(i => i.blocking).flatMap(i => i.needKeys);
}
