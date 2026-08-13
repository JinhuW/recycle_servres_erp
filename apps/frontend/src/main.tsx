import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './lib/auth';
import { PreferencesProvider } from './lib/preferences';
import { TweaksProvider } from './lib/tweaks';
import { registerPwa } from './lib/pwa';

import './styles/tokens.css';
import './styles/phone.css';
// pwa.css rides along with the two components that own it (App.tsx lazy-loads
// them, phone-only), so it is not in the entry bundle.

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
