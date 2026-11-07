// The fixed guards of CONTRACTS §6.6. Code, not configuration: no profile can
// change them. Guard 1 is prompt.ts's (it builds requests only from
// non-price fields); guard 2 is lib/fbOffer.ts; guard 7 is re-checked by
// fbThreads.queueOutbound inside its transaction; guard 8 is the loop's.

export const HONEST_LINE = "I'm Recycle Servers' automated assistant. Let me get a person on our team to pick this up.";
export const MAX_REPLY_CHARS = 600;
export const OFFER_PLACEHOLDER = '{{offer}}';

// Guard 3: any money figure the model wrote itself. Over-blocking costs a
// hand-off; under-blocking can quote a price we never computed.
const MONEY: { re: RegExp; what: string }[] = [
  { re: /[$€£¥]/, what: 'a currency sign' },
  { re: /\b(usd|dollars?|bucks|grand|cents?)\b/i, what: 'a money word' },
  { re: /\b\d+(?:[.,]\d+)?\s*k\b/i, what: 'a number with k' },
  { re: /(?<![\w-])\d{1,3}(?:,\d{3})+(?![\w-])|(?<![\w-])\d+\.\d+(?![\w-])|(?<![\w-])\d{3,}(?![\w-])/, what: 'a number that could be a price' },
  { re: /\b(hundred|thousand|million|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i, what: 'a number written in words' },
  // A small bare number read as a price: after a price word, or closing the
  // clause ("how about 95?", "80 for both"). Counts inside a sentence ("are
  // all 8 the same") are not.
  { re: /\b(offer(ing)?|pay(ing)?|budget|price|thinking|how about|around|roughly|say|ask(ing)?)\s+(of\s+|is\s+|maybe\s+|about\s+)?\d{1,2}(?![\w.,]*\d)\b/i, what: 'a number that could be a price' },
  { re: /(?<![\w.,-])\d{1,2}(?=\s*([?!;]|[.,](?!\d)|$|\b(for (both|all|them|the lot|everything)|total|altogether|or so|ish|tops|firm|obo)\b))/i, what: 'a number that could be a price' },
  { re: /\b\d+\s*(each|apiece|a piece|per\s+\w+|\/\s*ea)\b/i, what: 'a unit price' },
];

const OFFER_TRAILER = /\{\{offer\}\}(?:[\w$]|[.,]\d|\s*(?:k|x|each|apiece|a piece|per|\/|ea|times|a (unit|pop|stick|drive|card|piece)|for each|plus|\+|\*|more|extra|on top)\b)/i;

// Guard 4: accepting, confirming, paying, or arranging a handover. A person
// on our team does all of these.
const COMMITMENT: { re: RegExp; what: string }[] = [
  { re: /\b(it'?s a )?deal\b/i, what: 'deal' },
  { re: /\b(accept(ed|ing)?|agreed?|confirm(ed)?|sold)\b/i, what: 'accepts or confirms' },
  { re: /\b(i|we)('ll| will| can| would)\s+(take|buy|pay|send|wire|transfer)\b/i, what: 'a promise to buy or pay' },
  { re: /\b(pay(ment|pal)?|venmo|zelle|cash ?app|wire|invoice)\b/i, what: 'payment' },
  { re: /\b(pick\s?-?up|pick (it|them) up|ship(ping|ped)?|deliver(y|ed)?|freight|courier|fedex|ups|usps|drop[- ]?off)\b/i, what: 'pickup or shipping' },
  { re: /\b(meet( up)?|come by|stop by|address|tomorrow|tonight|this (morning|afternoon|evening|weekend))\b/i, what: 'a meeting' },
];

// Guard 5: it never claims to be a person.
const HUMAN_CLAIM = /\b(i am|i'm|im)\s+(a\s+)?(real\s+)?(person|human|man|woman|guy)\b|\bnot an? (bot|robot|ai|automated)\b|\breal person here\b/i;

/** Single paragraph, single spaces: the worker sends it as one message (guard 6). */
export function normaliseReply(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export type GuardResult = { ok: boolean; failures: string[]; text: string | null };

/**
 * Checks a draft and fills the placeholder. `offerUsd` is fbOffer's number,
 * or null when this reply may carry no offer. The checks read the draft with
 * the placeholder removed, so only code's number can appear in what is sent.
 */
export function checkReply(draft: string, offerUsd: number | null): GuardResult {
  const failures: string[] = [];
  const text = normaliseReply(draft);
  if (!text) failures.push('The reply is empty.');
  const withoutOffer = text.split(OFFER_PLACEHOLDER).join(' ');
  if (/\{\{|\}\}/.test(withoutOffer)) failures.push('The reply has a placeholder other than {{offer}}.');
  const usesOffer = text.includes(OFFER_PLACEHOLDER);
  if (usesOffer && offerUsd === null) failures.push('The reply names an offer, and there is no offer to make.');
  if (text.split(OFFER_PLACEHOLDER).length > 2) failures.push('The reply names the offer more than once.');
  // The filled amount is the whole lot's price. A digit, letter or unit beside
  // the placeholder would turn it into another number: "{{offer}}0" sends ten
  // times the offer, "{{offer}}k" a thousand times, "{{offer}} each" one per item.
  if (/[\w$.,]\{\{offer\}\}/i.test(text) || OFFER_TRAILER.test(text)) failures.push('The reply changes the offer\'s amount around {{offer}}.');
  for (const m of MONEY) if (m.re.test(withoutOffer)) failures.push(`The reply has ${m.what} the model wrote itself.`);
  for (const c of COMMITMENT) if (c.re.test(withoutOffer)) failures.push(`The reply commits us (${c.what}).`);
  if (HUMAN_CLAIM.test(withoutOffer)) failures.push('The reply claims to be a person.');
  const filled = usesOffer && offerUsd !== null ? text.split(OFFER_PLACEHOLDER).join(`$${offerUsd}`) : text;
  if (filled.length > MAX_REPLY_CHARS) failures.push(`The reply is ${filled.length} characters, over ${MAX_REPLY_CHARS}.`);
  return failures.length ? { ok: false, failures, text: null } : { ok: true, failures, text: filled };
}
