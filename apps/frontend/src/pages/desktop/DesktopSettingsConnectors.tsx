import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';

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
};

export function DesktopSettingsConnectors() {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [clients, setClients] = useState<Client[] | null>(null);
  const [newName, setNewName] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);

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

  async function copyMcpUrl() {
    await navigator.clipboard.writeText(mcpUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 1500);
  }

  const load = () =>
    api.get<{ clients: Client[] }>('/api/oauth/clients')
      .then((r) => setClients(r.clients))
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
          scopes: ['market:write'],
          public: false,
        },
      );
      setNewSecret(r.clientSecret);
      setNewName('');
      await load();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm(t('connectorsRevokeConfirm'))) return;
    try {
      await api.delete(`/api/oauth/clients/${id}`);
      await load();
    } catch (e) {
      handleFetchError(e);
    }
  }

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

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsAddServiceTitle')}</div>
            <div className="card-sub">{t('connectorsAddServiceSub')}</div>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              placeholder={t('connectorsNamePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createServiceClient(); }}
              disabled={creating}
            />
            <button
              type="button"
              className="btn accent"
              onClick={createServiceClient}
              disabled={creating || !newName.trim()}
            >
              {t('connectorsCreate')}
            </button>
          </div>
          {newSecret && (
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
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('connectorsSecretOnce')}</div>
              <code
                className="mono"
                style={{
                  display: 'block',
                  wordBreak: 'break-all',
                  padding: '6px 8px',
                  borderRadius: 4,
                  background: 'var(--bg-soft)',
                  border: '1px solid var(--border)',
                }}
              >
                {newSecret}
              </code>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={copySecret}
                >
                  {copied ? t('connectorsCopied') : t('connectorsCopy')}
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => setNewSecret(null)}
                >
                  {t('connectorsSecretDismiss')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('connectorsListTitle')}</div>
          </div>
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
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn sm ghost"
                      style={{ color: 'var(--neg)' }}
                      onClick={() => revoke(c.id)}
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
    </>
  );
}
