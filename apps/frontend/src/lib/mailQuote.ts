// Splits an email body into what the sender wrote and the history their mail
// client quoted under it, so a thread doesn't repeat every earlier message in
// every bubble. The quoted part is kept, only folded away.
//
// Line 0 is never a cut point: a body that *starts* with a marker would fold
// away entirely.

const HEADER_START = /^(From|发件人)\s*[:：]/;
const HEADER_NEXT = /^(Sent|Date|To|Subject|Cc|发送时间|日期|时间|收件人|主题)\s*[:：]/;

type Marker = 'block' | 'attribution';

// `attribution` is a "… wrote:" line heading a `>`-quoted block, and how many
// lines it spans; `block` quotes what follows unprefixed.
function markerAt(lines: string[], i: number): { kind: Marker; span: number } | null {
  const l = lines[i].trim();
  if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l)) return { kind: 'block', span: 1 };
  if (/^在.+写道[:：]\s*$/.test(l)) return { kind: 'attribution', span: 1 };
  // Gmail and Apple Mail, which wrap a long "On … <address> wrote:" over two
  // lines.
  if (/^On\s/.test(l)) {
    if (/wrote:\s*$/.test(l)) return { kind: 'attribution', span: 1 };
    const next = lines[i + 1]?.trim() ?? '';
    if (/wrote:\s*$/.test(next) && !/^On\s/.test(next)) return { kind: 'attribution', span: 2 };
  }
  // Outlook and Lark start the quoted message with its own header block. A
  // "From:" with a To: somewhere under it is just as likely a pickup address,
  // so the block has to be at least two header lines straight under it.
  if (HEADER_START.test(l) && HEADER_NEXT.test(lines[i + 1]?.trim() ?? '') && HEADER_NEXT.test(lines[i + 2]?.trim() ?? '')) {
    return { kind: 'block', span: 1 };
  }
  return null;
}

export function splitQuotedReply(text: string): { reply: string; quoted: string } {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = markerAt(lines, i);
    if (!m) continue;
    // Answers written between the quoted lines are the sender's own, and
    // folding them hides a price or a new address behind the toggle.
    if (m.kind === 'attribution' && lines.slice(i + m.span).some((l) => l.trim() !== '' && !l.startsWith('>'))) continue;
    return { reply: lines.slice(0, i).join('\n').trimEnd(), quoted: lines.slice(i).join('\n').trim() };
  }
  // Plain-text clients: a trailing run of `>` lines.
  let j = lines.length;
  while (j > 0 && (lines[j - 1].startsWith('>') || lines[j - 1].trim() === '')) j--;
  if (j > 0 && lines.slice(j).some((l) => l.startsWith('>'))) {
    return { reply: lines.slice(0, j).join('\n').trimEnd(), quoted: lines.slice(j).join('\n').trim() };
  }
  return { reply: text, quoted: '' };
}

// What a folded message shows on its one line: what the sender wrote, not the
// history quoted under it, with line breaks flattened. CSS ellipsises it; an
// empty result means the message had no text the thread can show.
export function mailSnippet(body: string): string {
  return splitQuotedReply(body).reply.replace(/\s+/g, ' ').trim();
}

// A mail client's date column: the time for today, the day for this year, and
// the full date for anything older.
export function mailDate(date: Date | string, now: Date, locale: string): string {
  const d = new Date(date);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
