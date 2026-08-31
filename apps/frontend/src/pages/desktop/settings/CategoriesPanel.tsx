import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { useAuth } from '../../../lib/auth';
import { itemTypes, addItemType } from '../../../lib/lookups';
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
              {c.id === 'Other' && <ItemTypesOption enabled={c.enabled} />}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Item types ───────────────────────────────────────────────────────────────
// The `Other` line vocabulary (migration 0082). It belongs to that one
// category, so it lives inside the Other row rather than as a page-level
// section — a dozen types would otherwise dominate a page about categories.
// Collapsed by default: purchasers grow this list from the line drawer, and a
// manager only opens it to rename or retire something.
type TypeRow = { id: string; name: string; active: boolean; uses: number };

function ItemTypesOption({ enabled }: { enabled: boolean }) {
  const { t } = useT();
  const { user } = useAuth();
  const [rows, setRows] = useState<TypeRow[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const isManager = user?.role === 'manager';

  const reload = () =>
    api.get<{ items: TypeRow[] }>('/api/item-types')
      .then(r => setRows(r.items))
      .catch(handleFetchError);
  useEffect(() => { if (isManager) reload(); }, [isManager]);

  if (!isManager) return null;

  const persist = (row: TypeRow, body: Record<string, unknown>) =>
    api.patch<TypeRow>(`/api/item-types/${row.id}`, body)
      .then(updated => {
        setRows(p => p.map(r => r.id === row.id ? { ...r, ...updated } : r));
        // The picker reads the boot cache, so keep it in step with the rename
        // rather than making everyone reload to see it.
        if (updated.name !== row.name) {
          const cached = itemTypes.find(l => l.id === row.id);
          if (cached) cached.name = updated.name;
          else addItemType({ id: updated.id, name: updated.name });
        }
      })
      .catch(err => { handleFetchError(err); reload(); });

  const rename = (row: TypeRow) => {
    const next = (draft[row.id] ?? row.name).trim();
    setDraft(d => { const { [row.id]: _drop, ...rest } = d; return rest; });
    if (!next || next === row.name) return;
    persist(row, { name: next });
  };

  const activeCount = rows.filter(r => r.active).length;

  return (
    <>
      <div className="cat-opt">
        <div>
          <div className="cat-opt-label">{t('itPanelTitle')}</div>
          <div className="cat-opt-sub">{t('itPanelSub')}</div>
        </div>
        <button
          className="btn sm"
          disabled={!enabled}
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          style={{ whiteSpace: 'nowrap' }}
        >
          {t('itCount', { n: activeCount })}
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
        </button>
      </div>
      {open && (
        <div style={{ gridColumn: '1 / -1', padding: '0 0 4px 0' }}>
          <div className="cat-opt-sub" style={{ marginBottom: 8 }}>{t('itEditHint')}</div>
          {rows.map(r => (
            <div
              key={r.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
                borderTop: '1px solid var(--border)', opacity: r.active ? 1 : 0.55,
              }}
            >
              <input
                className="input"
                value={draft[r.id] ?? r.name}
                onChange={e => setDraft(d => ({ ...d, [r.id]: e.target.value }))}
                onBlur={() => rename(r)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                style={{ flex: 1, minWidth: 0, maxWidth: 240, padding: '4px 8px', fontSize: 13 }}
              />
              <span
                className="muted"
                style={{ fontSize: 11.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
              >
                {t('itUses', { n: r.uses })}
              </span>
              <Toggle checked={r.active} onChange={(v) => persist(r, { active: v })} />
            </div>
          ))}
          {rows.length === 0 && (
            <div className="cat-opt-sub">{t('itPanelEmpty')}</div>
          )}
        </div>
      )}
    </>
  );
}
