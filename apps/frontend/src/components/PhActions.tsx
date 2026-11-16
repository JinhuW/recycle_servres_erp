import { useCallback, useEffect, useState } from 'react';
import {
  ACTION_PRIORITIES, ACTION_STATUSES, ACTION_TITLE_MAX, REPORTING_TZ, actionIsOverdue, todayIn,
  type ActionEvent, type ActionItem, type ActionStatus,
} from '@recycle-erp/shared';
import { Icon } from './Icon';
import { PhSheet } from './PhSheet';
import { actionsApi, actionsChanged, linkPath, LINK_TYPE_KEY, PRIORITY_KEY, STATUS_KEY } from '../lib/actions';
import { handleFetchError } from '../lib/errorToast';
import { useT } from '../lib/i18n';
import { poStageName } from '../lib/orderPresentation';
import { navigate } from '../lib/route';
import { useMembers } from '../lib/useManagers';
import { useEffectiveUser } from '../lib/tweaks';
import '../styles/actions.css';

// The phone's side of the Actions board: a list (the viewer's open cards on
// Home, or one PO's cards on its page), a sheet to open, move, reassign and
// comment on a card, and a sheet to add one. No board and no dragging here;
// a card moves with its column select.

type Scope = { mine: true } | { mine?: false; po: string };

export function PhActionsSection({ scope, title }: { scope: Scope; title?: string }) {
  const { t, locale } = useT();
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [count, setCount] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const po = scope.mine ? null : scope.po;

  const load = useCallback(() => {
    const req = po === null
      ? actionsApi.mine(5).then(r => { setItems(r.items); setCount(r.count); })
      : actionsApi.byRecord('po', po).then(r => { setItems(r.items); setCount(r.items.filter(i => i.status !== 'done').length); });
    // A list that fails to load is left empty; it is never worth a dialog.
    req.catch(() => setItems([]));
  }, [po]);
  useEffect(() => { load(); }, [load]);

  const today = todayIn(REPORTING_TZ);
  return (
    <>
      <div className="ph-section-h">
        <span>{title ?? t('homeMyActions')}{count > 0 ? ` · ${count}` : ''}</span>
        <button className="ph-act-add" onClick={() => setAdding(true)} aria-label={t('actNew')}>
          <Icon name="plus" size={14} />{t('actNew')}
        </button>
      </div>
      {items !== null && items.length === 0 && (
        <div className="home-clear"><Icon name="check" size={14} /> {po ? t('actPanelEmpty') : t('homeNoActions')}</div>
      )}
      {items?.map(a => {
        const overdue = actionIsOverdue(a, today);
        return (
          <button key={a.id} className="ph-row ph-act-row" onClick={() => setOpenId(a.id)}>
            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div className="ph-act-title">{a.title}</div>
              <div className="ph-act-meta">
                <span className={`chip act-st-${a.status}`}>{t(STATUS_KEY[a.status])}</span>
                {a.link && <span className="mono">{a.link.label === 'Client' && !a.link.name ? t('actLink_client') : a.link.label}</span>}
                {a.assignee && po && <span>{a.assignee.name}</span>}
              </div>
            </div>
            {a.dueDate && (
              <span className={'ph-act-due' + (overdue ? ' neg' : a.dueDate === today ? ' warn' : '')}>
                {overdue ? t('actOverdue') : a.dueDate === today ? t('actDueToday')
                  : new Date(a.dueDate + 'T12:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
              </span>
            )}
            <Icon name="chevronRight" size={15} className="arrow" />
          </button>
        );
      })}
      {po === null && count > (items?.length ?? 0) && (
        <div className="ph-act-more">{t('phActMore', { n: count - (items?.length ?? 0) })}</div>
      )}
      {openId && <PhActionSheet id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
      {adding && <PhNewActionSheet po={po} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

export function PhActionSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const members = useMembers();
  const [item, setItem] = useState<ActionItem | null>(null);
  const [events, setEvents] = useState<ActionEvent[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => actionsApi.detail(id).then(r => { setItem(r.item); setEvents(r.events); }, handleFetchError), [id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (req: Promise<unknown>) => {
    setBusy(true);
    try { await req; actionsChanged(); await load(); onChanged(); } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  const path = item?.link?.canOpen && item.link.type === 'po' ? linkPath(item.link) : null;
  const notes = events.filter(e => e.kind === 'note').reverse();

  return (
    <PhSheet onBackdrop={onClose} className="ph-act-sheet" aria-label={item?.title ?? id}>
      {!item ? <div className="ph-act-loading">{t('actLoading')}</div> : (
        <>
          <div className="ph-act-head">
            <span className="mono ph-act-id">{item.id}</span>
            {item.priority !== 'normal' && <span className={`chip act-pri-${item.priority}`}>{t(PRIORITY_KEY[item.priority])}</span>}
            <button className="ph-icon-btn" onClick={onClose} aria-label={t('close')}><Icon name="x" size={16} /></button>
          </div>
          <h2 className="ph-act-h">{item.title}</h2>
          {item.link && (
            <button className="ph-act-link" disabled={!path} onClick={() => { if (path) { onClose(); navigate(path); } }}>
              <span>{t(LINK_TYPE_KEY[item.link.type])}</span>
              <b className="mono">{item.link.type === 'client' && !item.link.name ? t('actLink_client') : item.link.label}</b>
              {item.link.status && <span>{item.link.type === 'po' ? poStageName(item.link.status, t) : item.link.status}</span>}
              {path && <Icon name="chevronRight" size={14} />}
            </button>
          )}
          {item.description && <p className="ph-act-desc">{item.description}</p>}
          <label className="field">
            <span className="label">{t('actMoveTo')}</span>
            <select className="select" value={item.status} disabled={busy}
              onChange={e => void run(actionsApi.move(item.id, e.target.value as ActionStatus, null))}>
              {ACTION_STATUSES.map(s => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">{t('actFieldAssignee')}</span>
            <select className="select" value={item.assignee?.id ?? ''} disabled={busy}
              onChange={e => void run(actionsApi.update(item.id, { assigneeId: e.target.value || null }))}>
              <option value="">{t('actUnassigned')}</option>
              {item.assignee && !members.some(m => m.id === item.assignee!.id) && <option value={item.assignee.id}>{item.assignee.name}</option>}
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <div className="ph-act-comments">
            <div className="label">{t('actComments')}</div>
            <div className="ph-act-compose">
              <textarea className="textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('actComment')} />
              <button className="btn primary" disabled={busy || !note.trim()}
                onClick={() => void run(actionsApi.note(item.id, note).then(() => setNote('')))}>{t('actComment')}</button>
            </div>
            {notes.map(n => (
              <div key={n.id} className="ph-act-note">
                <div className="ph-act-note-who">{n.actor?.name ?? t('actSomeone')} · {new Date(n.createdAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</div>
                <div>{n.note}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </PhSheet>
  );
}

function PhNewActionSheet({ po, onClose, onSaved }: { po: string | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const members = useMembers();
  const me = useEffectiveUser();
  const [title, setTitle] = useState('');
  // Added from My actions, a card is the viewer's own until they hand it on.
  const [assigneeId, setAssigneeId] = useState(po === null ? me?.id ?? '' : '');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<(typeof ACTION_PRIORITIES)[number]>('normal');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await actionsApi.create({
        title: title.trim(), description: null, priority, dueDate: dueDate || null,
        assigneeId: assigneeId || null, link: po ? { type: 'po', id: po } : null,
      });
      actionsChanged();
      onSaved();
    } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  return (
    <PhSheet onBackdrop={() => { if (!busy) onClose(); }} className="ph-act-sheet" aria-label={t('actNewTitle')}>
      <h2 className="ph-act-h">{t('actNewTitle')}{po ? ` · ${po}` : ''}</h2>
      <label className="field">
        <span className="label">{t('actFieldTitle')}</span>
        <input className="input" value={title} maxLength={ACTION_TITLE_MAX} onChange={e => setTitle(e.target.value)} placeholder={t('actTitlePlaceholder')} />
      </label>
      <label className="field">
        <span className="label">{t('actFieldAssignee')}</span>
        <select className="select" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
          <option value="">{t('actUnassigned')}</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="label">{t('actFieldDue')}</span>
        <input className="input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
      </label>
      <div className="field">
        <span className="label">{t('actFieldPriority')}</span>
        <div className="seg" role="group">
          {ACTION_PRIORITIES.map(p => (
            <button type="button" key={p} className={priority === p ? 'active' : ''} onClick={() => setPriority(p)}>{t(PRIORITY_KEY[p])}</button>
          ))}
        </div>
      </div>
      <div className="ph-act-actions">
        <button className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !title.trim()}>{t('actCreate')}</button>
      </div>
    </PhSheet>
  );
}
