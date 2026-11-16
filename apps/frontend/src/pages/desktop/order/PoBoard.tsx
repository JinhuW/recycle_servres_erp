import { useEffect, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useManagerTakeover } from '../../../components/ManagerTakeoverDialog';
import { actionsApi } from '../../../lib/actions';
import { useBoardDrag } from '../../../lib/boardDrag';
import { readStageMoved } from '../../../lib/boxCheck';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../lib/errorToast';
import { fmtUSD0 } from '../../../lib/format';
import { ageTone, daysSince } from '../../../lib/home';
import { useT } from '../../../lib/i18n';
import { poStageName } from '../../../lib/orderPresentation';
import { poColumns, poDropAction, poStepPath } from '../../../lib/poBoard';
import { hrefFor, navigate, onLinkClick } from '../../../lib/route';
import { useEffectiveUser } from '../../../lib/tweaks';
import type { OrderSummary } from '../../../lib/types';
import { useReviewModeEntry } from '../ReviewModeEntry';
import '../../../styles/actions.css';

type Props = {
  orders: OrderSummary[];
  withDone: boolean;
  /** A PO the board moved, or found already moved, now stands at `lifecycle`. */
  onMoved: (id: string, lifecycle: string) => void;
};

const AGE_CHIP = { ok: 'muted', warn: 'warn', bad: 'neg' } as const;

/**
 * The purchase order list as a board, one column per stage. Dropping a card on
 * the next stage starts that move's own step: the hand-off form and the Done
 * evidence open on the PO page, the box check opens as from the list, and In
 * Transit to Reviewing moves here. Other columns refuse the drop.
 */
export function PoBoard({ orders, withDone, onMoved }: Props) {
  const { t, locale } = useT();
  const user = useEffectiveUser();
  const takeover = useManagerTakeover();
  const { enter: enterReview, prompt: reviewPrompt } = useReviewModeEntry({ onStale: onMoved });
  const [actionCounts, setActionCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    // The counts are a hint on the card; a board without them still works.
    actionsApi.counts('po').then(r => setActionCounts(r.counts), () => {});
  }, []);

  const byId = new Map(orders.map(o => [o.id, o]));
  const viewer = user ? { id: user.id, role: user.role } : null;
  const dropOf = (id: string, col: string) => {
    const o = byId.get(id);
    return o && viewer ? poDropAction(o, col, viewer) : null;
  };

  const advance = async (o: OrderSummary) => {
    const answer = await takeover.ask(o);
    if (answer === null) return;
    try {
      const moved = await takeover.advance(o, { toStage: 'reviewing', fromStage: o.lifecycle }, answer);
      if (!moved) return;
      onMoved(o.id, 'reviewing');
      showSuccessToast(t('poBoardMovedTo', { id: o.id, stage: poStageName('reviewing', t) }));
    } catch (e) {
      const where = readStageMoved(e);
      if (where === null) { handleFetchError(e); return; }
      onMoved(o.id, where);
      showWarnToast(t('poBoardAlreadyMoved', { id: o.id, stage: poStageName(where, t) }));
    }
  };

  const drag = useBoardDrag({
    canDrop: (id, col) => dropOf(id, col) !== null,
    onDrop: (id, target) => {
      const o = byId.get(id);
      const step = dropOf(id, target.col);
      if (!o || !step) return;
      if (step === 'handoff' || step === 'done') navigate(poStepPath(o.id, step));
      else if (step === 'boxCheck') enterReview({ id: o.id, lifecycle: o.lifecycle, archived: !!o.archivedAt, manager: o.manager });
      else void advance(o);
    },
  });

  const columns = poColumns(orders, withDone);
  return (
    <>
      <p className="po-board-hint"><Icon name="info" size={12} />{t('poBoardHint')}</p>
      <div className={`act-board po-board${drag.dragId ? ' act-dragging' : ''}`} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(196px, 1fr))` }}>
        {columns.map(col => {
          const target = drag.dragId !== null && dropOf(drag.dragId, col.stage) !== null;
          return (
            <section key={col.stage} className={`act-col${drag.over?.col === col.stage ? ' act-over' : ''}${drag.dragId && !target ? ' po-col-closed' : ''}`}
              aria-label={poStageName(col.stage, t)} {...drag.colProps(col.stage)}>
              <header>
                <h3>{poStageName(col.stage, t)}</h3>
                {!col.folded && <span className="act-count">{col.orders.length}</span>}
              </header>
              <div className="act-cards">
                {col.orders.map(o => {
                  const days = daysSince(o.stageSince ?? o.createdAt);
                  const tone = ageTone(days);
                  const path = '/purchase-orders/' + o.id;
                  const nActions = actionCounts[o.id] ?? 0;
                  return (
                    <article key={o.id} {...drag.cardProps(o.id)} className={`act-card po-card${o.archivedAt ? ' po-archived' : ''}${drag.dragId === o.id ? ' act-lifted' : ''}`}
                      onClick={() => navigate(path)}>
                      <div className="act-card-top">
                        <span className="act-grip" data-drag-handle aria-hidden="true"><Icon name="grip" size={12} /></span>
                        <a className="po-card-id" href={hrefFor(path)} onClick={onLinkClick(path)}>{o.id}</a>
                        <span className={`chip ${AGE_CHIP[tone]}`} title={t('poBoardInStage')}>
                          {days === 1 ? t('homeDaysNOne') : t('homeDaysN', { n: days })}
                        </span>
                        {o.archivedAt && <span className="chip muted">{t('poBoardArchived')}</span>}
                      </div>
                      <p className="act-card-title">{o.supplier?.name ?? t('poBoardNoSupplier')}</p>
                      <div className="po-card-meta">
                        <span>{fmtUSD0(o.totalCost ?? 0, locale)}</span>
                        <span>{t('poBoardLines', { n: o.lineCount })}</span>
                        {o.tracking && <span className="po-card-track"><Icon name="truck" size={11} />{o.tracking.carrier}</span>}
                      </div>
                      <div className="act-card-foot">
                        <span className="avatar sm act-avatar" title={o.userName}>{o.userInitials}</span>
                        <span className="act-small act-muted">{o.userName}</span>
                        {nActions > 0 && (
                          <span className="act-notes po-card-actions" title={t('poBoardActions', { n: nActions })}>
                            <Icon name="check2" size={12} />{nActions}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
                {col.folded
                  ? <p className="act-empty">{t('poBoardDoneFolded')}</p>
                  : col.orders.length === 0 && <p className="act-empty">{t('actColEmpty')}</p>}
              </div>
            </section>
          );
        })}
      </div>
      {takeover.dialog}
      {reviewPrompt}
    </>
  );
}
