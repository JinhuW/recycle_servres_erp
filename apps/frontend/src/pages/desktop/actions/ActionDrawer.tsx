import { useEffect, useRef, useState } from 'react';
import { ACTION_STATUSES, type ActionEvent, type ActionItem, type ActionStatus } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { actionsApi, actionsChanged, STATUS_KEY } from '../../../lib/actions';
import { handleFetchError } from '../../../lib/errorToast';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { useMemberNames, useMembers } from '../../../lib/useManagers';
import { useEscapeKey } from '../../../lib/useEscapeKey';
import { useFocusTrap } from '../../../lib/useFocusTrap';
import { ConfirmDialog } from '../settings/dialogs';
import { Avatar, DueChip, LinkChip, PriorityChip, actionToday } from './shared';

type Props = {
  id: string;
  /** The card as the board holds it, shown until the full read lands. */
  initial?: ActionItem;
  onClose: () => void;
  onChanged: (item: ActionItem) => void;
  onRemoved: (id: string) => void;
  onEdit: (item: ActionItem) => void;
  onMove: (item: ActionItem, to: ActionStatus) => Promise<void>;
};

/** One card: its details, a move and an assignee without opening the form, and its timeline. */
export function ActionDrawer({ id, initial, onClose, onChanged, onRemoved, onEdit, onMove }: Props) {
  const { t, locale } = useT();
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel);
  const [confirming, setConfirming] = useState(false);
  // Escape belongs to the confirm while it is open; it sits above in the stack.
  useEscapeKey(onClose);
  const members = useMembers();
  const names = useMemberNames();
  const [item, setItem] = useState<ActionItem | null>(initial ?? null);
  const [events, setEvents] = useState<ActionEvent[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const today = actionToday();

  const load = () => actionsApi.detail(id).then(
    r => { setItem(r.item); setEvents(r.events); },
    err => { if ((err as { status?: number }).status === 404) setMissing(true); else handleFetchError(err); },
  );
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A drag on the board while the drawer is open moves the card under it.
  useEffect(() => {
    if (initial) setItem(i => (i ? { ...i, status: initial.status, completedAt: initial.completedAt } : initial));
  }, [initial?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = (next: ActionItem) => { setItem(next); onChanged(next); void load(); };

  const assign = async (assigneeId: string) => {
    if (!item) return;
    setBusy(true);
    try {
      const r = await actionsApi.update(item.id, { assigneeId: assigneeId || null });
      actionsChanged();
      changed(r.item);
    } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  const move = async (to: ActionStatus) => {
    if (!item || to === item.status) return;
    setBusy(true);
    await onMove(item, to);
    setBusy(false);
    void load();
  };
  const addNote = async () => {
    if (!item || !note.trim()) return;
    setBusy(true);
    try {
      await actionsApi.note(item.id, note);
      setNote('');
      await load();
      if (item) onChanged({ ...item, noteCount: item.noteCount + 1 });
    } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!item) return;
    setBusy(true);
    try {
      await actionsApi.remove(item.id);
      actionsChanged();
      setConfirming(false);
      onRemoved(item.id);
    } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };

  const who = (userId: unknown) => names.find(m => m.id === userId)?.name ?? t('actSomeone');
  const eventLine = (e: ActionEvent): string => {
    const d = e.detail;
    switch (e.kind) {
      case 'created': return t('actEvCreated');
      case 'moved': return t('actEvMoved', {
        from: t(STATUS_KEY[d.from as ActionStatus] ?? String(d.from)), to: t(STATUS_KEY[d.to as ActionStatus] ?? String(d.to)),
      });
      case 'assigned': return d.to ? t('actEvAssigned', { name: who(d.to) }) : t('actEvUnassigned');
      case 'edited': return t('actEvEdited', {
        fields: Object.keys((d.changes as Record<string, unknown>) ?? {}).map(k => t(`actField_${k}`)).join(', '),
      });
      case 'note': return t('actEvNote');
      case 'removed': return t('actEvRemoved');
    }
  };

  return (
    <>
      <div className="act-scrim" onClick={onClose} />
      <aside ref={panel} className="act-drawer" role="dialog" aria-modal="true" aria-label={item?.title ?? id}>
        <header className="act-dhead">
          <div className="act-dtop">
            <span className="act-id">{id}</span>
            {item && <PriorityChip item={item} />}
            {item && <DueChip item={item} today={today} />}
            <button className="btn sm ghost icon act-close" onClick={onClose} aria-label={t('close')}><Icon name="x" size={16} /></button>
          </div>
          <h2>{item?.title ?? '…'}</h2>
        </header>
        {missing ? (
          <div className="act-dbody"><p className="act-muted">{t('actGone')}</p></div>
        ) : item && (
          <div className="act-dbody">
            <dl className="act-facts">
              <dt>{t('actFieldStatus')}</dt>
              <dd>
                <select className="select" value={item.status} disabled={busy} onChange={e => void move(e.target.value as ActionStatus)} aria-label={t('actMoveTo')}>
                  {ACTION_STATUSES.map(s => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
                </select>
              </dd>
              <dt>{t('actFieldAssignee')}</dt>
              <dd>
                <select className="select" value={item.assignee?.id ?? ''} disabled={busy} onChange={e => void assign(e.target.value)} aria-label={t('actFieldAssignee')}>
                  <option value="">{t('actUnassigned')}</option>
                  {item.assignee && !members.some(m => m.id === item.assignee!.id) && <option value={item.assignee.id}>{item.assignee.name}</option>}
                  {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </dd>
              {item.link && <><dt>{t('actFieldLink')}</dt><dd><LinkChip link={item.link} asLink /></dd></>}
              <dt>{t('actCreatedBy')}</dt>
              <dd>{item.createdBy ? <><Avatar name={item.createdBy.name} /> {item.createdBy.name}</> : '—'} · {relTime(new Date(item.createdAt), locale)}</dd>
            </dl>
            {item.description && <p className="act-desc">{item.description}</p>}
            <div className="act-row">
              <button className="btn sm" onClick={() => onEdit(item)} disabled={busy}><Icon name="edit" size={13} />{t('actEdit')}</button>
              {item.canRemove && (
                <button className="btn sm ghost act-danger" onClick={() => setConfirming(true)} disabled={busy}><Icon name="trash" size={13} />{t('actRemove')}</button>
              )}
            </div>

            <section>
              <h3>{t('actComments')}</h3>
              <div className="act-compose">
                <textarea className="textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('actCommentPlaceholder')}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote(); }} />
                <button className="btn sm primary" onClick={() => void addNote()} disabled={busy || !note.trim()}>{t('actComment')}</button>
              </div>
              <ol className="act-time">
                {(events ?? []).slice().reverse().map(e => (
                  <li key={e.id}>
                    <time dateTime={e.createdAt}>{relTime(new Date(e.createdAt), locale)}</time>
                    <div>
                      <b>{e.actor?.name ?? t('actSomeone')}</b> {eventLine(e)}
                      {e.note && <p className="act-quote">{e.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
      {confirming && item && (
        <ConfirmDialog
          title={t('actRemoveTitle', { id: item.id })}
          message={t('actRemoveBody')}
          confirmLabel={t('actRemove')}
          danger
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
