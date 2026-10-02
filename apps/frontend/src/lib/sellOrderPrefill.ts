import type { SellableItem } from '../components/AddInventoryPicker';

// Inventory's "Add to sell order" hands its selection to the sell order page
// across a navigation, which unmounts Inventory — so it can't be a prop.
export type SellOrderPrefill = {
  orderId: string;
  items: SellableItem[];
  // Runs once the appended lines are saved; Inventory uses it to drop its
  // selection. Not run on an abandoned visit, so the selection survives that.
  onSaved?: () => void;
};

let pending: SellOrderPrefill | null = null;

export function stashSellOrderPrefill(p: SellOrderPrefill): void {
  pending = p;
}

// Non-destructive: StrictMode runs a useState initializer twice, and a
// consuming read would hand the second run nothing.
export function peekSellOrderPrefill(orderId: string): SellOrderPrefill | null {
  return pending?.orderId === orderId ? pending : null;
}

export function clearSellOrderPrefill(orderId: string): void {
  if (pending?.orderId === orderId) pending = null;
}
