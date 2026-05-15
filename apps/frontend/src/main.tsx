import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './lib/auth';
import { PreferencesProvider } from './lib/preferences';
import { TweaksProvider } from './lib/tweaks';

import './styles/tokens.css';
import './styles/phone.css';

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
