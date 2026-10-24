import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installChunkReload } from './lib/chunkReload';
import { installTiming } from './lib/timing';
import { AuthProvider } from './lib/auth';
import { PreferencesProvider } from './lib/preferences';
import { TweaksProvider } from './lib/tweaks';
import { registerPwa } from './lib/pwa';

import './styles/tokens.css';
import './styles/phone.css';
// pwa.css rides along with the components that own it (App.tsx lazy-loads
// them), so it is not in the entry bundle.

// Before render: a shell chunk can fail on the very first import, so the
// listener has to be up before anything asks for one.
installChunkReload();
// Records how long this load actually took. Reports once, after `load`.
installTiming();

// iOS zooms into any focused field under 16px (the phone shell's are 14px) and
// never zooms back out; maximum-scale stops that, and Safari still lets a pinch
// past it. Android never focus-zooms but takes the cap as a pinch lock, so it
// keeps the uncapped viewport. iPadOS reports itself as a Mac.
const ua = navigator.userAgent;
if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
  document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content += ', maximum-scale=1';
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <React.StrictMode>
    <AuthProvider>
      <PreferencesProvider>
        <TweaksProvider>
          <App />
        </TweaksProvider>
      </PreferencesProvider>
    </AuthProvider>
  </React.StrictMode>,
);

registerPwa();
