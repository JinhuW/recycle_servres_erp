import type { IconName } from '../components/Icon';
import type { DesktopViewId } from './route';
import type { Role } from './types';

export interface NavLeaf {
  id: DesktopViewId;
  tKey: string;
  icon: IconName;
  roles: readonly Role[];
  badge?: string;
  // Views reached through this entry's own tabs; they keep it lit.
  alsoActiveOn?: readonly DesktopViewId[];
}

// A second level: the children show only while one of them is the page, and
// the parent itself links to its first child the viewer can see.
export interface NavParent {
  tKey: string;
  icon: IconName;
  children: readonly NavLeaf[];
}

export interface NavGroup {
  tKey: string;
  items: readonly (NavLeaf | NavParent)[];
}

// Two groups: where you do the work, and where you check it. Activity and
// Settings are the latter — neither is a place a purchase gets made.
export const DESKTOP_NAV: readonly NavGroup[] = [
  {
    tKey: 'workspace',
    items: [
      { id: 'dashboard',  tKey: 'nav_dashboard',  icon: 'dashboard',  roles: ['manager', 'purchaser'] },
      { id: 'submit',     tKey: 'nav_submit',     icon: 'submit',     roles: ['manager', 'purchaser'], badge: '+' },
      { id: 'history',    tKey: 'nav_history',    icon: 'history',    roles: ['manager', 'purchaser'] },
      // Shipping is unlisted for now: tracking numbers are handed off from the
      // PO itself (the In Transit dialog). The routes still resolve by URL.
      { id: 'clients',    tKey: 'nav_clients',    icon: 'book',       roles: ['manager', 'purchaser'] },
      { id: 'market',     tKey: 'nav_market',     icon: 'tag',        roles: ['manager', 'purchaser'] },
      { id: 'inventory',  tKey: 'nav_inventory',  icon: 'inventory',  roles: ['manager'], alsoActiveOn: ['analysis'] },
      { id: 'sellorders', tKey: 'nav_sellorders', icon: 'tag',        roles: ['manager'] },
      { id: 'transfers',  tKey: 'nav_transfers',  icon: 'truck',      roles: ['manager'] },
      { id: 'websubmissions', tKey: 'nav_websubmissions', icon: 'mail', roles: ['manager'] },
    ],
  },
  {
    tKey: 'nav_group_oversight',
    items: [
      { id: 'activity',   tKey: 'nav_activity',   icon: 'clock',      roles: ['manager'] },
      { id: 'payments',   tKey: 'nav_payments',   icon: 'dollar',     roles: ['manager'], alsoActiveOn: ['internaltx'] },
      {
        tKey: 'nav_monitors',
        icon: 'eye',
        children: [
          { id: 'coordinator', tKey: 'nav_coordinator', icon: 'shield', roles: ['manager'] },
          { id: 'accountPool', tKey: 'nav_accountPool', icon: 'lock',   roles: ['manager'] },
          { id: 'tracker',     tKey: 'nav_tracker',     icon: 'globe',  roles: ['manager'] },
        ],
      },
      // Purchasers get Settings too (Account + Connectors — the MCP connect
      // page); the admin sections are filtered inside DesktopSettings.
      { id: 'settings',   tKey: 'nav_settings',   icon: 'settings',   roles: ['manager', 'purchaser'] },
    ],
  },
];

export interface ShownLeaf {
  kind: 'leaf';
  leaf: NavLeaf;
  active: boolean;
}

export interface ShownParent {
  kind: 'parent';
  parent: NavParent;
  target: DesktopViewId;
  open: boolean;
  children: ShownLeaf[];
}

export interface ShownGroup {
  tKey: string;
  items: (ShownLeaf | ShownParent)[];
}

function showLeaves(leaves: readonly NavLeaf[], role: Role, view: DesktopViewId): ShownLeaf[] {
  return leaves
    .filter(l => l.roles.includes(role))
    .map(l => ({ kind: 'leaf', leaf: l, active: l.id === view || !!l.alsoActiveOn?.includes(view) }));
}

/** The sidebar as one role sees it on one view. */
export function shownNav(role: Role, view: DesktopViewId): ShownGroup[] {
  const groups: ShownGroup[] = [];
  for (const g of DESKTOP_NAV) {
    const items: (ShownLeaf | ShownParent)[] = [];
    for (const item of g.items) {
      if (!('children' in item)) {
        items.push(...showLeaves([item], role, view));
        continue;
      }
      const children = showLeaves(item.children, role, view);
      if (!children.length) continue;
      items.push({
        kind: 'parent',
        parent: item,
        target: children[0].leaf.id,
        open: children.some(c => c.active),
        children,
      });
    }
    if (items.length) groups.push({ tKey: g.tKey, items });
  }
  return groups;
}
