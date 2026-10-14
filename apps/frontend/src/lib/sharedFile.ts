// The hand-off from the Web Share Target landing (pages/ShareTarget.tsx) to
// the capture flow. The service worker stashes the shared file; the landing
// page claims it, stores it here as a data URL and opens `/submit`, which takes
// it into the capture session for the next new product's camera. One reader,
// once: a photo shared yesterday must not surface in today's capture.
export const SHARED_FILE_KEY = 'pwa:sharedFile';

// False when the browser refused it (quota, storage off), so the landing can
// say the photo was lost instead of opening an empty capture in silence.
export function storeSharedFile(dataUrl: string): boolean {
  try {
    sessionStorage.setItem(SHARED_FILE_KEY, dataUrl);
    return true;
  } catch {
    return false;
  }
}

export function takeSharedFile(): string | null {
  try {
    const v = sessionStorage.getItem(SHARED_FILE_KEY);
    if (v !== null) sessionStorage.removeItem(SHARED_FILE_KEY);
    return v;
  } catch { return null; }
}
