import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useAuth } from './auth';
import { usePreference } from './preferences';
import type { User } from './types';

export type Density = 'comfortable' | 'compact';
export type RolePreview = 'actual' | 'as_purchaser';

export type EffectiveUser = (User & { previewing?: boolean }) | null;

export type Tweaks = {
  density: Density;
  rolePreview: RolePreview;
};

type TweaksState = Tweaks & {
  setDensity: (d: Density) => void;
  setRolePreview: (r: RolePreview) => void;
};

const Ctx = createContext<TweaksState | null>(null);

// Thin facade over usePreference so call-sites don't change. Density and
// role-preview live in the per-user preferences blob; this file just maps
// the two keys onto the existing useTweaks API.
export function TweaksProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = usePreference('tweaks.density', 'comfortable');
  const [rolePreview, setRolePreview] = usePreference('tweaks.rolePreview', 'actual');

  useEffect(() => {
    document.body.dataset.density = density;
  }, [density]);

  const value = useMemo<TweaksState>(
    () => ({ density, rolePreview, setDensity, setRolePreview }),
    [density, rolePreview, setDensity, setRolePreview],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTweaks(): TweaksState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTweaks must be used inside <TweaksProvider>');
  return v;
}

// Combines the auth user with the manager-only "preview as purchaser" tweak.
// When previewing, role is forced to 'purchaser' and `previewing` is true.
export function useEffectiveUser(): EffectiveUser {
  const { user } = useAuth();
  const { rolePreview } = useTweaks();
  return useMemo<EffectiveUser>(() => {
    if (!user) return null;
    if (user.role === 'manager' && rolePreview === 'as_purchaser') {
      return { ...user, role: 'purchaser', previewing: true };
    }
    return user;
  }, [user, rolePreview]);
}
