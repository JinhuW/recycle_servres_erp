import { useEffect } from 'react';
import { navigate } from '../lib/route';

// Hand-off key the desktop LineDrawer reads on mount to hydrate the AI
// dropzone with the shared image. sessionStorage so reload-during-handoff
// doesn't drop the file, but it's cleared once consumed.
const SHARED_FILE_KEY = 'pwa:sharedFile';

export function ShareTarget() {
  useEffect(() => {
    (async () => {
      const file = await new Promise<File | null>((resolve) => {
        const handler = (e: MessageEvent) => {
          const data = e.data as { type?: string; file?: File } | null;
          if (data?.type === 'pwa:sharedFile' && data.file instanceof File) {
            navigator.serviceWorker.removeEventListener('message', handler);
            resolve(data.file);
          }
        };
        navigator.serviceWorker?.addEventListener('message', handler);
        navigator.serviceWorker?.controller?.postMessage({ type: 'pwa:claimSharedFile' });
        // Give the SW a moment to answer; if it doesn't, proceed without a file
        // rather than stranding the user on a blank page.
        setTimeout(() => {
          navigator.serviceWorker?.removeEventListener('message', handler);
          resolve(null);
        }, 2000);
      });

      if (file) {
        try {
          sessionStorage.setItem(SHARED_FILE_KEY, await blobToDataUrl(file));
        } catch {
          /* quota or unavailable — proceed without persistence */
        }
      }
      navigate('/submit');
    })();
  }, []);

  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
