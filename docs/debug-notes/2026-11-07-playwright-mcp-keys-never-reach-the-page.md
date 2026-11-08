# Local check: Playwright MCP keystrokes never reached the page

**2026-11-07, ERP v1.445.0 (RS-569).**

## Symptom

In Review mode, the commission rate field (`#bc-rate`) took a value through
`browser_fill_form`. `browser_press_key Enter` then did nothing: focus stayed in
the field and no `PATCH /api/orders/:id` was sent. `browser_type` with
`slowly: true, submit: true` did nothing either. The field still read the old
value, so not even the digits arrived.

It looked like a bug in the field's Enter-to-commit. It wasn't.

## Cause

The trusted key events never reached the document. A `keydown` spy on both the
input and `document` (capture phase) recorded nothing for either tool. Neither
tool reported an error. Those events are lost somewhere in the MCP's input
path; the root cause wasn't found.

The app was fine. The only capture-phase `keydown` listener is
`lib/useFocusTrap.ts`, which is active only while a modal is open. Review
mode's document listener (`DesktopBoxCheck.tsx`) returns early for inputs.

## Fix

Before you suspect the app, prove the key arrives. Install a spy:

```js
window.__keys = [];
document.addEventListener('keydown', e => window.__keys.push([e.key, e.target.id]), true);
```

Press the key, then read `window.__keys`. If it's empty, dispatch the event
from `browser_evaluate`:

```js
el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
```

React's delegated handler runs on a dispatched event, so this drives the real
`onKeyDown`. Here it blurred the field, committed the rate and re-projected
*Purchaser earns*. For uploads, when clicking a dropzone opens no file chooser
for `browser_file_upload`, dispatch `dragenter`, `dragover` and `drop` with a
`DataTransfer` holding a `File`. That takes the dropzone's own `onFiles` path.

## Also seen again

A sign-out made with `fetch` to the backend port (`:8931`) left the SPA on
`:5180` in a state where every later login returned 200 and was then followed
by 401s. `browser_close` and a fresh page fixed it, as
[2026-10-23](2026-10-23-local-db-behind-dev-and-playwright-login-stuck.md) §2
says. To switch users, close the browser rather than signing out.
