import { useEffect, useState } from 'react';
import { LangProvider } from './lib/i18n';
import { MobileApp } from './MobileApp';
import { DesktopApp } from './DesktopApp';
import { VendorApp } from './VendorApp';
import { vendorTokenFromPath } from './lib/vendor';

import './styles/desktop.css';

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
    return <LangProvider><VendorApp token={vendorToken} /></LangProvider>;
  }
  return (
    <LangProvider>
      {isPhone ? <MobileApp /> : <DesktopApp />}
    </LangProvider>
  );
}
