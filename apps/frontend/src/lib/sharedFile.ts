// The hand-off from the Web Share Target landing (pages/ShareTarget.tsx) to
// the scanner. The service worker stashes the shared file; the landing page
// claims it, stores it here as a data URL and opens the capture flow; the
// camera screen takes it the moment it opens and runs the scan on it. One
// reader, once: a photo shared yesterday must not surface in today's capture.
export const SHARED_FILE_KEY = 'pwa:sharedFile';

export function storeSharedFile(dataUrl: string): void {
  try { sessionStorage.setItem(SHARED_FILE_KEY, dataUrl); } catch { /* quota or unavailable */ }
}

export function hasSharedFile(): boolean {
  try { return sessionStorage.getItem(SHARED_FILE_KEY) !== null; } catch { return false; }
}

export function takeSharedFile(): string | null {
  try {
    const v = sessionStorage.getItem(SHARED_FILE_KEY);
    if (v !== null) sessionStorage.removeItem(SHARED_FILE_KEY);
    return v;
  } catch { return null; }
}
