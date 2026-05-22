export type CatalogItem = {
  id: string; category: string; brand?: string | null; capacity?: string | null;
  generation?: string | null; type?: string | null; classification?: string | null;
  rank?: string | null; speed?: string | null; interface?: string | null;
  form_factor?: string | null; description?: string | null;
  part_number?: string | null; condition?: string | null; qty: number;
  scan_image_url?: string | null;
};

// Stub scans emit `data:image/placeholder…` URLs; treat those as "no preview".
export function previewUrl(it: CatalogItem): string | null {
  const u = it.scan_image_url;
  return u && !u.startsWith('data:image/placeholder') ? u : null;
}

export type BasketLine = {
  inventoryId: string; label: string; category: string;
  qty: number; unitPrice: number; available: number;
};

const VENDOR_PATH = /^\/v\/([^/]+)/;

export function vendorTokenFromPath(pathname: string): string | null {
  const m = VENDOR_PATH.exec(pathname);
  return m && m[1] ? m[1] : null;
}

export function itemLabel(it: CatalogItem): string {
  return [it.brand, it.capacity, it.type].filter(Boolean).join(' ') || it.category;
}

export function basketTotal(lines: BasketLine[]): number {
  return +lines.reduce((a, l) => a + l.qty * l.unitPrice, 0).toFixed(2);
}
