import { useEffect } from 'react';
import { replaceRoute } from '../lib/route';
import { blobToDataUrl, compressForUpload } from '../lib/image-compress';
import { storeSharedFile } from '../lib/sharedFile';

// The file is handed on through lib/sharedFile.ts to `/submit`, which keeps it
// for the next new product's camera. sessionStorage so a reload during the
// hand-off doesn't drop the file; cleared once consumed. Compressed first, as
// the shutter path is: a full-size phone photo as a data URL overflows the
// storage quota, and the share used to vanish without a word.

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

      let stored = false;
      if (file) {
        try {
          stored = storeSharedFile(await blobToDataUrl(await compressForUpload(file)));
        } catch {
          stored = false;
        }
      }
      // Replaced, not pushed: a landing left in history replayed on Back and
      // reset the capture session it had opened.
      replaceRoute(file && !stored ? '/submit?sharedLost=1' : '/submit');
    })();
  }, []);

  return null;
}
