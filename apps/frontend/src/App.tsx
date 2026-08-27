import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LangProvider } from './lib/i18n';
import { vendorTokenFromPath } from './lib/vendor';

// desktop.css stays here despite the name: it owns the shared modal, card and
// vendor-portal layer (~100 classes the phone and vendor shells render), so it
// is the main stylesheet rather than a desktop-only one.
import './styles/desktop.css';

// Phone-only, and they carry pwa.css with them.
const PwaInstallPrompt = lazy(() =>
  import('./components/PwaInstallPrompt').then(m => ({ default: m.PwaInstallPrompt })));
const PwaUpdateToast = lazy(() =>
  import('./components/PwaUpdateToast').then(m => ({ default: m.PwaUpdateToast })));

const DesktopApp = lazy(() => import('./DesktopApp').then(m => ({ default: m.DesktopApp })));
const MobileApp  = lazy(() => import('./MobileApp').then(m => ({ default: m.MobileApp })));
const VendorApp  = lazy(() => import('./VendorApp').then(m => ({ default: m.VendorApp })));
const SellerShippingApp = lazy(() =>
  import('./SellerShippingApp').then(m => ({ default: m.SellerShippingApp })));

// Seller-fill links (/s/<token>) mirror the vendor portal's URL-token shape.
const SELLER_PATH = /^\/s\/([^/]+)/;
function sellerTokenFromPath(pathname: string): string | null {
  const m = SELLER_PATH.exec(pathname);
  return m && m[1] ? m[1] : null;
}

const PHONE_BREAKPOINT = 720;

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
  const sellerToken = typeof window !== 'undefined'
    ? sellerTokenFromPath(window.location.pathname) : null;
  if (sellerToken) {
    return (
      <LangProvider>
        <ErrorBoundary>
          <Suspense fallback={<div className="app-loading" />}>
            <SellerShippingApp token={sellerToken} />
          </Suspense>
        </ErrorBoundary>
      </LangProvider>
    );
  }
  const vendorToken = typeof window !== 'undefined'
    ? vendorTokenFromPath(window.location.pathname) : null;
  if (vendorToken) {
    return (
      <LangProvider>
        <ErrorBoundary>
          <Suspense fallback={<div className="app-loading" />}>
            <VendorApp token={vendorToken} isPhone={isPhone} />
          </Suspense>
        </ErrorBoundary>
      </LangProvider>
    );
  }
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
