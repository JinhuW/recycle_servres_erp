// An eBay listing as the operator pastes it: the link from the browser or the
// app (ebay.com, www., m.; with or without a title slug and a query), or the
// bare item number. Both sides read it the same way, so the desk can tell
// before saving whether the server will take it.

export type EbayListingRef =
  | { itemId: string; url: string }
  | { error: 'empty' | 'not_ebay' | 'no_item' };

const ITEM_ID = /^\d{6,20}$/;
const EBAY_LINK = /^(?:https?:\/\/)?(?:(?:www|m)\.)?ebay\.com(?::\d+)?(\/[^?#]*)?(?:[?#].*)?$/i;

/** The one URL stored for an item, whatever form it was pasted in. */
export function ebayItemUrl(itemId: string): string {
  return `https://www.ebay.com/itm/${itemId}`;
}

export function parseEbayListingRef(raw: string): EbayListingRef {
  const s = raw.trim();
  if (s === '') return { error: 'empty' };
  if (ITEM_ID.test(s)) return { itemId: s, url: ebayItemUrl(s) };
  const m = EBAY_LINK.exec(s);
  if (!m) return { error: 'not_ebay' };
  // /itm/<id> or /itm/<title-slug>/<id>
  const parts = (m[1] ?? '').split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'itm' || parts.length < 2 || parts.length > 3) return { error: 'no_item' };
  const id = parts[parts.length - 1];
  return ITEM_ID.test(id) ? { itemId: id, url: ebayItemUrl(id) } : { error: 'no_item' };
}
