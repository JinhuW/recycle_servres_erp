// RFC 5321 caps an address at 254. The cap runs before the regex, and the
// domain's labels exclude the dot, so the match is linear: the old
// `[^@\s]+\.[^@\s]+$` backtracked quadratically on 'a@' + '.'.repeat(n) + '@'.
export const EMAIL_MAX = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmail(s: string): boolean {
  return s.length <= EMAIL_MAX && EMAIL_RE.test(s);
}
