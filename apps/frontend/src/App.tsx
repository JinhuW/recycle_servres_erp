import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LangProvider } from './lib/i18n';
import { PHONE_BREAKPOINT } from './lib/viewport';

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

function useIsPhone() {
  const get = () => typeof window !== 'undefined' && window.innerWidth < PHONE_BREAKPOINT;
  const [isPhone, setIsPhone] = useState(get);
  useEffect(() => {
    const onResize = () => setIsPhone(get());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isPhone;
}

export default function App() {
  const isPhone = useIsPhone();
  return (
    <LangProvider>
      <ErrorBoundary>
        <Suspense fallback={<div className="app-loading" />}>
          {isPhone ? <MobileApp /> : <DesktopApp />}
        </Suspense>
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
