import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { SettingsHeader, Toggle } from './_shared';

// ─── Categories ───────────────────────────────────────────────────────────────
// Server-backed via /api/categories (migration 0013). The list, toggles, and
// default margin persist; changes are optimistic and resync from the server
// on failure.
type CategoryRow = {
  id: string;
  label: string;
  icon: IconName;
  enabled: boolean;
  aiCapture: boolean;
  requiresPN: boolean;
  defaultMargin: number;
};
type CategoryApi = {
  id: string; label: string; icon: string; enabled: boolean;
  ai_capture: boolean; requires_pn: boolean; default_margin: number; position: number;
};

export function CategoriesPanel() {
  const { t } = useT();
  const [cats, setCats] = useState<CategoryRow[]>([]);

  const reload = () =>
    api.get<{ items: CategoryApi[] }>('/api/categories')
      .then(r => setCats(r.items.map(c => ({
        id: c.id, label: c.label, icon: c.icon as IconName, enabled: c.enabled,
        aiCapture: c.ai_capture, requiresPN: c.requires_pn, defaultMargin: c.default_margin,
      }))))
      .catch(handleFetchError);
  useEffect(() => { reload(); }, []);

  const upd = (id: string, patch: Partial<CategoryRow>) =>
    setCats(p => p.map(c => c.id === id ? { ...c, ...patch } : c));

  // Optimistic update already applied by the caller; on PATCH failure we
  // surface the error AND resync from the server so the user sees the revert.
  const persist = (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/categories/${id}`, body).catch(err => {
      handleFetchError(err);
      reload();
    });

  return (
    <>
      <SettingsHeader
        title={t('catPanelTitle')}
        sub={t('catPanelSub')}
        actions={<button className="btn"><Icon name="plus" size={14} /> {t('catAddBtn')}</button>}
      />

      <div className="cat-list">
        {cats.map(c => (
          <div key={c.id} className={'cat-row card' + (c.enabled ? '' : ' disabled')}>
            <div className="cat-row-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="cat-icon"><Icon name={c.icon} size={18} /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {c.enabled ? t('catAvailable') : t('catHidden')}
                  </div>
                </div>
              </div>
              <Toggle checked={c.enabled} onChange={(v) => { upd(c.id, { enabled: v }); persist(c.id, { enabled: v }); }} />
            </div>

            <div className="cat-row-body">
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">{t('aiLabelCapture')}</div>
                  <div className="cat-opt-sub">{t('catAiCaptureDesc')}</div>
                </div>
                <Toggle checked={c.aiCapture} onChange={(v) => { upd(c.id, { aiCapture: v }); persist(c.id, { aiCapture: v }); }} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">{t('catRequirePN')}</div>
                  <div className="cat-opt-sub">{t('catRequirePNDesc')}</div>
                </div>
                <Toggle checked={c.requiresPN} onChange={(v) => { upd(c.id, { requiresPN: v }); persist(c.id, { requiresPn: v }); }} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">{t('catDefaultMargin')}</div>
                  <div className="cat-opt-sub">{t('catDefaultMarginDesc')}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    value={c.defaultMargin}
                    onChange={(e) => upd(c.id, { defaultMargin: Number(e.target.value) })}
                    onBlur={() => persist(c.id, { defaultMargin: c.defaultMargin })}
                    disabled={!c.enabled}
                    style={{
                      width: 60, padding: '5px 8px', borderRadius: 6,
                      border: '1px solid var(--border)', background: 'var(--bg-elev)',
                      fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                    }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>%</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
