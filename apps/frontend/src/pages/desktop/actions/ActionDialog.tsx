import { useEffect, useState } from 'react';
import {
  ACTION_PRIORITIES, ACTION_TITLE_MAX, actionLinkTypesFor,
  type ActionItem, type ActionLink, type ActionLinkTarget, type ActionLinkType, type ActionStatus,
} from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { actionsApi, actionsChanged, LINK_TYPE_KEY, PRIORITY_KEY, type ActionDraft } from '../../../lib/actions';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { useMembers } from '../../../lib/useManagers';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { useEffectiveUser } from '../../../lib/tweaks';
import { LinkChip } from './shared';

type Props = {
  /** The card to edit; absent for a new one. */
  item?: ActionItem;
  /** A new card's column and record, when it is started from one. */
  status?: ActionStatus;
  link?: ActionLink | null;
  /** Above a host that is itself a dialog. */
  zIndex?: number;
  onClose: () => void;
  onSaved: (item: ActionItem) => void;
};

/** Creates or edits a card: what, who, when, and the record it is about. */
export function ActionDialog({ item, status, link: presetLink, zIndex, onClose, onSaved }: Props) {
  const { t } = useT();
  const members = useMembers();
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [assigneeId, setAssigneeId] = useState(item?.assignee?.id ?? '');
  const [priority, setPriority] = useState(item?.priority ?? 'normal');
  const [dueDate, setDueDate] = useState(item?.dueDate ?? '');
  const start = item ? item.link : presetLink ?? null;
  const [link, setLink] = useState<ActionLink | null>(start);
  const [busy, setBusy] = useState(false);

  // The assignee may since have been deactivated: keep showing them.
  const options = item?.assignee && !members.some(m => m.id === item.assignee!.id)
    ? [...members, { id: item.assignee.id, name: item.assignee.name, role: 'purchaser' as const, active: false }]
    : members;

  const save = async () => {
    if (!title.trim() || busy) return;
    const draft: Partial<ActionDraft> = {
      title: title.trim(),
      description: description.trim() || null,
      assigneeId: assigneeId || null,
      priority,
      dueDate: dueDate || null,
    };
    // An edit sends the link only when it changed: a deleted record's link has
    // no id to resend. A new card always sends it, preset from a record or not.
    if (!item || link?.id !== start?.id || link?.type !== start?.type) {
      draft.link = link && link.id ? { type: link.type, id: link.id } : null;
    }
    setBusy(true);
    try {
      const r = item
        ? await actionsApi.update(item.id, draft)
        : await actionsApi.create({ ...(draft as ActionDraft), link: draft.link ?? null, status });
      actionsChanged();
      onSaved(r.item);
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 560 }} zIndex={zIndex} ariaLabel={item ? t('actEditTitle') : t('actNewTitle')}>
      <div className="modal-head">
        <div className="modal-title">{item ? t('actEditTitle', { id: item.id }) : t('actNewTitle')}</div>
      </div>
      <form className="modal-body act-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="field">
          <span className="label">{t('actFieldTitle')}</span>
          <input className="input" value={title} maxLength={ACTION_TITLE_MAX} autoFocus onChange={e => setTitle(e.target.value)} placeholder={t('actTitlePlaceholder')} />
        </label>
        <label className="field">
          <span className="label">{t('actFieldDescription')}</span>
          <textarea className="textarea" rows={3} value={description} onChange={e => setDescription(e.target.value)} />
        </label>
        <div className="act-form-row">
          <label className="field">
            <span className="label">{t('actFieldAssignee')}</span>
            <select className="select" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
              <option value="">{t('actUnassigned')}</option>
              {options.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">{t('actFieldDue')}</span>
            <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </label>
        </div>
        <div className="field">
          <span className="label">{t('actFieldPriority')}</span>
          <div className="seg" role="group" aria-label={t('actFieldPriority')}>
            {ACTION_PRIORITIES.map(p => (
              <button type="button" key={p} className={priority === p ? 'active' : ''} aria-pressed={priority === p} onClick={() => setPriority(p)}>
                {t(PRIORITY_KEY[p])}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">{t('actFieldLink')}</span>
          <RecordPicker value={link} onChange={setLink} />
        </div>
        <button type="submit" hidden />
      </form>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !title.trim()}>
          {item ? t('save') : t('actCreate')}
        </button>
      </div>
    </Modal>
  );
}

const asLink = (x: ActionLinkTarget): ActionLink => ({
  type: x.type, id: x.id, label: x.label, status: x.status, canOpen: true, deleted: false,
  ...(x.name ? { name: x.name } : {}),
});

/** Finds a record the viewer can open, by type and number or name. */
export function RecordPicker({ value, onChange }: { value: ActionLink | null; onChange: (l: ActionLink | null) => void }) {
  const { t } = useT();
  const user = useEffectiveUser();
  const types = actionLinkTypesFor(user?.role === 'manager' ? 'manager' : 'purchaser');
  const [type, setType] = useState<ActionLinkType>(types[0]);
  const [q, setQ] = useState('');
  const query = useDebouncedValue(q, 250);
  const [found, setFound] = useState<ActionLinkTarget[] | null>(null);
  const [picking, setPicking] = useState(value === null);

  useEffect(() => {
    if (!picking) return;
    let live = true;
    setFound(null);
    actionsApi.targets(type, query.trim()).then(r => { if (live) setFound(r.items); }, handleFetchError);
    return () => { live = false; };
  }, [type, query, picking]);

  if (!picking && value) {
    return (
      <div className="act-picked">
        <LinkChip link={value} />
        <button type="button" className="btn sm ghost" onClick={() => setPicking(true)}>{t('actChangeLink')}</button>
        <button type="button" className="btn sm ghost" onClick={() => { onChange(null); setPicking(true); }}>{t('actRemoveLink')}</button>
      </div>
    );
  }
  return (
    <div className="act-picker">
      <div className="act-picker-bar">
        <select className="select" value={type} onChange={e => setType(e.target.value as ActionLinkType)} aria-label={t('actLinkType')}>
          {types.map(x => <option key={x} value={x}>{t(LINK_TYPE_KEY[x])}</option>)}
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t('actLinkSearch')} aria-label={t('actLinkSearch')} />
        </label>
        {value && <button type="button" className="btn sm ghost" onClick={() => setPicking(false)}>{t('cancel')}</button>}
      </div>
      <ul className="act-picker-list">
        {found === null && <li className="act-muted">{t('actLoading')}</li>}
        {found?.length === 0 && <li className="act-muted">{t('actLinkNone')}</li>}
        {found?.map(x => (
          <li key={x.id}>
            <button type="button" onClick={() => { onChange(asLink(x)); setPicking(false); }}>
              <LinkChip link={asLink(x)} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
