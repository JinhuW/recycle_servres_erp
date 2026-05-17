import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, auth as tokenStore, ApiError } from './api';
import { loadLookups, resetLookups } from './lookups';
import { loadWorkspaceSettings, resetWorkspaceSettings } from './workspace';
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

  // On mount: if we have a token, validate it and load DB-backed lookup data
  // (catalog dropdowns, statuses, payment terms, price sources) in parallel.
  // Lookups are fetched here so every authenticated page can read them
  // synchronously from lib/lookups.ts module state.
  useEffect(() => {
    if (!tokenStore.token) {
      setLoading(false);
      return;
    }
    Promise.all([
      api.get<{ user: User }>('/api/me').then(r => setUser(r.user)),
      // Lookups are best-effort: a transient failure must not look like an
      // auth failure or strand a valid user on the login screen. loadLookups()
      // resets itself on failure, so it stays retry-able.
      loadLookups().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('Lookups failed to load; continuing.', e);
      }),
      loadWorkspaceSettings().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('Workspace settings failed to load; continuing.', e);
      }),
    ])
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) tokenStore.token = null;
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
    tokenStore.token = r.token;
    // A lookups failure must not abort an otherwise-successful login; it's
    // best-effort and retry-able on the next call.
    try { await loadLookups(); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Lookups failed to load after login; continuing.', e);
    }
    try { await loadWorkspaceSettings(); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Workspace settings failed to load after login; continuing.', e);
    }
    setUser(r.user);
  };

  const logout = () => {
    tokenStore.token = null;
    setUser(null);
    resetLookups();
    resetWorkspaceSettings();
  };

  // api.ts fires `auth:unauthorized` when any call gets a 401 mid-session
  // (expired/revoked token). Drop to the login screen instead of leaving the
  // user staring at stale data while every request silently fails.
  useEffect(() => {
    const onUnauthorized = () => logout();
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
    // logout only touches stable setters/module resets; safe to bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
