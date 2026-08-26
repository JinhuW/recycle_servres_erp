# PayPal txns "missing" from Payments = Transaction Search reporting lag

**Symptom (2026-08-26).** PayPal's activity page showed two fresh
transactions (9:27 / 9:31 AM EDT); the ERP Payments page didn't, even though
the PayPal sync had run at 11:10 AM — well after them. Looks exactly like a
broken sync, a filtered event code, or a cursor bug.

**Root cause: PayPal's side, not ours.** `/v1/reporting/transactions` is a
*reporting* dataset that PayPal refreshes on a delay — the docs say executed
transactions can take up to ~3 hours to appear (occasionally longer). The
response carries the proof in `last_refreshed_datetime`; on the day of the
incident it read `12:59:59Z` while the "missing" transactions were initiated
13:27/13:31Z. The API returned them to nobody, so the ERP could not have
ingested them.

**How to verify before touching sync code** (5 minutes, no deploy):

```bash
# prod credentials
railway variables --environment production --service backend --json  # PAYPAL_CLIENT_ID/SECRET
# mint token via /v1/oauth2/token (Basic auth, grant_type=client_credentials),
# then:
curl -s -H "Authorization: Bearer $TOK" \
  "https://api-m.paypal.com/v1/reporting/transactions?start_date=<3d ago>&end_date=<now>&fields=transaction_info,payer_info&page_size=100&page=1" \
  | jq '{last_refreshed_datetime, total_items}'
```

If `last_refreshed_datetime` predates the "missing" transactions, there is
nothing to fix: they arrive on a later sync. The sync cursor rewinds 5 days
(`OVERLAP_MS` in `apps/backend/src/banktx/sync.ts`), which dwarfs the ~3 h
reporting lag, so nothing is ever permanently skipped — the background loop
(6 h) or the page's **Sync now** button picks them up once PayPal publishes.

**Second look-alike trap in the same screenshot.** PayPal's activity list can
show a paid money request twice — the bill row ("Bill From X — Paid") and the
payment row ("Purchase from X — Completed") for the same money. The search
API reports the actual settled movement(s) (`transaction_status = 'S'`), so
the ERP legitimately may show fewer rows than the activity page. Compare
against the API response, not the activity UI, before calling it a gap.
