import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACTION_STATUSES, actionIsOverdue, type ActionItem, type ActionStatus } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { TableSkeleton } from '../../components/Skeleton';
import {
  actionsApi, actionsChanged, applyOrder, moveCard, pollIsFresh, STATUS_KEY, toColumns,
} from '../../lib/actions';
import { useBoardDrag } from '../../lib/boardDrag';
import { ApiError } from '../../lib/api';
import { handleFetchError, showWarnToast } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { usePreference } from '../../lib/preferences';
import {
  ACTIONS_ARCHIVE_PATH, ACTIONS_PATH, actionPath, hrefFor, matchActionCard, navigate, onLinkClick, useRoute,
} from '../../lib/route';
import { useMembers } from '../../lib/useManagers';
import { useEffectiveUser } from '../../lib/tweaks';
import { ActionDialog } from './actions/ActionDialog';
import { ActionDrawer } from './actions/ActionDrawer';
import { Avatar, DueChip, LinkChip, PriorityChip, actionToday } from './actions/shared';
import '../../styles/actions.css';

// ─── Actions ──────────────────────────────────────────────────────────────────
// The team's shared board of things to do. Everyone sees every card and may
// move or assign any of them. Cards are dragged between four fixed columns
// (a mouse anywhere on the card, a finger by its grip) or moved with the
// select on the card. Done cards leave the board after two weeks; the archive
// keeps them.

type Props = { showToast?: (message: string, kind?: 'success' | 'error') => void };

const POLL_MS = 60_000;

export function DesktopActions({ showToast }: Props) {
  const { path } = useRoute();
  const { t } = useT();
  const user = useEffectiveUser();
  const members = useMembers();
  const [assignee, setAssignee] = usePreference('actions.assignee', 'all');
  const archive = path === ACTIONS_ARCHIVE_PATH;
  const openId = archive ? null : matchActionCard(path);

  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<{ item?: ActionItem; status?: ActionStatus } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState<string | null>(null);
  const lastChange = useRef(0);
  const dragging = useRef(false);

  const load = useCallback((quiet = false) => {
    const startedAt = Date.now();
    actionsApi.board(assignee).then(r => {
      if (quiet && !pollIsFresh(startedAt, lastChange.current, dragging.current)) return;
      setItems(r.items);
    }, quiet ? () => {} : handleFetchError);
  }, [assignee]);
  useEffect(() => { setItems(null); load(); }, [load]);
  useEffect(() => {
    if (archive) return;
    const tick = () => { if (document.visibilityState === 'visible') load(true); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load, archive]);

  const touched = () => { lastChange.current = Date.now(); };
  const patch = (next: ActionItem) => {
    touched();
    setItems(cur => cur && (cur.some(i => i.id === next.id) ? cur.map(i => (i.id === next.id ? next : i)) : [next, ...cur]));
  };

  const doMove = async (id: string, to: ActionStatus, beforeId: string | null) => {
    if (!items) return;
    const before = items;
    touched();
    setItems(cur => cur && moveCard(cur, id, to, beforeId));
    try {
      const r = await actionsApi.move(id, to, beforeId);
      touched();
      setItems(cur => cur && applyOrder(cur, r.order));
      actionsChanged();
    } catch (err) {
      setItems(before);
      if (err instanceof ApiError && err.status === 404) {
        showWarnToast(t('actGoneToast'));
        load();
      } else handleFetchError(err);
    }
  };

  const drag = useBoardDrag({
    onDrop: (id, target) => {
      const to = target.col as ActionStatus;
      const col = toColumns(items ?? [])[to];
      const at = col.findIndex(i => i.id === id);
      // Dropped back where it was.
      if (at >= 0 && (col[at + 1]?.id ?? null) === target.beforeId) return;
      void doMove(id, to, target.beforeId);
    },
  });
  dragging.current = drag.dragId !== null;

  const today = actionToday();
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (items ?? []).filter(i => !needle
    || i.title.toLowerCase().includes(needle) || i.id.toLowerCase().includes(needle)
    || (i.link?.label.toLowerCase().includes(needle) ?? false)
    || (i.assignee?.name.toLowerCase().includes(needle) ?? false)), [items, needle]);
  const columns = toColumns(shown);
  const open = openId ? items?.find(i => i.id === openId) : undefined;

  const header = (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('actTitle')}</h1>
          <p className="page-sub">{t('actLede')}</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setDialog({ status: 'todo' })}><Icon name="plus" size={14} />{t('actNew')}</button>
        </div>
      </div>
      <div className="act-toolbar">
        <nav className="seg" aria-label={t('actViews')}>
          <a className={archive ? '' : 'active'} href={hrefFor(ACTIONS_PATH)} onClick={onLinkClick(ACTIONS_PATH)} aria-current={archive ? undefined : 'page'}>{t('actBoard')}</a>
          <a className={archive ? 'active' : ''} href={hrefFor(ACTIONS_ARCHIVE_PATH)} onClick={onLinkClick(ACTIONS_ARCHIVE_PATH)} aria-current={archive ? 'page' : undefined}>{t('actArchive')}</a>
        </nav>
        {!archive && (
          <>
            <select className="select act-who" value={assignee} onChange={e => setAssignee(e.target.value)} aria-label={t('actFilterWho')}>
              <option value="all">{t('actFilterAll')}</option>
              <option value="me">{t('actFilterMine')}</option>
              <option value="none">{t('actUnassigned')}</option>
              {members.filter(m => m.id !== user?.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <label className="toolbar-search">
              <Icon name="search" size={14} />
              <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t('actSearch')} aria-label={t('actSearch')} />
            </label>
          </>
        )}
      </div>
    </>
  );

  const dialogs = (
    <>
      {dialog && (
        <ActionDialog
          item={dialog.item}
          status={dialog.status}
          onClose={() => setDialog(null)}
          onSaved={next => {
            patch(next);
            setDialog(null);
            showToast?.(dialog.item ? t('actSavedToast') : t('actCreatedToast', { id: next.id }));
          }}
        />
      )}
    </>
  );

  if (archive) {
    return (
      <>
        {header}
        <Archive onOpen={setArchiveOpen} />
        {archiveOpen && (
          <ActionDrawer
            key={archiveOpen}
            id={archiveOpen}
            onClose={() => setArchiveOpen(null)}
            onChanged={() => {}}
            onRemoved={() => setArchiveOpen(null)}
            onEdit={item => setDialog({ item })}
            onMove={async (item, to) => { await doMove(item.id, to, null); }}
          />
        )}
        {dialogs}
      </>
    );
  }

  return (
    <>
      {header}
      {!items ? <TableSkeleton rows={6} cols={4} /> : (
        <div className={`act-board${drag.dragId ? ' act-dragging' : ''}`}>
          {ACTION_STATUSES.map(s => {
            const cards = columns[s];
            const slotAt = (id: string | null) => drag.over?.col === s && drag.over.beforeId === id;
            return (
              <section key={s} className={`act-col act-col-${s}${drag.over?.col === s ? ' act-over' : ''}`} aria-label={t(STATUS_KEY[s])} {...drag.colProps(s)}>
                <header>
                  <h3>{t(STATUS_KEY[s])}</h3>
                  <span className="act-count">{cards.length}</span>
                  <button className="btn sm ghost icon" onClick={() => setDialog({ status: s })} aria-label={t('actNewIn', { col: t(STATUS_KEY[s]) })} title={t('actNewIn', { col: t(STATUS_KEY[s]) })}>
                    <Icon name="plus" size={14} />
                  </button>
                </header>
                <div className="act-cards">
                  {cards.map(c => (
                    <Fragment key={c.id}>
                      {slotAt(c.id) && <div className="act-slot" />}
                      <Card item={c} today={today} dragProps={drag.cardProps(c.id)} lifted={drag.dragId === c.id}
                        onOpen={() => navigate(actionPath(c.id))} onMove={to => void doMove(c.id, to, null)} />
                    </Fragment>
                  ))}
                  {slotAt(null) && <div className="act-slot" />}
                  {cards.length === 0 && !slotAt(null) && <p className="act-empty">{needle ? t('actNoMatch') : t('actColEmpty')}</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {openId && (
        <ActionDrawer
          key={openId}
          id={openId}
          initial={open}
          onClose={() => navigate(ACTIONS_PATH)}
          onChanged={patch}
          onRemoved={id => { touched(); setItems(cur => cur && cur.filter(i => i.id !== id)); navigate(ACTIONS_PATH); showToast?.(t('actRemovedToast', { id })); }}
          onEdit={item => setDialog({ item })}
          onMove={async (item, to) => { await doMove(item.id, to, null); }}
        />
      )}
      {dialogs}
    </>
  );
}

type CardProps = {
  item: ActionItem;
  today: string;
  lifted: boolean;
  dragProps: ReturnType<ReturnType<typeof useBoardDrag>['cardProps']>;
  onOpen: () => void;
  onMove: (to: ActionStatus) => void;
};

function Card({ item, today, lifted, dragProps, onOpen, onMove }: CardProps) {
  const { t } = useT();
  const overdue = actionIsOverdue(item, today);
  return (
    <article
      {...dragProps}
      className={`act-card${overdue ? ' act-overdue' : ''}${item.priority === 'high' ? ' act-high' : ''}${lifted ? ' act-lifted' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`${item.id} ${item.title}`}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
    >
      <div className="act-card-top">
        <span className="act-grip" data-drag-handle aria-hidden="true"><Icon name="grip" size={12} /></span>
        <span className="act-id">{item.id}</span>
        <PriorityChip item={item} />
        <DueChip item={item} today={today} />
      </div>
      <p className="act-card-title">{item.title}</p>
      {item.link && <LinkChip link={item.link} />}
      <div className="act-card-foot">
        {item.assignee ? <Avatar name={item.assignee.name} /> : <span className="act-muted act-small">{t('actUnassigned')}</span>}
        {item.noteCount > 0 && <span className="act-notes" title={t('actComments')}><Icon name="chats" size={12} />{item.noteCount}</span>}
        <select
          className="select act-move"
          value={item.status}
          aria-label={t('actMoveTo')}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          onChange={e => onMove(e.target.value as ActionStatus)}
        >
          {ACTION_STATUSES.map(s => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
        </select>
      </div>
    </article>
  );
}

function Archive({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, locale } = useT();
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const more = (from: string | null) => {
    setBusy(true);
    actionsApi.archive(from)
      .then(r => { setItems(cur => [...(from ? cur ?? [] : []), ...r.items]); setCursor(r.nextCursor); }, handleFetchError)
      .finally(() => setBusy(false));
  };
  useEffect(() => { more(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items) return <TableSkeleton rows={6} cols={4} />;
  if (!items.length) return <div className="card act-empty-card"><p>{t('actArchiveEmpty')}</p></div>;
  return (
    <div className="card">
      <div className="table-scroll">
        <table className="table act-archive">
          <thead><tr><th>{t('actFieldTitle')}</th><th>{t('actFieldLink')}</th><th>{t('actFieldAssignee')}</th><th>{t('actCompleted')}</th></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id}>
                <td><button className="act-row-link" onClick={() => onOpen(i.id)}><span className="act-id">{i.id}</span> {i.title}</button></td>
                <td>{i.link ? <LinkChip link={i.link} asLink /> : '—'}</td>
                <td>{i.assignee?.name ?? '—'}</td>
                <td>{i.completedAt ? new Date(i.completedAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <div className="act-foot"><button className="btn sm ghost" disabled={busy} onClick={() => more(cursor)}>{t('actLoadMore')}</button></div>}
    </div>
  );
}
