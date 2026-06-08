// Server-side mirror of the desktop inventory label helpers
// (itemLabel / itemSpec in apps/frontend/src/pages/desktop/DesktopInventory.tsx).
// order_lines has no label column — the display string is composed from the
// attribute columns. The search_sellable_inventory MCP tool and
// createSellOrderDraft both derive the snapshot label here, so what the agent
// sees is exactly what gets stored on the sell_order_line.

export type InventoryAttrs = {
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  condition: string | null;
  health: number | null;
  rpm: number | null;
};

export function inventoryLabel(r: InventoryAttrs): string {
  switch (r.category) {
    case 'RAM': return `${r.brand ?? ''} ${r.capacity ?? ''} ${r.generation ?? ''}`.trim();
    case 'SSD': return `${r.brand ?? ''} ${r.capacity ?? ''}`.trim();
    case 'HDD': return `${r.brand ?? ''} ${r.capacity ?? ''}`.trim();
    default:    return r.description ?? '';
  }
}

export function inventorySpec(r: InventoryAttrs): string | null {
  let parts: Array<string | number | false | null | undefined>;
  switch (r.category) {
    case 'RAM': parts = [r.classification, r.rank, r.speed && `${r.speed}MHz`]; break;
    case 'SSD': parts = [r.interface, r.form_factor, r.health != null && `${r.health}%`]; break;
    case 'HDD': parts = [r.interface, r.form_factor, r.rpm && `${r.rpm}rpm`, r.health != null && `${r.health}%`]; break;
    default:    return r.condition ?? null;
  }
  const spec = parts.filter(Boolean).join(' · ');
  return spec || null;
}
