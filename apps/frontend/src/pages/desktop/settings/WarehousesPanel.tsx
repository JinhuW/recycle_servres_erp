import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import type { Warehouse } from '../../../lib/types';
import { SettingsHeader, Toggle, type Member, type ToastFn } from './_shared';

// ─── Warehouses ───────────────────────────────────────────────────────────────
type WarehouseRow = Warehouse & { active: boolean; receiving: boolean };

const TIMEZONE_FALLBACK = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/Amsterdam', 'Europe/London', 'Asia/Hong_Kong', 'Asia/Tokyo',
];

function listTimezones(): string[] {
  try {
    const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') return fn('timeZone');
  } catch { /* fall through */ }
  return TIMEZONE_FALLBACK;
}

export function WarehousesPanel({ showToast }: { showToast: ToastFn }) {
  const { t } = useT();
  const [whs, setWhs] = useState<WarehouseRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [modalWh, setModalWh] = useState<Warehouse | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => api.get<{ items: Warehouse[] }>('/api/warehouses')
    .then(r => {
      setWhs(r.items.map(w => ({
        ...w,
        active: w.active ?? true,
        receiving: w.short !== 'HK',
      })));
    })
    .catch(handleFetchError)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const updateRow = (id: string, patch: Partial<WarehouseRow>) =>
    setWhs(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w));

  // Persist the active flag. Archiving (active=false) removes the warehouse
  // from every UI surface — GET /api/warehouses no longer returns it — so we
  // reload and the card drops out of the list. There is no in-app un-archive
  // by design; reactivation is a direct DB edit.
  const setActive = async (id: string, active: boolean) => {
    updateRow(id, { active }); // optimistic
    try {
      await api.patch(`/api/warehouses/${id}`, { active });
      showToast?.(active ? t('whReactivated') : t('whArchived'));
      reload();
    } catch (e) {
      showToast?.((e as { message?: string })?.message ?? t('whUpdateFailed'), 'error');
      reload();
    }
  };

  return (
    <>
      <SettingsHeader
        title={t('whPanelTitle')}
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> {t('whAddBtn')}
          </button>
        }
      />

      <div className="wh-grid">
        {!loadedOnce && Array.from({ length: 3 }).map((_, i) => (
          <div key={`sk-${i}`} className="card wh-card">
            <div className="wh-card-head">
              <div className="wh-card-id">
                <span className="skeleton" style={{ width: 32, height: 32, borderRadius: 8, display: 'inline-block' }} aria-hidden />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="skeleton" style={{ width: '60%', height: 14, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                  <span className="skeleton" style={{ width: '40%', height: 11, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                </div>
              </div>
            </div>
            <div className="wh-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
              <span className="skeleton" style={{ width: '100%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '85%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '70%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
            </div>
          </div>
        ))}
        {whs.map(w => {
          return (
            <div key={w.id} className={'card wh-card' + (w.active ? '' : ' archived')}>
              <div className="wh-card-head">
                <div className="wh-card-id">
                  <div className="wh-icon"><Icon name="warehouse" size={16} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="wh-card-name">{w.name ?? w.short}</div>
                    <div className="wh-card-region">{w.region} · {w.short}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn icon sm ghost"
                    onClick={() => setModalWh(w)}
                    title={t('whOpenEditor')}
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    <Icon name="settings" size={13} />
                  </button>
                </div>
              </div>

              <div className="wh-card-body">
                {w.address && (
                  <div className="wh-row">
                    <span className="wh-row-label">{t('whAddress')}</span>
                    <span className="wh-row-val">{w.address}</span>
                  </div>
                )}
                {w.manager && (
                  <div className="wh-row">
                    <span className="wh-row-label">{t('whManager')}</span>
                    <span className="wh-row-val">{w.manager}</span>
                  </div>
                )}
                {w.timezone && (
                  <div className="wh-row">
                    <span className="wh-row-label">{t('whTimezone')}</span>
                    <span className="wh-row-val mono" style={{ fontSize: 12.5 }}>{w.timezone}</span>
                  </div>
                )}
              </div>

              <div className="wh-card-foot">
                <div className="toggle-row">
                  <span>{t('whActive')}</span>
                  <Toggle checked={w.active} onChange={(v) => setActive(w.id, v)} />
                </div>
                <div className="toggle-row" title={t('whReceivingNote')}>
                  <span>{t('whAcceptingReceipts')}</span>
                  <Toggle
                    checked={w.receiving}
                    onChange={() => { /* not persisted: no backend field yet */ }}
                    disabled
                  />
                </div>
              </div>
            </div>
          );
        })}

        <button type="button" className="card wh-add" onClick={() => setCreating(true)}>
          <div className="wh-add-icon"><Icon name="plus" size={20} /></div>
          <div className="wh-add-text">
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t('whAddBtn')}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('whAddSub')}</div>
          </div>
        </button>
      </div>

      {(modalWh || creating) && (
        <WarehouseEditModal
          warehouse={modalWh}
          others={whs.filter(w => w.id !== modalWh?.id)}
          onClose={() => { setModalWh(null); setCreating(false); }}
          onSaved={(msg) => { setModalWh(null); setCreating(false); reload(); showToast?.(msg); }}
          onError={(msg) => showToast?.(msg, 'error')}
        />
      )}
    </>
  );
}

function WarehouseEditModal({
  warehouse, others, onClose, onSaved, onError,
}: {
  warehouse: Warehouse | null;
  others: Warehouse[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  const isNew = !warehouse;
  type Draft = {
    name: string; short: string; region: string;
    address: string; managerUserId: string;
    timezone: string;
  };
  const [draft, setDraft] = useState<Draft>({
    name: warehouse?.name ?? '',
    short: warehouse?.short ?? '',
    region: warehouse?.region ?? '',
    address: warehouse?.address ?? '',
    managerUserId: warehouse?.managerUserId ?? '',
    timezone: warehouse?.timezone ?? '',
  });
  // Manager dropdown is sourced from the DB (users with role=manager).
  const [managers, setManagers] = useState<Member[]>([]);
  useEffect(() => {
    api.get<{ items: Member[] }>('/api/members')
      .then(r => setManagers(r.items.filter(m => m.role === 'manager' && m.active)))
      .catch(handleFetchError);
  }, []);
  const selectedMgr = managers.find(m => m.id === draft.managerUserId) ?? null;
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [transferTo, setTransferTo] = useState<string>('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }));

  const timezones = useMemo(() => listTimezones(), []);

  const canSave = draft.name.trim() && draft.short.trim() && draft.region.trim();

  const save = async () => {
    setSaving(true);
    try {
      const clean = (s: string) => {
        const t = s.trim();
        return t === '' ? null : t;
      };
      const body = {
        name: draft.name.trim(),
        short: draft.short.trim(),
        region: draft.region.trim(),
        address: clean(draft.address),
        managerUserId: draft.managerUserId || null,
        timezone: clean(draft.timezone),
      };
      if (isNew) await api.post('/api/warehouses', body);
      else       await api.patch(`/api/warehouses/${warehouse!.id}`, body);
      onSaved(isNew ? t('whCreated') : t('whSaved'));
    } catch (e) {
      onError((e as { message?: string })?.message ?? t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!warehouse) return;
    setDeleting(true);
    try {
      const qs = transferTo ? `?transferTo=${encodeURIComponent(transferTo)}` : '';
      await api.delete(`/api/warehouses/${warehouse.id}${qs}`);
      onSaved(t('whDeleted'));
    } catch (e) {
      onError((e as { message?: string })?.message ?? t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{isNew ? t('whNewTitle') : t('whEditTitle')}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whFieldName')}</label>
              <input className="input" value={draft.name} onChange={e => set('name', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whFieldShortCode')}</label>
              <input
                className="input mono"
                value={draft.short}
                onChange={e => set('short', e.target.value.toUpperCase())}
                placeholder={t('whShortCodePh')}
              />
            </div>
            <div className="field">
              <label className="label">{t('whFieldRegion')}</label>
              <input className="input" value={draft.region} onChange={e => set('region', e.target.value)} placeholder={t('whRegionPh')} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whAddress')}</label>
              <textarea
                className="input"
                rows={3}
                value={draft.address}
                onChange={e => set('address', e.target.value)}
                placeholder={t('whAddressPh')}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whManager')}</label>
              <select
                className="input"
                value={draft.managerUserId}
                onChange={e => set('managerUserId', e.target.value)}
              >
                <option value="">{t('whNoManager')}</option>
                {managers.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                {draft.managerUserId && !managers.some(m => m.id === draft.managerUserId) && (
                  <option value={draft.managerUserId}>
                    {warehouse?.manager ?? t('whCurrentManager')}
                  </option>
                )}
              </select>
            </div>
          </div>
          {/* Contact details are derived from the selected manager's user
              record — read-only, single source of truth in the DB. */}
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whManagerPhone')}</label>
              <input className="input" value={selectedMgr?.phone ?? '—'} readOnly disabled />
            </div>
            <div className="field">
              <label className="label">{t('whManagerEmail')}</label>
              <input className="input" value={selectedMgr?.email ?? '—'} readOnly disabled />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">{t('whTimezone')}</label>
              <select
                className="input"
                value={draft.timezone}
                onChange={e => set('timezone', e.target.value)}
              >
                <option value="">{t('whNone')}</option>
                {timezones.map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </div>
          {!isNew && (
            <div className="field-row">
              <div className="field">
                <label className="label">{t('whFieldId')}</label>
                <input className="input mono" value={warehouse!.id} disabled />
              </div>
            </div>
          )}
          {!isNew && confirmingDelete && (
            <div
              style={{
                marginTop: 12, padding: 12, borderRadius: 6,
                border: '1px solid var(--neg)', background: 'var(--bg-elev)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {t('whDeleteConfirmTitle', { name: warehouse!.name ?? warehouse!.short })}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginBottom: 10 }}>
                {t('whDeleteConfirmSub')}
              </div>
              <div className="field">
                <label className="label">{t('whMoveInventoryTo')}</label>
                <select
                  className="input"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                >
                  <option value="">{t('whMoveInventoryClear')}</option>
                  {others.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name ?? w.short} · {w.region}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <div>
            {!isNew && !confirmingDelete && (
              <button
                className="btn"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting || saving}
                style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
              >
                {t('delete')}
              </button>
            )}
            {!isNew && confirmingDelete && (
              <button
                className="btn"
                onClick={() => { setConfirmingDelete(false); setTransferTo(''); }}
                disabled={deleting}
              >
                {t('back')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {confirmingDelete ? (
              <button
                className="btn primary"
                onClick={remove}
                disabled={deleting}
                style={{ background: 'var(--neg)', borderColor: 'var(--neg)' }}
              >
                {deleting ? '…' : t('whConfirmDelete')}
              </button>
            ) : (
              <>
                <button className="btn" onClick={onClose}>{t('cancel')}</button>
                <button className="btn primary" onClick={save} disabled={saving || deleting || !canSave}>
                  {saving ? '…' : t('save')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
