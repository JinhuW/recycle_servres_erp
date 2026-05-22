import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../lib/i18n';
import { ApiError, rawFetch } from '../lib/api';

/**
 * OAuth 2.1 consent screen.
 *
 * Backend flow:
 *   1. Client hits `/oauth/authorize?…` → backend parks the request and
 *      302-redirects to `/authorize?req=<handle>` (this page).
 *   2. SPA fetches `GET /oauth/authorize/pending/:req` to display client +
 *      scope details.
 *   3. On approve, SPA `POST /oauth/authorize/consent` with `{ req }` and
 *      `Accept: application/json`. The backend mints a code and replies with
 *      `{ redirectUri }`; the SPA navigates the top-level window there, so
 *      the OAuth client receives a normal browser request (with its `code`
 *      query param) and completes the flow.
 */

type Pending = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string | null;
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; pending: Pending }
  | { kind: 'error'; message: string }
  | { kind: 'approving' }
  | { kind: 'denying' }
  | { kind: 'approved'; clientName: string };

function readReqParam(): string | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const r = q.get('req');
  return r && r.length > 0 ? r : null;
}

export function Authorize() {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const req = readReqParam();

  useEffect(() => {
    if (!req) {
      setState({ kind: 'error', message: t('oauthConsentMissingReq') });
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await rawFetch('GET', `/oauth/authorize/pending/${encodeURIComponent(req)}`);
        if (!res.ok) {
          const text = await res.text();
          let msg: string;
          try {
            const j = JSON.parse(text) as { error?: string };
            msg = j.error ?? `HTTP ${res.status}`;
          } catch {
            msg = `HTTP ${res.status}`;
          }
          if (!alive) return;
          setState({ kind: 'error', message: msg });
          return;
        }
        const pending = (await res.json()) as Pending;
        if (!alive) return;
        setState({ kind: 'ready', pending });
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : String(e));
        setState({ kind: 'error', message: msg });
      }
    })();
    return () => { alive = false; };
  }, [req, t]);

  async function approve() {
    if (state.kind !== 'ready' || !req) return;
    const clientName = state.pending.clientName;
    setState({ kind: 'approving' });
    try {
      const res = await rawFetch('POST', '/oauth/authorize/consent', { req }, {
        Accept: 'application/json',
      });
      if (res.ok) {
        const body = (await res.json()) as { redirectUri?: string };
        if (body.redirectUri) {
          setState({ kind: 'approved', clientName });
          window.location.href = body.redirectUri;
          return;
        }
        setState({ kind: 'error', message: 'missing redirectUri' });
        return;
      }
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) msg = j.error;
      } catch { /* keep HTTP status */ }
      setState({ kind: 'error', message: msg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message: msg });
    }
  }

  async function deny() {
    if (state.kind !== 'ready' || !req) return;
    setState({ kind: 'denying' });
    try {
      const res = await rawFetch('POST', '/oauth/authorize/deny', { req }, {
        Accept: 'application/json',
      });
      if (res.ok) {
        const body = (await res.json()) as { redirectUri?: string };
        if (body.redirectUri) {
          window.location.href = body.redirectUri;
          return;
        }
        setState({ kind: 'error', message: 'missing redirectUri' });
        return;
      }
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) msg = j.error;
      } catch { /* keep HTTP status */ }
      setState({ kind: 'error', message: msg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ kind: 'error', message: msg });
    }
  }

  return (
    <div className="login-shell" style={{ position: 'relative' }}>
      <div className="login-card" style={{ maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 16 }}>RS</div>
          <div>
            <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{t('appBrand')}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('oauthConsentOverline')}</div>
          </div>
        </div>

        {state.kind === 'loading' && (
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>{t('oauthConsentLoading')}</div>
        )}

        {state.kind === 'error' && (
          <>
            <h1 style={{ fontSize: 20, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
              {t('oauthConsentErrorTitle')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>
              {state.message}
            </p>
          </>
        )}

        {(state.kind === 'ready' || state.kind === 'approving' || state.kind === 'denying') && (
          <>
            <h1 style={{ fontSize: 20, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
              {t('oauthConsentTitle', { client: state.kind === 'ready' ? state.pending.clientName : '' })}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>
              {t('oauthConsentSub')}
            </p>

            <div className="card" style={{ padding: 14, marginBottom: 14, background: 'var(--bg-elev)', borderRadius: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 6 }}>
                {t('oauthConsentScopesLabel')}
              </div>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {state.kind === 'ready' && state.pending.scopes.length === 0 && (
                  <li style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>{t('oauthConsentScopesNone')}</li>
                )}
                {state.kind === 'ready' && state.pending.scopes.map((s) => (
                  <li key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <Icon name="check2" size={14} />
                    <code style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }}>{s}</code>
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={deny}
                disabled={state.kind !== 'ready'}
                style={{ flex: 1 }}
              >
                {state.kind === 'denying' ? t('oauthConsentDenying') : t('oauthConsentDeny')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={approve}
                disabled={state.kind !== 'ready'}
                style={{ flex: 1 }}
              >
                {state.kind === 'approving' ? t('oauthConsentApproving') : t('oauthConsentApprove')}
              </button>
            </div>
          </>
        )}

        {state.kind === 'approved' && (
          <>
            <h1 style={{ fontSize: 20, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
              {t('oauthConsentApprovedTitle')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>
              {t('oauthConsentApprovedSub', { client: state.clientName })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
