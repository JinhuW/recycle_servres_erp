import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LangProvider, useT } from './lib/i18n';
import { PHONE_BREAKPOINT } from './lib/viewport';
import { DiscardConfirmHost, confirmDiscard } from './lib/unsavedGuard';

// desktop.css stays here despite the name: it owns the shared modal and card
// layer the phone shell renders too, so it is the main stylesheet rather than
// a desktop-only one.
import './styles/desktop.css';

// Phone-only, and they carry pwa.css with them.
const PwaInstallPrompt = lazy(() =>
  import('./components/PwaInstallPrompt').then(m => ({ default: m.PwaInstallPrompt })));
const PwaUpdateToast = lazy(() =>
  import('./components/PwaUpdateToast').then(m => ({ default: m.PwaUpdateToast })));

const DesktopApp = lazy(() => import('./DesktopApp').then(m => ({ default: m.DesktopApp })));
const MobileApp  = lazy(() => import('./MobileApp').then(m => ({ default: m.MobileApp })));

// The shell is chosen once, when the page loads. It used to follow every
// resize: dragging a window narrow, rotating a tablet or opening devtools
// unmounted one shell for the other, and an edit in progress went with it. Now
// a window that no longer fits its shell only offers the switch.
const phoneWidth = () => typeof window !== 'undefined' && window.innerWidth < PHONE_BREAKPOINT;

function useShell() {
  const [isPhone, setIsPhone] = useState(phoneWidth);
  const [fitsPhone, setFitsPhone] = useState(isPhone);
  useEffect(() => {
    const onResize = () => setFitsPhone(phoneWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const switchShell = async () => {
    if (await confirmDiscard()) setIsPhone(fitsPhone);
  };
  return { isPhone, mismatch: isPhone !== fitsPhone, fitsPhone, switchShell };
}

function LayoutSwitch({ toPhone, onSwitch }: { toPhone: boolean; onSwitch: () => void }) {
  const { t } = useT();
  return (
    <button type="button" className="btn layout-switch" onClick={onSwitch}>
      {t(toPhone ? 'switchToPhoneLayout' : 'switchToDesktopLayout')}
    </button>
  );
}

export default function App() {
  const { isPhone, mismatch, fitsPhone, switchShell } = useShell();
  return (
    <LangProvider>
      <ErrorBoundary>
        <Suspense fallback={<div className="app-loading" />}>
          {isPhone ? <MobileApp /> : <DesktopApp />}
        </Suspense>
        <DiscardConfirmHost />
        {mismatch && <LayoutSwitch toPhone={fitsPhone} onSwitch={() => { void switchShell(); }} />}
      </ErrorBoundary>
      {isPhone && (
        <Suspense fallback={null}>
          <PwaInstallPrompt />
          <PwaUpdateToast />
        </Suspense>
      )}
    </LangProvider>
  );
}
