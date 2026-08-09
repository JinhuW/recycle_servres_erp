# The connector cleanup button counted rows it then refused to remove

Settings → Connectors offers "Clean up N unused". In prod it said 2, asked for
confirmation, and removed nothing — every time, since June.

Two predicates were meant to describe the same set and did not:

| where | predicate |
| --- | --- |
| the list's `lastUsedAt` (`GET /api/oauth/clients`) | `MAX(created_at)` over refresh tokens **`WHERE revoked_at IS NULL`** |
| the sweep (`DELETE /api/oauth/clients/unused`) | `NOT EXISTS (any refresh token row **at all**)` |

A connector that signed in and later had its token family revoked — reuse
detection, an offboarding, a manual revoke — has rows in
`oauth_refresh_tokens` but none live. The list read that as "Never" used and
counted it; the sweep read the rows as proof of use and spared it. The button
promised 2 and the endpoint honestly returned `revoked: 0`.

Prod, at the time:

```
name                                   rt_all  rt_live
Hermes Agent                              334        0   ← "Never", never swept
Claude Code (recycleservers-inventory)      4        0   ← "Never", never swept
Claude                                     37        1
ChatGPT                                    17        2
```

334 tokens is not an unused connector. **Rotation revokes the token it
replaces** (`rotateRefreshToken` sets `revoked_at` on the old row inside the
same transaction as the insert), so revoked rows are the normal residue of a
healthy connector, not a sign of trouble. Filtering them out of a "last used"
aggregate only changes the answer for a connector whose *whole* family is
dead — exactly the case that then reads as "never signed in at all".

## The shape of the trap

Both queries look right in isolation, and every test passed: the fixtures
either had a live token or had none, never only-revoked ones. The bug lives
in the *disagreement*, so it is invisible to any test that exercises one
endpoint at a time.

Anything the UI counts and an endpoint acts on has to key off the same field.
The list now returns `hasLiveGrant` and the button filters on that, so the two
cannot drift apart again without a type error.

## The other half: client_credentials had no refresh token to show

The old sweep would also have revoked a perfectly healthy service client.
`client_credentials` mints access tokens only — it never inserts into
`oauth_refresh_tokens` — so a scraper client qualified as "never used" one
hour after it was minted. Nothing had been swept because prod had no service
client yet. The sweep now exempts `client_credentials` clients explicitly.

If you ever add a grant that doesn't leave a refresh-token row, it needs the
same exemption, or the cleanup button will quietly delete it.

## Checking a sweep before you ship it

The predicate is one SELECT. Run it against the real data first — it should
name exactly the rows the button offers to take:

```sql
SELECT c.id, c.name FROM oauth_clients c
WHERE c.revoked_at IS NULL
  AND c.created_at < NOW() - INTERVAL '1 hour'
  AND NOT ('client_credentials' = ANY(c.grant_types))
  AND NOT EXISTS (
    SELECT 1 FROM oauth_refresh_tokens rt
    WHERE rt.client_id = c.id AND rt.revoked_at IS NULL
  );
```
