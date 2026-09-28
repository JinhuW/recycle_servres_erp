# A "still mounted" ref must be set to true in the effect, not only initialised

**2026-09-26.** RS-115, the Scan RAM sheet dialog. After adding a
`mounted` guard, every stick sat on "Reading label…" forever in the local dev
build. The backend log showed that no `/api/scan/label` request was ever sent.

## The cause

```ts
const mounted = useRef(true);
useEffect(() => () => { mounted.current = false; }, []);
```

`main.tsx` wraps the app in `<React.StrictMode>`. In development React mounts
the component, runs the effect cleanup, and mounts again. The cleanup set the
ref to `false`, and nothing set it back, so `readLabel`'s
`if (!mounted.current) return;` skipped every read. A production build doesn't
double-invoke effects, so it would have worked there. That makes this worse,
not better: dev and prod behave differently.

## The fix

Set the ref inside the effect as well:

```ts
useEffect(() => {
  mounted.current = true;
  return () => { mounted.current = false; };
}, []);
```

## How it was caught

A real-click smoke that waited for the rows to finish reading timed out. Its
"3 s after upload" state dump showed `reading: 2` and no label requests in
`be.log`.
