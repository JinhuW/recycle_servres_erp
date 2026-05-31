import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useAuth } from '../../../lib/auth';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { useEscapeKey } from '../../../lib/useEscapeKey';
import { relTime } from '../../../lib/format';
import { TableSkeleton } from '../../../components/Skeleton';
import { SettingsHeader, lastSeenLabel, type Member, type ToastFn } from './_shared';
import { PasswordMeter } from '../../../components/PasswordMeter';
import { pwStrengthLabels } from '../../../lib/passwordI18n';
import { ConfirmDialog } from './dialogs';
import { useT } from '../../../lib/i18n';

// ─── Members ──────────────────────────────────────────────────────────────────
export function MembersPanel({ showToast }: { showToast: ToastFn }) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [members, setMembers] = useState<Member[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const { user: currentUser } = useAuth();
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const pending = useMemo(
    () => members.filter(m => m.active && !m.last_seen_at),
    [members],
  );
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'manager' | 'purchaser'>('all');
  const [showArchived, setShowArchived] = useState(false);

  const reload = () => api.get<{ items: Member[] }>('/api/members')
    .then(r => setMembers(r.items))
    .catch(handleFetchError)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const removeMember = async (m: Member) => {
    try {
      await api.delete(`/api/members/${m.id}`);
      setRemoving(null);
      reload();
      showToast?.(t('memRemovedToast', { name: m.name }));
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : t('memRemoveFailed'), 'error');
    }
  };

  const visible = useMemo(
    () => (showArchived ? members : members.filter(m => m.active)),
    [members, showArchived],
  );
  const archivedCount = useMemo(() => members.filter(m => !m.active).length, [members]);

  const filtered = useMemo(() => visible.filter(m => {
    if (roleFilter !== 'all' && m.role !== roleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!m.name.toLowerCase().includes(q) && !m.email.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [visible, roleFilter, search]);

  const counts = {
    all: visible.length,
    manager: visible.filter(m => m.role === 'manager').length,
    purchaser: visible.filter(m => m.role === 'purchaser').length,
  };

  return (
    <>
      <SettingsHeader
        title={t('memPanelTitle')}
        sub={t('memPanelSub', {
          active: members.length - archivedCount,
          archived: archivedCount,
          pending: pending.length,
        })}
        actions={
          <button className="btn accent" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} /> {t('memInviteBtn')}
          </button>
        }
      />

      <div className="settings-row">
        <div className="seg">
          {([
            { v: 'all', label: t('all'), count: counts.all },
            { v: 'manager', label: t('memManagers'), count: counts.manager },
            { v: 'purchaser', label: t('memPurchasers'), count: counts.purchaser },
          ] as const).map(o => (
            <button key={o.v} className={roleFilter === o.v ? 'active' : ''} onClick={() => setRoleFilter(o.v)}>
              {o.label} <span style={{ opacity: 0.55, marginLeft: 4 }}>{o.count}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label
            className="archived-toggle"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 13, color: 'var(--fg-muted)', cursor: 'pointer', userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            {t('showArchivedBtn')}
            {archivedCount > 0 && (
              <span style={{ opacity: 0.55, marginLeft: 2 }}>{archivedCount}</span>
            )}
          </label>
          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              placeholder={t('memSearchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card pending-card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('memPendingTitle')}</div>
              <div className="card-sub">{t('memPendingSub')}</div>
            </div>
          </div>
          <div className="invite-list">
            {pending.map(inv => (
              <div key={inv.id} className="invite-row">
                <div className="invite-avatar muted"><Icon name="mail" size={14} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13.5 }}>{inv.email}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {inv.role === 'manager' ? t('role_manager') : t('role_purchaser')} · {t('memAddedNotSignedIn', { rel: relTime(inv.created_at, locale) })}
                  </div>
                </div>
                <button
                  className="btn sm ghost"
                  onClick={() => showToast?.(t('memResendNotImpl'), 'error')}
                >
                  {t('memResend')}
                </button>
                <button
                  className="btn sm ghost"
                  style={{ color: 'var(--neg)' }}
                  onClick={() => removeMember(inv)}
                >
                  {t('memRevoke')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        {!loadedOnce ? (
          <TableSkeleton rows={5} cols={4} />
        ) : (
        <table className="data-table members-table">
          <thead>
            <tr>
              <th>{t('memColMember')}</th>
              <th>{t('role')}</th>
              <th>{t('memColLastActive')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => {
              const isMe = m.email === currentUser?.email;
              return (
                <tr key={m.id} style={m.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <div className="member-cell">
                      <div className="avatar md">{m.initials}</div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {m.name}
                          {isMe && <span className="chip muted" style={{ fontSize: 10 }}>{t('memYouChip')}</span>}
                          {!m.active && <span className="chip muted" style={{ fontSize: 10 }}>{t('memInactiveChip')}</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={'chip ' + (m.role === 'manager' ? 'accent' : 'muted')}>
                      {m.role === 'manager' ? t('role_manager') : t('role_purchaser')}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{lastSeenLabel(m, locale)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      <button
                        className="btn icon sm ghost"
                        title={t('memEditMember')}
                        onClick={() => setEditing(m)}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      {!isMe && m.active && (
                        <button
                          className="btn icon sm ghost"
                          title={t('memRemoveFromWorkspace')}
                          onClick={() => setRemoving(m)}
                          style={{ color: 'var(--neg)' }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {loadedOnce && filtered.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('memNoMatch')}
          </div>
        )}

        {editing && (
          <MemberEditModal
            member={editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); reload(); showToast?.(t('memUpdatedToast')); }}
          />
        )}

        {inviting && (
          <InviteMemberModal
            existing={members}
            onClose={() => setInviting(false)}
            onInvited={(name) => { setInviting(false); reload(); showToast?.(t('memAddedToast', { name })); }}
            onError={(msg) => showToast?.(msg, 'error')}
          />
        )}

        {removing && (
          <ConfirmDialog
            title={t('memRemoveTitle', { name: removing.name })}
            message={t('memRemoveBody')}
            confirmLabel={t('memRemoveBtn')}
            danger
            onCancel={() => setRemoving(null)}
            onConfirm={() => removeMember(removing)}
          />
        )}
      </div>
    </>
  );
}

// RFC-5322 lite: local + @ + domain.tld, no whitespace, tld 2+ chars.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function InviteMemberModal({
  existing, onClose, onInvited, onError,
}: {
  existing: Member[];
  onClose: () => void;
  onInvited: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState({
    name: '', email: '', role: 'purchaser' as 'manager' | 'purchaser',
    phone: '',
  });
  const [saving, setSaving] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => setDraft(p => ({ ...p, [k]: v }));

  const emailTrimmed = draft.email.trim().toLowerCase();
  const emailCheck = useMemo<{ state: 'empty' | 'invalid' | 'duplicate' | 'ok'; msg?: string }>(() => {
    if (!emailTrimmed) return { state: 'empty' };
    if (!EMAIL_RE.test(emailTrimmed)) return { state: 'invalid', msg: t('memEmailInvalid') };
    const dup = existing.find(m => m.email.toLowerCase() === emailTrimmed);
    if (dup) {
      return {
        state: 'duplicate',
        msg: dup.active
          ? t('memEmailDupActive', { name: dup.name })
          : t('memEmailDupArchived', { name: dup.name }),
      };
    }
    return { state: 'ok', msg: t('memEmailOk') };
  }, [emailTrimmed, existing, t]);

  const canSave = draft.name.trim() && emailCheck.state === 'ok' && !saving;

  const submit = async () => {
    setSaving(true);
    try {
      const res = await api.post<{ id: string; password: string }>('/api/members', {
        name: draft.name.trim(),
        email: emailTrimmed,
        role: draft.role,
        phone: draft.phone.trim() || undefined,
      });
      setTempPassword(res.password);
      setCreatedName(draft.name.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : t('memInviteFailed'));
    } finally {
      setSaving(false);
    }
  };

  useEscapeKey(onClose);

  if (tempPassword) {
    return (
      <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onInvited(createdName); }}>
        <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'var(--pos-soft)', color: 'var(--pos)',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <Icon name="check" size={18} />
              </div>
              <div>
                <div className="modal-title">{t('memAddedModalTitle', { name: createdName })}</div>
                <div className="modal-sub">{t('memTempPwSub')}</div>
              </div>
            </div>
          </div>
          <div className="modal-body">
            <div className="field">
              <label className="label">{t('memTempPwLabel')}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" readOnly value={tempPassword} style={{ flex: 1 }} />
                <button
                  className="btn"
                  onClick={() => { navigator.clipboard?.writeText(tempPassword); }}
                  title={t('memCopyToClipboard')}
                >
                  <Icon name="paperclip" size={13} /> {t('connectorsCopy')}
                </button>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => onInvited(createdName)}>{t('done')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t('memInviteBtn')}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label className="label">{t('memFieldFullName')}</label>
              <input
                className="input"
                value={draft.name}
                onChange={e => set('name', e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label">{t('custFieldContactPhone')}</label>
              <input
                className="input"
                value={draft.phone}
                onChange={e => set('phone', e.target.value)}
              />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">
                {t('memFieldEmail')}
                {emailCheck.state === 'ok' && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--pos)', fontWeight: 500 }}>
                    <Icon name="check" size={12} /> {t('memEmailValid')}
                  </span>
                )}
                {(emailCheck.state === 'invalid' || emailCheck.state === 'duplicate') && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--neg)', fontWeight: 500 }}>
                    <Icon name="x" size={12} /> {emailCheck.state === 'duplicate' ? t('memEmailAlreadyUsed') : t('memEmailInvalidBadge')}
                  </span>
                )}
              </label>
              <input
                className="input"
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={draft.email}
                onChange={e => set('email', e.target.value)}
                style={
                  emailCheck.state === 'invalid' || emailCheck.state === 'duplicate'
                    ? { borderColor: 'var(--neg)' }
                    : undefined
                }
              />
              {emailCheck.msg && (
                <div
                  className="help"
                  style={{
                    color:
                      emailCheck.state === 'ok'
                        ? 'var(--pos)'
                        : emailCheck.state === 'empty'
                          ? 'var(--fg-subtle)'
                          : 'var(--neg)',
                  }}
                >
                  {emailCheck.msg}
                </div>
              )}
            </div>
          </div>
          <div className="role-picker" style={{ marginTop: 12 }}>
            {(['manager', 'purchaser'] as const).map(r => (
              <label key={r} className={'role-card ' + (draft.role === r ? 'active' : '')}>
                <input
                  type="radio"
                  name="invite-role"
                  value={r}
                  checked={draft.role === r}
                  onChange={() => set('role', r)}
                />
                <div className="role-card-body">
                  <div className="role-card-title">{r === 'manager' ? t('role_manager') : t('role_purchaser')}</div>
                  <div className="role-card-desc">
                    {r === 'manager' ? t('memRoleMgrDesc') : t('memRolePurchDesc')}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={submit} disabled={!canSave}>
            {saving ? '…' : t('memSendInvite')}
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberEditModal({ member, onClose, onSaved }: { member: Member; onClose: () => void; onSaved: () => void }) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [draft, setDraft] = useState<Partial<Member>>({});
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<'profile' | 'role' | 'security'>('profile');

  const v = <K extends keyof Member>(k: K): Member[K] =>
    (k in draft ? (draft as Member)[k] : member[k]);
  const set = <K extends keyof Member>(k: K, value: Member[K]) =>
    setDraft(prev => ({ ...prev, [k]: value }));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/members/${member.id}`, {
        name: draft.name, team: draft.team, phone: draft.phone, title: draft.title,
        role: draft.role, active: draft.active,
        password: password || undefined,
      });
      onSaved();
    } catch (e) {
      // Keep the modal open and surface the failure instead of silently
      // resetting the button as if the save succeeded.
      setSaveError(e instanceof Error ? e.message : t('memSaveFailed'));
    } finally { setSaving(false); }
  };

  const role = String(v('role'));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell member-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head member-edit-head">
          <div>
            <div className="modal-title">{t('memEditMember')}</div>
            <div className="modal-sub">{member.email}</div>
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div className="member-edit-tabs">
          <button className={'member-edit-tab ' + (tab === 'profile' ? 'active' : '')} onClick={() => setTab('profile')}>
            <Icon name="user" size={12} /> {t('memTabProfile')}
          </button>
          <button className={'member-edit-tab ' + (tab === 'role' ? 'active' : '')} onClick={() => setTab('role')}>
            <Icon name="shield" size={12} /> {t('role')}
          </button>
          <button className={'member-edit-tab ' + (tab === 'security' ? 'active' : '')} onClick={() => setTab('security')}>
            <Icon name="lock" size={12} /> {t('memTabSecurity')}
          </button>
        </div>

        <div className="modal-body member-edit-body">
          {tab === 'profile' && (
            <>
              <div className="field-row">
                <div className="field">
                  <label className="label">{t('whFieldName')}</label>
                  <input className="input" value={String(v('name'))} onChange={e => set('name', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">{t('memFieldTitle')}</label>
                  <input className="input" value={String(v('title') ?? '')} onChange={e => set('title', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">{t('memFieldTeam')}</label>
                  <input className="input" value={String(v('team') ?? '')} onChange={e => set('team', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">{t('custFieldContactPhone')}</label>
                  <input className="input" value={String(v('phone') ?? '')} onChange={e => set('phone', e.target.value)} />
                </div>
              </div>
              <div className="toggle-row">
                <span>{t('memAccountActive')}</span>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(v('active'))} onChange={e => set('active', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </div>
            </>
          )}

          {tab === 'role' && (
            <>
              <div className="role-picker">
                {(['manager', 'purchaser'] as const).map(r => (
                  <label key={r} className={'role-card ' + (role === r ? 'active' : '')}>
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={role === r}
                      onChange={() => set('role', r)}
                    />
                    <div className="role-card-body">
                      <div className="role-card-title">
                        {r === 'manager' ? t('role_manager') : t('role_purchaser')}
                        {role === r && <span className="chip accent" style={{ fontSize: 10 }}>{t('memCurrentRole')}</span>}
                      </div>
                      <div className="role-card-desc">
                        {r === 'manager' ? t('memRoleMgrDesc') : t('memRolePurchDesc')}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {tab === 'security' && (
            <>
              <div className="security-card">
                <div className="security-card-head">
                  <div>
                    <div className="security-card-title">{t('memSecPwTitle')}</div>
                    <div className="security-card-sub">{t('memSecPwSub')}</div>
                  </div>
                </div>
                <div className="field">
                  <label className="label">{t('memSecNewPw')}</label>
                  <div className="pw-input">
                    <input
                      className="input"
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      placeholder={t('memSecPwPlaceholder')}
                      onChange={e => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="pw-toggle"
                      onClick={() => setShowPw(s => !s)}
                      tabIndex={-1}
                    >
                      <Icon name={showPw ? 'eye' : 'eye'} size={12} />
                      {showPw ? t('memSecHide') : t('memSecShow')}
                    </button>
                  </div>
                  <PasswordMeter password={password} labels={pwStrengthLabels(t)} />
                  <div className="help">{t('memSecPwHelp')}</div>
                </div>
              </div>

              <div className="security-card">
                <div className="security-card-head">
                  <div>
                    <div className="security-card-title">{t('memLastActivityTitle')}</div>
                    <div className="security-card-sub">{t('memLastActivitySub')}</div>
                  </div>
                </div>
                <div className="security-detail">
                  <Icon name="check" size={13} />
                  <span>
                    {member.last_seen_at
                      ? <>{t('memLastSignedInLead')} <strong>{lastSeenLabel(member, locale)}</strong>.</>
                      : <>{t('memNoSignIn')}</>}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot member-edit-foot">
          {saveError && (
            <span style={{ color: 'var(--danger, #c0392b)', fontSize: 12, marginRight: 'auto' }}>
              {saveError}
            </span>
          )}
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '…' : t('save')}</button>
        </div>
      </div>
    </div>
  );
}
