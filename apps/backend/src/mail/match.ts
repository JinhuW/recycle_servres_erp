// Which web submission an inbound email belongs to, decided from its headers
// alone so that unrelated company mail in the shared box is never downloaded.
//
// Two ways in, in order of trust:
//   1. thread — In-Reply-To / References names a message already on a thread.
//      Those ids are ours (uuid-based), so this is not guessable.
//   2. subject — the subject carries a WS id AND the sender is that
//      submission's address. WS ids are sequential and From is forgeable, so
//      the page still shows every inbound sender and flags a mismatch.
// Anything else stays in the mailbox only.

export type InboundHeader = {
  uid: number;
  size: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  // Lowercased address, or null when the message has no usable From.
  from: string | null;
  fromName: string | null;
  subject: string;
  // The topmost Authentication-Results header: the receiving server's own.
  authResults: string | null;
};

export type MatchLookups = {
  // Every message id already on a thread → its submission.
  byMessageId: ReadonlyMap<string, string>;
  // Submissions named in the batch's subjects → their lowercased email.
  emailById: ReadonlyMap<string, string>;
  // The box itself: our own sent copies are never inbound replies.
  ownAddress: string;
};

export type Match = { submissionId: string; via: 'thread' | 'subject' };

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

export function subjectSubmissionIds(subject: string): string[] {
  const ids = [...subject.matchAll(/\bWS-(\d{4,})\b/gi)].map((m) => `WS-${m[1]}`);
  return [...new Set(ids)];
}

// `dmarc=pass` / `dmarc=fail` from an Authentication-Results value. Only the
// verdict is kept; the page warns on fail and says nothing on pass, so a
// sender who forges a pass gains nothing over sending none.
export function dmarcVerdict(authResults: string | null): string | null {
  const m = authResults?.match(/\bdmarc=([a-z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function matchSubmission(h: InboundHeader, l: MatchLookups): Match | null {
  if (!h.from || h.from === l.ownAddress) return null;
  for (const id of threadIds(h)) {
    const submissionId = l.byMessageId.get(id);
    if (submissionId) return { submissionId, via: 'thread' };
  }
  for (const id of subjectSubmissionIds(h.subject)) {
    if (l.emailById.get(id) === h.from) return { submissionId: id, via: 'subject' };
  }
  return null;
}
