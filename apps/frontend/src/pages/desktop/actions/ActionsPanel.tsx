import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ActionItem, ActionLink, ActionLinkType, ActionStatus } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { actionsApi, actionsChanged, STATUS_KEY } from '../../../lib/actions';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { actionPath, navigate } from '../../../lib/route';
import { ActionDialog } from './ActionDialog';
import { ActionDrawer } from './ActionDrawer';
import { Avatar, DueChip, actionToday } from './shared';
import '../../../styles/actions.css';

type Options = {
  /** The record's number, or for a client its name: what a new card links to. */
  label: string;
  /** Inside a dialog (the client drawer): a card opens on the board instead. */
  openInBoard?: boolean;
};

/**
 * One record's cards: the panel's props and the overlay (create dialog, card
 * drawer) the host renders. The overlay is separate so a host that is itself
 * a dialog can place it beside its <Modal> rather than inside.
 */
export function useRecordActions(type: ActionLinkType, id: string, { label, openInBoard = false }: Options) {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ActionItem | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    actionsApi.byRecord(type, id).then(r => setItems(r.items), handleFetchError);
  }, [type, id]);
  useEffect(() => { load(); }, [load]);

  const link: ActionLink = type === 'client'
    ? { type, id, label: 'Client', name: label, canOpen: true, deleted: false }
    : { type, id, label, canOpen: true, deleted: false };
  const open = (item: ActionItem) => (openInBoard ? navigate(actionPath(item.id)) : setOpenId(item.id));

  const overlay: ReactNode = (
    <>
      {openId && (
        <ActionDrawer
          key={openId}
          id={openId}
          initial={items?.find(i => i.id === openId)}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onRemoved={() => { setOpenId(null); load(); }}
          onEdit={setEditing}
          onMove={async (item, to: ActionStatus) => {
            try {
              await actionsApi.move(item.id, to, null);
              actionsChanged();
              load();
            } catch (err) { handleFetchError(err); }
          }}
        />
      )}
      {(creating || editing) && (
        <ActionDialog
          item={editing ?? undefined}
          link={link}
          zIndex={110}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </>
  );

  return {
    open: (items ?? []).filter(i => i.status !== 'done').length,
    panel: { items, onNew: () => setCreating(true), onOpen: open },
    overlay,
  };
}

type PanelProps = {
  items: ActionItem[] | null;
  onNew: () => void;
  onOpen: (item: ActionItem) => void;
  /** Inside a tab or section that has its own frame and heading. */
  bare?: boolean;
  className?: string;
};

/** The cards about one record, open first, with a button to add one. */
export function ActionsPanel({ items, onNew, onOpen, bare = false, className }: PanelProps) {
  const { t } = useT();
  const today = actionToday();
  const open = (items ?? []).filter(i => i.status !== 'done').length;
  return (
    <div className={`${bare ? '' : 'card '}act-panel${className ? ' ' + className : ''}`}>
      <div className="act-panel-head">
        {!bare && <h3><Icon name="check2" size={14} /> {t('actPanelTitle')}</h3>}
        {items && items.length > 0 && <span className="act-count">{t('actPanelOpen', { n: open })}</span>}
        <button className="btn sm" onClick={onNew}><Icon name="plus" size={13} />{t('actNew')}</button>
      </div>
      {items === null ? <p className="act-muted act-small">{t('actLoading')}</p>
        : items.length === 0 ? <p className="act-muted act-small">{t('actPanelEmpty')}</p>
          : (
            <ul className="act-panel-list">
              {items.map(i => (
                <li key={i.id}>
                  <button className={`act-panel-row${i.status === 'done' ? ' act-panel-done' : ''}`} onClick={() => onOpen(i)}>
                    <span className={`chip act-st-${i.status}`}>{t(STATUS_KEY[i.status])}</span>
                    <span className="act-panel-title">{i.title}</span>
                    <DueChip item={i} today={today} />
                    {i.assignee ? <Avatar name={i.assignee.name} /> : <span className="act-muted act-small">{t('actUnassigned')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}
