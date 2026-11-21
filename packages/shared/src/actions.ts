// Actions: the shared kanban board of action items. Any employee can create a
// card and assign it to any active employee; a card may point at one ERP
// record. Shared by the /api/actions routes and the Actions pages.

export const ACTION_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_PRIORITIES = ['low', 'normal', 'high'] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

/**
 * What a card can point at: purchase order, sell order, after-sales case,
 * client (the `suppliers` table), web submission, inventory lot (an
 * `order_lines` row).
 */
export const ACTION_LINK_TYPES = ['po', 'so', 'as', 'client', 'ws', 'lot'] as const;
export type ActionLinkType = (typeof ACTION_LINK_TYPES)[number];

/** Link types a purchaser may open, and so may link a card to. */
export const ACTION_PURCHASER_LINK_TYPES: readonly ActionLinkType[] = ['po', 'client'];

/** A Done card stays on the board this many days, then only the archive has it. */
export const ACTION_DONE_VISIBLE_DAYS = 14;
export const ACTION_TITLE_MAX = 200;
export const ACTION_TEXT_MAX = 4000;

export type ActionEventKind = 'created' | 'edited' | 'moved' | 'assigned' | 'note' | 'removed';

export function isActionStatus(v: unknown): v is ActionStatus {
  return typeof v === 'string' && (ACTION_STATUSES as readonly string[]).includes(v);
}
export function isActionPriority(v: unknown): v is ActionPriority {
  return typeof v === 'string' && (ACTION_PRIORITIES as readonly string[]).includes(v);
}
export function isActionLinkType(v: unknown): v is ActionLinkType {
  return typeof v === 'string' && (ACTION_LINK_TYPES as readonly string[]).includes(v);
}

/** The link types this role can pick in the record picker. */
export function actionLinkTypesFor(role: 'manager' | 'purchaser'): readonly ActionLinkType[] {
  return role === 'manager' ? ACTION_LINK_TYPES : ACTION_PURCHASER_LINK_TYPES;
}

/**
 * The record a card points at, as the caller may see it.
 *
 * `label` is always present: the record's number (PO-1289, SO-77, AS-1003,
 * WS-1012), `PO-1289 #3` for a lot, and the fixed word `Client` for a client,
 * whose name is private to its owner. `name` (a client's name, a lot's part)
 * and `status` are sent only when `canOpen`; otherwise the keys are absent.
 * `deleted` means the record is gone and only the label is left.
 */
export interface ActionLink {
  type: ActionLinkType;
  id: string | null;
  label: string;
  name?: string;
  status?: string;
  canOpen: boolean;
  deleted: boolean;
}

export interface ActionPerson {
  id: string;
  name: string;
}

export interface ActionItem {
  id: string;
  title: string;
  description: string | null;
  status: ActionStatus;
  position: number;
  priority: ActionPriority;
  /** yyyy-mm-dd, the business day it is due. */
  dueDate: string | null;
  assignee: ActionPerson | null;
  createdBy: ActionPerson | null;
  link: ActionLink | null;
  noteCount: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller may remove it: its creator or a manager. */
  canRemove: boolean;
}

export interface ActionEvent {
  id: string;
  kind: ActionEventKind;
  note: string | null;
  detail: Record<string, unknown>;
  actor: ActionPerson | null;
  createdAt: string;
}

/** A record the picker found: enough to show and link, no money. */
export interface ActionLinkTarget {
  type: ActionLinkType;
  id: string;
  label: string;
  name?: string;
  status: string;
}

/** Column order after a move: card ids top to bottom, per column touched. */
export type ActionColumnOrder = Partial<Record<ActionStatus, string[]>>;

/** Overdue = not done and due before `today` (yyyy-mm-dd, business day). */
export function actionIsOverdue(
  item: Pick<ActionItem, 'status' | 'dueDate'>, today: string,
): boolean {
  return item.status !== 'done' && item.dueDate !== null && item.dueDate < today;
}
