// Splits an email body into what the sender wrote and the history their mail
// client quoted under it, so a thread doesn't repeat every earlier message in
// every bubble. The quoted part is kept, only folded away.
//
// Line 0 is never a cut point: a body that *starts* with a marker would fold
// away entirely.

const HEADER_START = /^(From|发件人)\s*[:：]/;
const HEADER_NEXT = /^(Sent|Date|To|Subject|Cc|发送时间|日期|时间|收件人|主题)\s*[:：]/;

function isMarker(lines: string[], i: number): boolean {
  const l = lines[i].trim();
  if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l)) return true;
  if (/^在.+写道[:：]\s*$/.test(l)) return true;
  // Gmail and Apple Mail, which wrap a long "On … <address> wrote:" over two
  // lines.
  if (/^On\s/.test(l)) {
    if (/wrote:\s*$/.test(l)) return true;
    const next = lines[i + 1]?.trim() ?? '';
    if (/wrote:\s*$/.test(next) && !/^On\s/.test(next)) return true;
  }
  // Outlook and Lark start the quoted message with its own header block. A
  // lone "From:" line is just text; a block has Sent/To/Subject under it.
  if (HEADER_START.test(l)) {
    return lines.slice(i + 1, i + 5).some((n) => HEADER_NEXT.test(n.trim()));
  }
  return false;
}

export function splitQuotedReply(text: string): { reply: string; quoted: string } {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (isMarker(lines, i)) {
      return { reply: lines.slice(0, i).join('\n').trimEnd(), quoted: lines.slice(i).join('\n').trim() };
    }
  }
  // Plain-text clients: a trailing run of `>` lines.
  let j = lines.length;
  while (j > 0 && (lines[j - 1].startsWith('>') || lines[j - 1].trim() === '')) j--;
  if (j > 0 && lines.slice(j).some((l) => l.startsWith('>'))) {
    return { reply: lines.slice(0, j).join('\n').trimEnd(), quoted: lines.slice(j).join('\n').trim() };
  }
  return { reply: text, quoted: '' };
}
