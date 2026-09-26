# Buttons inside `.ai-dropzone` can't be clicked, and a JS `.click()` smoke won't notice

**2026-09-26.** RS-114. Right after RS-109 shipped, a purchaser clicked
**Scan from printer** in the Scan RAM sheet dialog and nothing happened.
**Upload scan image** was dead too.

## The cause

The dialog put real `<button>`s directly inside `<div className="ai-dropzone">`
to borrow its dashed look. `tokens.css` has:

```css
.ai-dropzone > * { pointer-events: none; }  /* children inherit the click target */
```

That rule is right for the line drawer's dropzone, which is itself one
`role="button"` surface. It kills any interactive child. In the user's Chrome,
`document.elementFromPoint()` at the button's centre returned the
`DIV.ai-dropzone`, and the button's computed `pointer-events` was `none`.

## Why the RS-109 smoke passed

Every click in that smoke was `page.evaluate(() => el.click())`. The DOM
`click()` fires the handler directly and ignores CSS hit-testing, so a
`pointer-events: none` button "works". The smoke only proved the handlers were
wired, not that anyone could reach them.

## The fix

- The action row is a plain flex row (`.rsheet-actions` in `desktop.css`) that
  only looks like a dropzone.
- Drag-and-drop moved to the dialog body.
- Smokes for this dialog now use real pointer input: Playwright
  `locator.click()` or `page.mouse.click(x, y)`, and `waitForEvent('filechooser')`
  for the upload button.

**Rule:** never put interactive elements inside `.ai-dropzone`. For any smoke that
claims "the button works", click with the mouse and not with `el.click()`.

## Also hit while re-smoking: a stale dev server kept serving the old code

A vite from the previous RS-109 worktree kept port 5173 alive after `pkill -f
"vite --host"`; the real command line didn't match. The new worktree's vite
failed with EADDRINUSE and quit, so the smoke tested the old dialog and "proved"
the fix didn't work. Kill by port owner instead:
`for pid in $(lsof -nP -tiTCP:5173 -sTCP:LISTEN); do kill $pid; done`. Before
trusting a smoke, confirm the served module has your change, for example
`curl localhost:5173/src/<file>.tsx | grep <new class>`.
