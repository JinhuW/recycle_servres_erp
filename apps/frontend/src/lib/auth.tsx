import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, auth as tokenStore, ApiError } from './api';
import type { User, Lang } from './types';

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setLanguage: (lang: Lang) => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: if we have a token, fetch the profile to validate it.
  useEffect(() => {
    if (!tokenStore.token) {
      setLoading(false);
      return;
    }
    api.get<{ user: User }>('/api/me')
      .then(r => setUser(r.user))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) tokenStore.token = null;
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
    tokenStore.token = r.token;
    setUser(r.user);
  };

  const logout = () => {
    tokenStore.token = null;
    setUser(null);
  };

  const setLanguage = async (lang: Lang) => {
    if (!user) return;
    setUser({ ...user, language: lang });
    try { await api.patch('/api/me', { language: lang }); }
    catch { /* keep optimistic update; revisit if it gets noisy */ }
  };

  return <Ctx.Provider value={{ user, loading, login, logout, setLanguage }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be inside AuthProvider');
  return v;
}
