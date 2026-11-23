// What the desk does on eBay through the Inventory API: publish a Queued
// listing, revise a live one's price, and withdraw one being ended. Each runs
// inside the desk's transaction, after the listing's row lock, so eBay and the
// ERP change together or not at all: an eBay refusal throws and rolls the
// ERP's side back.
//
// Quantity is not pushed after a sale is confirmed. eBay lowers an item's
// available quantity itself at checkout, while the ERP's remainder only drops
// when the operator confirms the sale, so pushing the remainder while a sale
// still waits would put sold units back on sale. A split only applies to
// Queued listings, which are not on eBay yet.

import type postgres from 'postgres';
import type { SqlLike } from '../db';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../lib/inventoryLabel';
import { ebayRemainingSql } from '../lib/sellCommitment';
import { markListedTx } from '../services/ebayListings';
import { EbayApiError, type EbayInventoryItem, type EbayOfferUpdate } from './client';
import { allowSlowEbayTx, EbayNotReady, missingDefaults, type EbayContext } from './connection';

const TITLE_MAX = 80;
const MAX_IMAGES = 24;

// eBay US leaf categories for what the ERP sells. A lot outside these (Other)
// can't be published until it has one; the operator links it by hand.
const CATEGORY_IDS: Record<string, string> = {
  RAM: '170083',   // Computer Components & Parts > Memory (RAM)
  SSD: '175669',   // Computer Components & Parts > Drives, Storage & Blank Media > Solid State Drives
  HDD: '56083',    // Drives, Storage & Blank Media > Hard Drives (HDD, SSD & NAS)
  CPU: '164',      // Computer Components & Parts > CPUs/Processors
  GPU: '27386',    // Computer Components & Parts > Graphics/Video Cards
};

/** The free-text condition the ERP keeps, as eBay's ConditionEnum. */
export function ebayCondition(text: string | null): string {
  const t = (text ?? '').toLowerCase();
  if (/parts|not work|broken|as[- ]?is|defect|faulty/.test(t)) return 'FOR_PARTS_OR_NOT_WORKING';
  if (/refurb/.test(t)) return 'SELLER_REFURBISHED';
  if (/open box|new other|new \(other\)|new pull|pulled new/.test(t)) return 'NEW_OTHER';
  if (/^\s*(brand )?new\b|sealed/.test(t)) return 'NEW';
  return 'USED_EXCELLENT';
}

export type PublishListing = {
  id: string; ebay_sku: string; status: string; remaining: number; list_price: number;
  title: string | null; spec: string | null; condition: string | null;
  ebay_offer_id: string | null; ebay_item_id: string | null; inventory_id: string | null;
};

export type PublishLot = InventoryAttrs & { part_number: string | null };

export type PublishPhoto = { url: string; mime: string | null; source: 'scan' | 'upload' };

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function listingTitle(l: PublishListing, lot: PublishLot): string {
  const fallback = [inventoryLabel(lot), l.spec ?? inventorySpec(lot)].filter(Boolean).join(' ');
  return (l.title?.trim() || fallback).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** Uploaded photos as eBay should fetch them: https and an image. The label scan only when there is nothing else. */
export function listingImages(photos: PublishPhoto[]): string[] {
  const ok = (p: PublishPhoto) => /^https:\/\//.test(p.url) && (p.mime === null || p.mime.startsWith('image/'));
  const uploads = photos.filter((p) => p.source === 'upload' && ok(p));
  const pick = uploads.length ? uploads : photos.filter((p) => p.source === 'scan' && ok(p));
  return pick.slice(0, MAX_IMAGES).map((p) => p.url);
}

function aspects(lot: PublishLot): Record<string, string[]> {
  const a: Record<string, string | number | null | undefined> = { Brand: lot.brand, MPN: lot.part_number };
  switch (lot.category) {
    case 'RAM':
      Object.assign(a, {
        'Capacity per Module': lot.capacity, Type: lot.generation,
        'Bus Speed': lot.speed && `${lot.speed} MHz`, 'Form Factor': lot.classification,
      });
      break;
    case 'SSD':
    case 'HDD':
      Object.assign(a, {
        'Storage Capacity': lot.capacity, Interface: lot.interface, 'Form Factor': lot.form_factor,
        ...(lot.category === 'HDD' && lot.rpm ? { 'Rotation Speed': `${lot.rpm} RPM` } : {}),
      });
      break;
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v !== null && v !== undefined && String(v).trim()) out[k] = [String(v).trim()];
  }
  return out;
}

function description(l: PublishListing, lot: PublishLot, title: string): string {
  const rows = [
    title,
    (l.spec ?? inventorySpec(lot)) && `Spec: ${l.spec ?? inventorySpec(lot)}`,
    lot.part_number && `Part number: ${lot.part_number}`,
    (l.condition ?? lot.condition) && `Condition: ${l.condition ?? lot.condition}`,
    lot.health != null && `Health: ${lot.health}%`,
  ].filter((r): r is string => Boolean(r));
  return rows.map((r) => `<p>${escapeHtml(r)}</p>`).join('');
}

/** The inventory item and offer a listing is published as. A string is why it can't be. */
export function buildPublishPayload(
  l: PublishListing, lot: PublishLot, photos: PublishPhoto[],
  defaults: { merchantLocationKey: string; fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string },
): { item: EbayInventoryItem; offer: EbayOfferUpdate } | string {
  const categoryId = CATEGORY_IDS[lot.category];
  if (!categoryId) return `the ERP has no eBay category for ${lot.category} lots — post it on eBay by hand and link the item #`;
  const title = listingTitle(l, lot);
  if (!title) return 'give the listing a title first';
  const conditionText = l.condition ?? lot.condition;
  const condition = ebayCondition(conditionText);
  const desc = description(l, lot, title);
  const item: EbayInventoryItem = {
    availability: { shipToLocationAvailability: { quantity: l.remaining } },
    condition,
    // eBay refuses a condition description on new items.
    ...(condition !== 'NEW' && conditionText ? { conditionDescription: conditionText.slice(0, 1000) } : {}),
    product: {
      title,
      description: desc,
      aspects: aspects(lot),
      imageUrls: listingImages(photos),
      ...(lot.brand ? { brand: lot.brand } : {}),
      ...(lot.part_number ? { mpn: lot.part_number } : {}),
    },
  };
  const offer: EbayOfferUpdate = {
    availableQuantity: l.remaining,
    categoryId,
    listingDescription: desc,
    listingPolicies: {
      fulfillmentPolicyId: defaults.fulfillmentPolicyId,
      paymentPolicyId: defaults.paymentPolicyId,
      returnPolicyId: defaults.returnPolicyId,
    },
    merchantLocationKey: defaults.merchantLocationKey,
    pricingSummary: { price: { value: l.list_price.toFixed(2), currency: 'USD' } },
  };
  return { item, offer };
}

export const ebayItemUrl = (ctx: Pick<EbayContext, 'cfg'>, itemId: string) =>
  ctx.cfg.environment === 'sandbox' ? `https://sandbox.ebay.com/itm/${itemId}` : `https://www.ebay.com/itm/${itemId}`;

/** A refusal before anything reached eBay: the listing isn't in a state to publish. */
export class PublishRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'PublishRefusal';
  }
}

export type PublishOutcome = { offerId: string; itemId: string; url: string; reusedOffer: boolean };

/**
 * Publishes a Queued listing and marks it Listed. Safe to retry after any
 * partial failure: the inventory item is a PUT, an offer already made for the
 * SKU is reused (revised first, since the price may have moved), and one
 * already published is only recorded.
 */
export async function publishListingTx(
  tx: postgres.TransactionSql, ctx: EbayContext, listingId: string, actorId: string,
): Promise<PublishOutcome> {
  const [l] = await tx<PublishListing[]>`
    SELECT el.id, el.ebay_sku, el.status, ${ebayRemainingSql(tx, tx`el`)} AS remaining,
           el.list_price::float AS list_price, el.title, el.spec, el.condition,
           el.ebay_offer_id, el.ebay_item_id, el.inventory_id
    FROM ebay_listings el WHERE el.id = ${listingId} FOR UPDATE
  `;
  if (!l) throw new PublishRefusal(404, 'Not found');
  if (l.status !== 'Queued') throw new PublishRefusal(409, `only a listing still to post can be published — this one is ${l.status}`);
  if (!l.inventory_id) throw new PublishRefusal(409, 'the inventory lot behind this listing is gone');
  if (l.remaining < 1) throw new PublishRefusal(409, 'nothing is left on this listing to offer');
  const missing = missingDefaults(ctx.conn);
  if (missing.length) {
    throw new EbayNotReady(409, `the eBay account has no default for: ${missing.join(', ')} — set one on eBay, then reconnect in Settings ▸ eBay`);
  }

  const [lot] = await tx<PublishLot[]>`
    SELECT category, brand, capacity, generation, type, classification, rank, speed, interface, form_factor,
           description, condition, health::float AS health, rpm, part_number
    FROM order_lines WHERE id = ${l.inventory_id}
  `;
  const photos = await tx<PublishPhoto[]>`
    SELECT url, mime, source FROM (
      SELECT p.delivery_url AS url, p.mime_type AS mime, 'upload' AS source, p.position, p.uploaded_at
      FROM order_line_photos p WHERE p.order_line_id = ${l.inventory_id}
      UNION ALL
      SELECT ls.delivery_url, NULL, 'scan', -1, ls.created_at
      FROM order_lines ol JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
      WHERE ol.id = ${l.inventory_id}
    ) x ORDER BY position, uploaded_at
  `;
  const payload = buildPublishPayload(l, lot, photos, {
    merchantLocationKey: ctx.conn.merchant_location_key!,
    fulfillmentPolicyId: ctx.conn.fulfillment_policy_id!,
    paymentPolicyId: ctx.conn.payment_policy_id!,
    returnPolicyId: ctx.conn.return_policy_id!,
  });
  if (typeof payload === 'string') throw new PublishRefusal(400, payload);

  await allowSlowEbayTx(tx);
  const { client } = ctx;
  await client.createOrReplaceInventoryItem(l.ebay_sku, payload.item);
  const existing = (await client.getOffers(l.ebay_sku))[0];
  let offerId: string;
  let itemId: string;
  if (existing?.status === 'PUBLISHED' && existing.listing?.listingId) {
    offerId = existing.offerId;
    itemId = existing.listing.listingId;
  } else {
    if (existing) {
      offerId = existing.offerId;
      await client.updateOffer(offerId, payload.offer);
    } else {
      offerId = (await client.createOffer({ sku: l.ebay_sku, ...payload.offer })).offerId;
    }
    itemId = (await client.publishOffer(offerId)).listingId;
  }

  const [taken] = await tx<{ id: string }[]>`
    SELECT id FROM ebay_listings WHERE ebay_item_id = ${itemId} AND id <> ${listingId} LIMIT 1
  `;
  if (taken) throw new PublishRefusal(409, `eBay item ${itemId} is already linked to ${taken.id}`);
  const url = ebayItemUrl(ctx, itemId);
  await markListedTx(tx, listingId, actorId, { itemId, url, offerId });
  return { offerId, itemId, url, reusedOffer: Boolean(existing) };
}

/** A Listed listing's new price, revised on eBay before the ERP saves it. */
export async function revisePriceTx(
  tx: SqlLike, ctx: EbayContext, l: { ebay_sku: string; ebay_offer_id: string }, price: number,
): Promise<void> {
  await allowSlowEbayTx(tx);
  await ctx.client.updatePriceQuantity(l.ebay_sku, l.ebay_offer_id, { price });
}

/**
 * Ends the eBay listing behind an offer before the ERP ends its own. A
 * withdraw eBay refuses only stops the end when the item is still live: one
 * that already ended on eBay (by hand, or by a withdraw whose ERP side failed)
 * has nothing left to take down.
 */
export async function withdrawTx(
  tx: SqlLike, ctx: EbayContext, l: { ebay_sku: string; ebay_offer_id: string },
): Promise<{ alreadyEnded: boolean }> {
  await allowSlowEbayTx(tx);
  try {
    await ctx.client.withdrawOffer(l.ebay_offer_id);
    return { alreadyEnded: false };
  } catch (e) {
    if (!(e instanceof EbayApiError)) throw e;
    const offer = (await ctx.client.getOffers(l.ebay_sku)).find((o) => o.offerId === l.ebay_offer_id);
    const live = offer?.status === 'PUBLISHED' && offer.listing?.listingStatus !== 'ENDED';
    if (live) throw e;
    return { alreadyEnded: true };
  }
}
