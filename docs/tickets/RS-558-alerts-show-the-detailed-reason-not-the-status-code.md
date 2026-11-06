---
id: RS-558
title: Alerts show the detailed reason, not the status code
type: bug
status: done
priority: P2
created: 2026-11-06
reporter: jinhu
branch: JinhuW/gourami
pr: "#1129"
version: 1.433.1
related: []
---

## Ask

> Keep in mind.
> [Image #1]
> For all future alerts do not show status code and show the detailed reason instead.
>
> Debug this issue, i can not re-login

## Context

A manager pressed Re-login on worker-60-14-11 and saw `engine_mismatch` above
`POST /api/fleet/workers/worker-60-14-11/relogin · 409 · <request id>`. The
backend had already sent a readable reason in `detail`. `errMsg` in
`apps/frontend/src/lib/api.ts` reads only `error`, and `handleFetchError` in
`lib/errorToast.ts` adds the status to the detail line. `FleetError` bodies are
`{ error, detail? }`. A few fleet pages read `detail` by hand (`warnOrFail` in
`FleetProxies.tsx`); every other page showed the bare code.

The refusal itself was correct. #159 was switched to CloakBrowser at 13:52:54 UTC
while its worker sat parked on Session expired in a stock browser, and a parked
worker holds its lease, so it never reaches the next normal start the switch
waits for. Getting #159 out is a choice on the fleet page, not a code change.

## Acceptance criteria

- [x] A refusal with a `detail` string shows that text as the dialog's message, not the `error` code.
- [x] The dialog's detail line shows method, path and request ID, with no status code.
- [x] A failed response with no reason shows the generic "try again" sentence, not `HTTP 500`.
- [x] `Authorize.tsx` and `scannerBridge.ts` no longer show `HTTP n` as text.
- [x] The `engine_mismatch` reason says how to get unblocked.
- [x] The operator log keeps the status, and still logs the `error` code as its message.

## Out of scope

- Disabling Re-login while a worker's engine differs from its slot.
- Guarding hand sign-ins on the worker screen, as happened on #157 and #158:
  both went Healthy on stock after being switched to CloakBrowser.
- Rewriting every backend error that has only a code. Those still show the code
  until they get a `detail`.
- Translating backend reasons; they stay in English as they do today.
- Provider text stored with a status inside it, such as the PayPal dispute-sync
  error `DesktopPayments.tsx` matches with `HTTP 403`.

## Notes

Diagnosis page: http://10.10.100.225:8800/relogin-engine-mismatch.html
