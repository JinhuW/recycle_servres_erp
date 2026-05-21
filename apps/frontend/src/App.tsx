import { lazy, Suspense, useEffect, useState } from 'react';
import { LangProvider } from './lib/i18n';
import { vendorTokenFromPath } from './lib/vendor';

import './styles/desktop.css';

const DesktopApp = lazy(() => import('./DesktopApp').then(m => ({ default: m.DesktopApp })));
const MobileApp  = lazy(() => import('./MobileApp').then(m => ({ default: m.MobileApp })));
const VendorApp  = lazy(() => import('./VendorApp').then(m => ({ default: m.VendorApp })));

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
  const vendorToken = typeof window !== 'undefined'
    ? vendorTokenFromPath(window.location.pathname) : null;
  if (vendorToken) {
    return (
      <LangProvider>
        <Suspense fallback={<div className="app-loading" />}>
          <VendorApp token={vendorToken} isPhone={isPhone} />
        </Suspense>
      </LangProvider>
    );
  }
  return (
    <LangProvider>
      <Suspense fallback={<div className="app-loading" />}>
        {isPhone ? <MobileApp /> : <DesktopApp />}
      </Suspense>
    </LangProvider>
  );
}
