import { useEffect, useState } from 'react';
import { LangProvider } from './lib/i18n';
import { MobileApp } from './MobileApp';
import { DesktopApp } from './DesktopApp';

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
  return (
    <LangProvider>
      {isPhone ? <MobileApp /> : <DesktopApp />}
    </LangProvider>
  );
}
