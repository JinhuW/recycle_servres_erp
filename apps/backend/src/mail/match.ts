// Which web submission an inbound email belongs to, decided from its headers
// alone so that unrelated company mail in the shared box is never downloaded.
//
// One way in: In-Reply-To / References names a message WE sent. Those ids are
// uuid-based and only ever went to the customer, so they can't be guessed. A
// subject naming the WS id is deliberately not enough, whoever it claims to be
// from: WS ids are sequential, From is forgeable, and whether the receiving
// server stamps a DMARC verdict to catch the forgery isn't ours to rely on.
// The page still shows every inbound sender and flags one that isn't the
// submission's address. Anything else stays in the mailbox only, including
// mail whose From names more than one address.

export type InboundHeader = {
  uid: number;
  size: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  // Lowercased address, or null unless From names exactly one.
  from: string | null;
  fromName: string | null;
  subject: string;
  // Every Authentication-Results header, in message order.
  authResults: string[];
};

export type MatchLookups = {
  // Every Message-ID we sent → its submission.
  byMessageId: ReadonlyMap<string, string>;
  // The box itself: our own sent copies are never inbound replies.
  ownAddress: string;
};

export type Match = { submissionId: string };

export function normalizeMessageId(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v.startsWith('<') ? v : `<${v}>`;
}

export function parseReferences(raw: string | null | undefined): string[] {
  return raw?.match(/<[^<>\s]+>/g) ?? [];
}

export function threadIds(h: InboundHeader): string[] {
  const ids = [h.inReplyTo, ...h.references].map(normalizeMessageId);
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

// The DMARC verdict across every Authentication-Results header. A sender can
// add headers of their own but never remove the receiving server's, and
// whether that one lands on top or at the bottom is the server's choice — so
// a fail anywhere wins. A pass is kept but never shown as proof of anything.
export function dmarcVerdict(authResults: readonly string[]): string | null {
  const verdicts = authResults
    .map((v) => v.match(/\bdmarc=([a-z]+)/i)?.[1].toLowerCase())
    .filter((v): v is string => v !== undefined);
  return verdicts.includes('fail') ? 'fail' : verdicts[0] ?? null;
}

export function matchSubmission(h: InboundHeader, l: MatchLookups): Match | null {
  if (!h.from || h.from === l.ownAddress) return null;
  for (const id of threadIds(h)) {
    const submissionId = l.byMessageId.get(id);
    if (submissionId) return { submissionId };
  }
  return null;
}
