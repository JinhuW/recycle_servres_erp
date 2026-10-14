import { useEffect } from 'react';
import { navigate } from '../lib/route';
import { blobToDataUrl } from '../lib/image-compress';
import { storeSharedFile } from '../lib/sharedFile';

// The file is handed on through lib/sharedFile.ts: the phone's camera screen
// reads it the moment it opens and scans it. sessionStorage so a reload
// during the hand-off doesn't drop the file; cleared once consumed.

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

      if (file) storeSharedFile(await blobToDataUrl(file));
      navigate('/submit');
    })();
  }, []);

  return null;
}
