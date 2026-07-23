# Playwright MCP native clicks don't register on app buttons (local dev smoke)

**Date:** 2026-07-22
**Context:** browser-smoking the PO submit form on `localhost:5173` (Vite dev)
with the Playwright MCP tools.

## Symptom

`browser_click` on ordinary app buttons (Login "Continue", role picker,
sidebar nav) reports success but nothing happens: no network request, no
state change, no console error. Real clicks by a human work fine.

## What it is NOT

- Not an overlay/z-index problem — the snapshot shows the button unobstructed.
- Not a backend problem — the same request succeeds via `curl` through the
  Vite proxy.
- Not a stale page — reproduces right after a fresh `browser_navigate`.

## Workaround that works every time

Dispatch the click from inside the page via `browser_evaluate`:

```js
[...document.querySelectorAll('button')]
  .find(b => b.textContent?.trim() === 'Continue')?.click();
```

Synthetic `.click()` triggers the React `onClick` handlers normally. For
inputs/selects, set the value through the prototype setter and dispatch
`input`/`change` events (React reads the native setter):

```js
const set = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(el), 'value').set;
set.call(el, '32GB');
el.dispatchEvent(new Event('change', { bubbles: true }));
```

Root cause unidentified (possibly React 19 + trusted-event coordinates
landing on a child element). If a future smoke hits dead clicks, switch to
`browser_evaluate` immediately instead of retrying `browser_click`.
