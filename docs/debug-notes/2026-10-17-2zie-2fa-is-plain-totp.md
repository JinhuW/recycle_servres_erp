# client.2zie.com/2fa is plain TOTP: the account pool already generates the same codes

**Question.** Account sellers point buyers at <https://client.2zie.com/2fa> to
turn a Facebook "2FA key" into the six-digit login code. Does the site do
anything we would have to call out to, or copy, before the ERP's Facebook
account pool can show those codes itself?

**Answer.** No. The page is RFC 6238 TOTP computed in the browser, and both the
ERP frontend and the Facebook tracker already implement it. Nothing was built;
this note exists so nobody re-derives it or adds a dependency on the site.

## What the page does

Read from the deployed bundle (`/assets/index-cQf7ES19.js` and the route chunk
`/assets/2FA-40XtFYKb.js`, last modified 2026-09-02):

- A Vue SPA. The `/2fa` route renders a `Get2FA` component; `/2fa/:code`
  pre-fills the key from the URL.
- The route chunk makes **no network request**: zero `fetch`, `axios` or XHR
  uses. The `https://2zie.com/api` base URL in the main bundle serves the
  site's own login and file-sharing pages only.
- Code generation, verbatim in structure:
  1. strip all whitespace from the pasted key;
  2. base32-decode it with the `thirty-two` npm package (alphabet `A-Z2-7`,
     case-insensitive, stops at `=`);
  3. counter = `floor(unix_seconds / 30)`, written as 8 big-endian bytes;
  4. crypto-js `HmacSHA1(key = decoded secret, message = counter)`;
  5. dynamic truncation: offset = low nibble of the last digest byte, take four
     bytes there, mask `0x7FFFFFFF`, modulo 1 000 000, pad to six digits;
  6. recompute every second, countdown `30 - t % 30`.
- "Saved keys" are a `localStorage` list (`2fa_saved_secrets`) in that browser
  only. The input placeholder is the space-grouped 32-character base32 key
  Facebook shows under *Two-factor → Authentication app → Set up another way*,
  which is also the format sellers hand out.

## Verification

A Python stdlib reimplementation (`base64.b32decode`, `hmac`, `hashlib.sha1`,
8-byte big-endian counter) reproduces the RFC 6238 SHA-1 test vector `287082`
at T=59, and gives the same live code the page shows for the same key. Any
standard TOTP library (pyotp, WebCrypto HMAC-SHA1) is interchangeable with it.
The pool's own generator is pinned to that vector:
`apps/frontend/src/lib/facebookPool.test.ts` asserts `poolTotp` returns
`287082` at T=59, so the pool and the site are verified equivalent, not just
similar.

## Where the same algorithm already lives here

- ERP account pool: `apps/frontend/src/lib/facebookPool.ts` (`base32Bytes`,
  `poolTotp`) and `apps/frontend/src/pages/desktop/accountPool/shared.tsx`
  (`PoolCode`, the live code with countdown ring). The pool's decoder is more
  lenient than the site's: it also drops `=` and `-` and upper-cases.
- Tracker, operator side: `trackers/facebook/rs_poster/rs_poster/totp.py`
  (`rs-session totp`, auto-fill during capture).
- Tracker, coordinator vault: `trackers/facebook/rs_coordinator/rs_coordinator/totp_code.py`
  (`generate_for`, moves to the next window when 3 s or less remain) and
  `totp.py` (`normalize_totp_secret`, `rsc vault show-code`), released to
  workers through `POST /v1/auth/code` with a `code_audit` row.

## Rules this confirms

- No dependency on 2zie or any web authenticator; codes are computed locally.
- The pool keeps its "never persist login secrets in the browser" rule. The
  site's `localStorage` key list is not a pattern to copy.
