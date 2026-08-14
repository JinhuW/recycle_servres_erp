# Reddit's anonymous JSON API is blocked — use the Atom feed

**Discovered:** 2026-08-14, during initial implementation.

## Symptom

Every anonymous request to `https://www.reddit.com/r/<sub>/new.json` returns
**HTTP 403 with an HTML block page**, not JSON. The body starts with `<body
class=theme-beta>`, so a naive `response.json()` throws a confusing parse error
rather than reporting a block.

Verified blocked regardless of:

- User-Agent (descriptive contact UA *and* a full browser UA both 403)
- Host (`www.reddit.com`, `oauth.reddit.com`)
- Path form (`/new.json`, `/new/.json`)
- `old.reddit.com` — 302-redirects to a login page

## What works

The **Atom feed** is still open to anonymous clients:

```
https://www.reddit.com/r/<a>+<b>+<c>/new.rss?limit=100
```

It returns HTTP 200 with up to 100 entries across a multireddit, and each
`<entry>` carries everything the tracker needs:

| Field | Atom source |
| --- | --- |
| dedup key (`t3_…` fullname) | `<id>` |
| subreddit | `<category term="…">` |
| title | `<title>` |
| body text | `<content type="html">` (HTML-escaped, wrapped in Reddit's table markup) |
| author | `<author><name>/u/…</name>` |
| permalink | `<link href="…">` |
| posted at | `<published>` |

**Not available in Atom:** `link_flair_text`. Posts are stored with
`flair = NULL`. This costs little — the sale/want markers that matter on
r/hardwareswap and r/homelabsales live in the title (`[FS]`, `[USA-NY] [H] … [W] …`),
which the evaluation prompt already reads.

## The real rate limit is far tighter than 10 req/min

Response headers on a successful feed request:

```
x-ratelimit-used: 1
x-ratelimit-remaining: 0.0
x-ratelimit-reset: 40
```

One request exhausts the bucket, refilling in ~40 s — roughly **1.5 requests
per minute per IP**, not the ~10/min that older documentation describes.
Bursting past it returns HTTP 429 with an empty body.

Consequences baked into the implementation:

- `REDDIT_MAX_RPM` defaults to **1**, not 6.
- `reddit.ts` reads `x-ratelimit-remaining` / `x-ratelimit-reset` on every
  response and feeds them to the pacer, so the server's own accounting drives
  our pacing instead of a guess.
- One request covers *all* watched subreddits via the `a+b+c` multireddit path,
  which is why the poll loop claims subreddits in a batch. Do not "simplify"
  this into one request per subreddit — that is a 4× rate-limit multiplier for
  no benefit.

## Do not do these

- Do not switch back to `.json` endpoints without re-probing; if they ever
  reopen, the parser must still treat a `<`-prefixed body as a block.
- Do not treat a 403 as fatal. It is the same transient-block path as 429 and
  must go through the pacer's backoff.
- Do not raise `REDDIT_MAX_RPM` to "go faster". The fleet scales by adding VMs
  (each has its own IP and its own bucket), not by pushing one IP harder.
