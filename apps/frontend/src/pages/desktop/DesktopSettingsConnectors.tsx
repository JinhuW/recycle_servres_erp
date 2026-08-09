import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { ConfirmDialog } from './settings/dialogs';

// ─── Connectors ────────────────────────────────────────────────────────────────
// Manager-only OAuth client admin: lists registered clients (DCR-registered
// integrations + manually-minted scraper service clients), lets managers create
// new client_credentials service clients, and revokes existing ones.
// Backed by /api/oauth/clients (cookie-authed, manager-only).
type Client = {
  id: string;
  name: string;
  scopes: string[];
  grantTypes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  hasLiveGrant: boolean;
};

// The four scopes the backend grants (oauth/server.ts VALID_SCOPES). Order is
// fixed here so the checkbox list renders stably; labels resolve via i18n.
const SCOPE_OPTIONS = [
  { scope: 'market:read', labelKey: 'connectorsScopeMarketRead' },
  { scope: 'market:write', labelKey: 'connectorsScopeMarketWrite' },
  { scope: 'sellorder:read', labelKey: 'connectorsScopeSellOrderRead' },
  { scope: 'sellorder:write', labelKey: 'connectorsScopeSellOrderWrite' },
] as const;

// Callback URLs each host uses for MCP connector OAuth. Presets, not
// validation — they're a vendor's implementation detail and can change, so the
// field stays editable and /oauth/authorize echoes back the URI it rejected.
const REDIRECT_PRESETS = [
  {
    key: 'claude',
    labelKey: 'connectorsPresetClaude',
    uris: [
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
    ],
  },
  {
    // Claude Code binds a fresh loopback port every run, so a portless URI is
    // enough — the backend matches loopback redirects ignoring the port.
    key: 'claudeCode',
    labelKey: 'connectorsPresetClaudeCode',
    uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  },
  {
    key: 'chatgpt',
    labelKey: 'connectorsPresetChatGPT',
    uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  },
] as const;

export function DesktopSettingsConnectors() {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [clients, setClients] = useState<Client[] | null>(null);
  // Connectors self-register when DCR is on, which makes the manual
  // connector-client form dead UI. Only surface it when it's the only way in.
  const [dcrOpen, setDcrOpen] = useState(true);
  // Collapsed by default: service clients are for a non-interactive scraper,
  // which is a rare, deliberate setup step — not something to put in the way of
  // the connector instructions above.
  const [serviceOpen, setServiceOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<string[]>(['market:read']);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [newClientId, setNewClientId] = useState<string | null>(null);
  // Which form minted the credentials on screen, so the panel renders under the
  // card the manager just used rather than always under the service-client one.
  const [credFrom, setCredFrom] = useState<'connector' | 'service' | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [connName, setConnName] = useState('');
  const [connScopes, setConnScopes] = useState<string[]>(['market:read', 'sellorder:read']);
  const [redirectUris, setRedirectUris] = useState('');
  // Revoking is irreversible, so it asks first — in the app's own dialog, not
  // the browser's, which the shell can't style or translate.
  const [pending, setPending] = useState<{ kind: 'cleanup' } | { kind: 'revoke'; id: string } | null>(null);

  // Same-origin: the backend mounts the MCP endpoint at /api/mcp behind the
  // same host that serves this app, so the URL an MCP client needs is derivable
  // on the client without threading OAUTH_ISSUER_URL to the frontend.
  const mcpUrl = `${window.location.origin}/api/mcp`;

  async function copySecret() {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function copyClientId() {
    if (!newClientId) return;
    await navigator.clipboard.writeText(newClientId);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 1500);
  }

  async function copyMcpUrl() {
    await navigator.clipboard.writeText(mcpUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 1500);
  }

  const load = () =>
    api.get<{ clients: Client[]; dcrOpen: boolean }>('/api/oauth/clients')
      .then((r) => { setClients(r.clients); setDcrOpen(r.dcrOpen); })
      .catch(handleFetchError);
  useEffect(() => { load(); }, []);

  async function createServiceClient() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const r = await api.post<{ clientId: string; clientSecret: string }>(
        '/api/oauth/clients',
        {
          name,
          grantTypes: ['client_credentials'],
          scopes: newScopes,
          public: false,
        },
      );
      setNewSecret(r.clientSecret);
      setNewClientId(r.clientId);
      setCredFrom('service');
      setNewName('');
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setCreating(false);
    }
  }

  async function createConnectorClient() {
    const name = connName.trim();
    const uris = redirectUris.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!name || uris.length === 0) return;
    setCreating(true);
    try {
      const r = await api.post<{ clientId: string; clientSecret: string }>(
        '/api/oauth/clients',
        {
          name,
          grantTypes: ['authorization_code', 'refresh_token'],
          scopes: connScopes,
          redirectUris: uris,
          public: false,
        },
      );
      setNewClientId(r.clientId);
      setNewSecret(r.clientSecret);
      setCredFrom('connector');
      setConnName('');
      setRedirectUris('');
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setCreating(false);
    }
  }

  function toggleScope(scope: string) {
    setNewScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function toggleConnScope(scope: string) {
    setConnScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  // Same rule the backend sweep uses (no live refresh token, not a
  // client_credentials client, older than the grace window), so the count on
  // the button matches what it removes.
  const UNUSED_GRACE_MS = 60 * 60 * 1000;
  const isDead = (c: Client) =>
    !c.hasLiveGrant
    && !c.grantTypes.includes('client_credentials')
    && Date.now() - new Date(c.createdAt).getTime() > UNUSED_GRACE_MS;
  const unusedCount = (clients ?? []).filter(isDead).length;

  async function cleanUpUnused() {
    setPending(null);
    try {
      await api.delete<{ revoked: number }>('/api/oauth/clients/unused');
      await load();
    } catch (e) {
      handleFetchError(e);
    }
  }

  async function revoke(id: string) {
    setPending(null);
    try {
      await api.delete(`/api/oauth/clients/${id}`);
      await load();
    } catch (e) {
      handleFetchError(e);
    }
  }

  const codeBox: React.CSSProperties = {
    display: 'block',
    wordBreak: 'break-all',
    padding: '6px 8px',
    borderRadius: 4,
    background: 'var(--bg-soft)',
    border: '1px solid var(--border)',
  };

  // Rendered under whichever form minted it. The secret is unrecoverable after
  // dismissal — only the bcrypt hash is stored — hence the one-shot warning.
  const credentialPanel = newSecret && (
    <div
      role="alert"
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--warn)',
        background: 'var(--warn-soft, rgba(255, 196, 0, 0.08))',
        fontSize: 13,
      }}
    >
      {newClientId && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('connectorsClientIdLabel')}</div>
          <code className="mono" style={codeBox}>{newClientId}</code>
          <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={copyClientId}>
            {idCopied ? t('connectorsCopied') : t('connectorsCopy')}
          </button>
        </div>
      )}
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('connectorsSecretOnce')}</div>
      <code className="mono" style={codeBox}>{newSecret}</code>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn sm" onClick={copySecret}>
          {copied ? t('connectorsCopied') : t('connectorsCopy')}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => { setNewSecret(null); setNewClientId(null); setCredFrom(null); }}
        >
          {t('connectorsSecretDismiss')}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="settings-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('connectorsTab')}
          </h2>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>
            {t('connectorsSub')}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsMcpTitle')}</div>
            <div className="card-sub">{t('connectorsMcpSub')}</div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)', marginBottom: 6 }}>
            {t('connectorsMcpUrlLabel')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <code
              className="mono"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                wordBreak: 'break-all',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--bg-soft)',
                border: '1px solid var(--border)',
                fontSize: 13,
              }}
            >
              {mcpUrl}
            </code>
            <button type="button" className="btn sm" onClick={copyMcpUrl}>
              {urlCopied ? t('connectorsCopied') : t('connectorsCopy')}
            </button>
          </div>
          <ol style={{ margin: '14px 0 0', paddingLeft: 20, fontSize: 13, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
            <li>{t('connectorsMcpStep1')}</li>
            <li>{t('connectorsMcpStep2')}</li>
            <li>{t('connectorsMcpStep3')}</li>
            <li>{t('connectorsMcpStep4')}</li>
          </ol>
          <div className="so-tip" style={{ marginTop: 14 }}>
            <span>{t('connectorsMcpNote')}</span>
          </div>
        </div>
      </div>

      {!dcrOpen && (
      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsAddConnectorTitle')}</div>
            <div className="card-sub">{t('connectorsAddConnectorSub')}</div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gap: 14, maxWidth: 560 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label
                htmlFor="conn-name"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)' }}
              >
                {t('connectorsNameLabel')}
              </label>
              <input
                id="conn-name"
                className="input mono"
                placeholder="Claude"
                value={connName}
                onChange={(e) => setConnName(e.target.value)}
                disabled={creating}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label
                htmlFor="conn-redirects"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)' }}
              >
                {t('connectorsRedirectLabel')}
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {REDIRECT_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="btn sm ghost"
                    disabled={creating}
                    onClick={() => setRedirectUris(p.uris.join('\n'))}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
              <textarea
                id="conn-redirects"
                className="input mono"
                rows={3}
                style={{ resize: 'vertical' }}
                placeholder="https://claude.ai/api/mcp/auth_callback"
                value={redirectUris}
                onChange={(e) => setRedirectUris(e.target.value)}
                disabled={creating}
              />
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                {t('connectorsRedirectHelp')}
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)' }}>
                {t('connectorsScopeLabel')}
              </span>
              <div style={{ display: 'grid', gap: 8, marginTop: 2 }}>
                {SCOPE_OPTIONS.map(({ scope, labelKey }) => (
                  <label
                    key={scope}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: creating ? 'default' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={connScopes.includes(scope)}
                      onChange={() => toggleConnScope(scope)}
                      disabled={creating}
                    />
                    {t(labelKey)}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <button
                type="button"
                className="btn accent"
                onClick={createConnectorClient}
                disabled={creating || !connName.trim() || !redirectUris.trim() || connScopes.length === 0}
              >
                {t('connectorsCreateConnector')}
              </button>
            </div>
          </div>
          {credFrom === 'connector' && credentialPanel}
        </div>
      </div>
      )}

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsAddServiceTitle')}</div>
            <div className="card-sub">{t('connectorsAddServiceSub')}</div>
          </div>
          <button
            type="button"
            className="btn sm"
            aria-expanded={serviceOpen}
            onClick={() => setServiceOpen(o => !o)}
            style={{ whiteSpace: 'nowrap' }}
          >
            {serviceOpen ? t('connectorsHide') : t('connectorsShow')}
            <Icon name={serviceOpen ? 'chevronUp' : 'chevronDown'} size={12} />
          </button>
        </div>
        {serviceOpen && (
        <div className="card-body">
          <div style={{ display: 'grid', gap: 14, maxWidth: 560 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label
                htmlFor="connector-name"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)' }}
              >
                {t('connectorsNameLabel')}
              </label>
              <input
                id="connector-name"
                className="input mono"
                placeholder={t('connectorsNamePlaceholder')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createServiceClient(); }}
                disabled={creating}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-subtle)' }}>
                {t('connectorsScopeLabel')}
              </span>
              <div style={{ display: 'grid', gap: 8, marginTop: 2 }}>
                {SCOPE_OPTIONS.map(({ scope, labelKey }) => (
                  <label
                    key={scope}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: creating ? 'default' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={newScopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      disabled={creating}
                    />
                    {t(labelKey)}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <button
                type="button"
                className="btn accent"
                onClick={createServiceClient}
                disabled={creating || !newName.trim() || newScopes.length === 0}
              >
                {t('connectorsCreate')}
              </button>
            </div>
          </div>
          {credFrom === 'service' && credentialPanel}
        </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsListTitle')}</div>
          </div>
          {unusedCount > 0 && (
            <button type="button" className="btn sm" onClick={() => setPending({ kind: 'cleanup' })} style={{ whiteSpace: 'nowrap' }}>
              {t('connectorsCleanupBtn', { n: unusedCount })}
            </button>
          )}
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="data-table members-table">
            <thead>
              <tr>
                <th>{t('connectorsHeaderName')}</th>
                <th>{t('connectorsHeaderScopes')}</th>
                <th>{t('connectorsHeaderGrants')}</th>
                <th>{t('connectorsHeaderCreated')}</th>
                <th>{t('connectorsHeaderLastUsed')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients?.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: 13.5 }}>{c.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{c.id}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.scopes.join(' ') || '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.grantTypes.join(' ') || '—'}</td>
                  <td style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                    {new Date(c.createdAt).toLocaleString(locale)}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                    {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString(locale) : t('connectorsNever')}
                    {/* Why the cleanup button counts a row that has a date on it. */}
                    {c.lastUsedAt && isDead(c) && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                        {t('connectorsNoLiveGrant')}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ color: 'var(--neg)' }}
                      onClick={() => setPending({ kind: 'revoke', id: c.id })}
                    >
                      {t('connectorsRevoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clients && clients.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
              {t('connectorsEmpty')}
            </div>
          )}
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'cleanup'
            ? t('connectorsCleanupTitle', { n: unusedCount })
            : t('connectorsRevokeTitle')}
          message={pending.kind === 'cleanup'
            ? t('connectorsCleanupConfirm')
            : t('connectorsRevokeConfirm')}
          confirmLabel={t('connectorsRevoke')}
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => (pending.kind === 'cleanup' ? cleanUpUnused() : revoke(pending.id))}
        />
      )}
    </>
  );
}
