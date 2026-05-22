import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { loadLookups, resetLookups } from './lookups';
import { loadWorkspaceSettings, resetWorkspaceSettings } from './workspace';
import type { User, Lang } from './types';

// Drop all client-side auth state. Shared by the user-initiated logout() and
// the no-session `auth:unauthorized` path so both clear identically.
function clearLocalAuthState(setUser: (u: User | null) => void) {
  setUser(null);
  resetLookups();
  resetWorkspaceSettings();
}

// Decide what `auth:unauthorized` should do. With a live user we run the full
// logout (server revoke + local reset). With no user — e.g. the bootstrap
// /api/me 401 on a logged-out cold load — there is no session to revoke, so we
// skip the pointless POST /api/auth/logout and just ensure local state is
// clear. Exported for unit testing without a React renderer.
export function handleUnauthorized(
  currentUser: User | null,
  logout: () => Promise<void> | void,
  setUser: (u: User | null) => void,
): void {
  if (currentUser) {
    void logout();
  } else {
    clearLocalAuthState(setUser);
  }
}

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setLanguage: (lang: Lang) => Promise<void>;
  // Set to true after a successful login() when the freshly-authenticated user
  // is a manager — the app shell renders the RolePicker gate so they can pick
  // whether to enter as Manager or as Purchaser. NOT set when the session is
  // restored from /api/me on cold-load: a page reload should respect the
  // already-chosen rolePreview without re-asking.
  pendingRoleChoice: boolean;
  confirmRoleChoice: () => void;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingRoleChoice, setPendingRoleChoice] = useState(false);
  // Mirror `user` so the once-bound auth:unauthorized listener can read the
  // live value without re-subscribing on every user change.
  const userRef = useRef<User | null>(user);
  userRef.current = user;

  // On mount: bootstrap the session from the auth cookie via /api/me and load
  // DB-backed lookup data (catalog dropdowns, statuses, payment terms, price
  // sources) in parallel. Lookups are fetched here so every authenticated page
  // can read them synchronously from lib/lookups.ts module state. The api
  // client already attempts a silent refresh before surfacing a 401, so a 401
  // here just means "no valid session" — treat it as logged-out, quietly.
  useEffect(() => {
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
        // Not logged in: quietly stay on the login screen, no console error,
        // no bounce. Re-surface anything that isn't an auth failure.
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          return;
        }
        // eslint-disable-next-line no-console
        console.warn('Session bootstrap failed; continuing as logged-out.', e);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: User }>('/api/auth/login', { email, password });
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
    // Only managers see the picker — for purchasers there's only one path in.
    if (r.user.role === 'manager') setPendingRoleChoice(true);
  };

  const confirmRoleChoice = () => setPendingRoleChoice(false);

  const logout = async () => {
    // Best-effort: server revokes the refresh token and clears the auth
    // cookies. Even if it fails (offline/expired) we still drop local state.
    await api.post('/api/auth/logout', {}).catch(() => {});
    clearLocalAuthState(setUser);
    setPendingRoleChoice(false);
  };

  // api.ts fires `auth:unauthorized` when any call gets a 401 mid-session
  // (expired/revoked token). Drop to the login screen instead of leaving the
  // user staring at stale data while every request silently fails. But on a
  // logged-out cold load the bootstrap's own /api/me 401 also fires this — and
  // hitting POST /api/auth/logout when there was never a session is pointless
  // (and noisy). So only do the server logout when a user is actually set;
  // otherwise just ensure local state is clear. A user-initiated logout()
  // from the UI is unaffected and always hits the server.
  useEffect(() => {
    // Read the current user lazily via a ref so the once-bound listener still
    // sees the live value without re-subscribing on every user change.
    const onUnauthorized = () => handleUnauthorized(userRef.current, logout, setUser);
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

  return (
    <Ctx.Provider value={{ user, loading, login, logout, setLanguage, pendingRoleChoice, confirmRoleChoice }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be inside AuthProvider');
  return v;
}
