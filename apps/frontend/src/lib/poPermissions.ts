import { isClosedBook, LIFECYCLE_STATUS } from './status';

// What the signed-in user may do on one PO, in one place. The desktop editor
// and the phone detail each derived these from the same facts, line by line,
// and could drift. The backend gates are the authority; these only decide
// what the page offers.
export type PoPermissions = {
  // The order's stage, from the lifecycle rather than the 'Mixed'-prone
  // derived status, so an owner is never locked out of their own draft.
  effectiveStatus: string;
  isArchived: boolean;
  // Locked from Ready to Pay on (the review is over), and while archived.
  orderLocked: boolean;
  canEditOrder: boolean;
  // A purchaser's save past Draft sends the order back to Draft; warn first.
  revertOnSave: boolean;
  isOwnerOrManager: boolean;
  // Notes and evidence outlive the purchaser's edit window.
  canAnnotate: boolean;
  // A manager keeps the stage moves on a closed, unarchived order.
  canReopen: boolean;
  // Only a never-submitted Draft is deleted; a submitted one is archived.
  canDelete: boolean;
};

export function derivePoPermissions(opts: {
  // The real role: edit rights do not follow the role-preview tweak.
  isPurchaser: boolean;
  userId: string | null | undefined;
  order: {
    lifecycle: string; status: string; archivedAt?: string | null;
    userId: string; everSubmitted?: boolean;
  };
}): PoPermissions {
  const { isPurchaser, userId, order } = opts;
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  const isArchived = !!order.archivedAt;
  const orderLocked = isClosedBook(effectiveStatus) || isArchived;
  const canEditOrder = !orderLocked;
  const isOwnerOrManager = !isPurchaser || order.userId === userId;
  return {
    effectiveStatus,
    isArchived,
    orderLocked,
    canEditOrder,
    revertOnSave: isPurchaser && !orderLocked && effectiveStatus !== 'Draft',
    isOwnerOrManager,
    canAnnotate: !orderLocked && isOwnerOrManager,
    canReopen: !isPurchaser && orderLocked && !isArchived,
    canDelete: canEditOrder && effectiveStatus === 'Draft' && !order.everSubmitted,
  };
}

// Whether moving this PO should first ask the mover to take it over: only a
// manager (the real role — a previewing manager still moves as one) moving an
// order someone else manages. An order with no manager is stamped with the
// mover by the server, no question asked.
export function asksManagerTakeover(
  manager: { id: string } | null | undefined,
  me: { id: string; role: string } | null | undefined,
): boolean {
  return !!me && me.role === 'manager' && !!manager && manager.id !== me.id;
}
