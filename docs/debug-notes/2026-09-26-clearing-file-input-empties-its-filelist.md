# Clearing a file input's value empties the FileList you already read

**2026-09-26.** RS-109, the "Scan RAM sheet" dialog. Uploading a scan image
through the dialog's **Upload scan image** button did nothing. There was no
error, no request, and the dialog just sat there. Drag-and-drop onto the same
dialog worked.

## The cause

The change handler did the usual "let the same file be picked twice" dance:

```ts
onChange={e => { const f = e.target.files; e.target.value = ''; takeFiles(f); }}
```

`e.target.files` is **live**. Setting `value = ''` swaps the input's files
for an empty list, and the `FileList` object you already hold goes empty with
it. This was checked in Chrome with a two-line page: `length` read 1 before
the reset and 0 after. So `takeFiles` got an empty list and returned
silently.

## The fix

Copy first, then clear:

```ts
const picked = Array.from(e.target.files ?? []);
e.target.value = '';
takeFiles(picked);
```

## Still open

`LineDrawer.tsx` `onAiFileChosen` has the same shape: it reads `files`,
clears `value`, then checks `files.length`. Its click-to-upload path for the
per-line AI scan is probably dead in Chrome the same way, with drag-and-drop
still working. It was left alone because it was out of RS-109's scope. It
should be fixed with the same three lines.

## Also hit: the old bundled headless Chromium crashes the dashboard

Driving the local smoke with `~/Library/Caches/ms-playwright/chromium-1048`
(a 2023 build) crashed `DesktopDashboard` with `not a calendar date:
09/26/2026`, because its ICU formats dates differently from current Chrome.
That isn't an app bug. Point `executablePath` at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` instead.
Separately, a bare `page.goto('/submit')` lands on the dashboard, so navigate
by clicking the **Submit order** nav item.
