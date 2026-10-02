import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { asksToMoveToReviewing } from '../../lib/boxCheck';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { navigate, poCheckPath } from '../../lib/route';
import type { Order } from '../../lib/types';

// The way into review mode from the PO page and the PO list. A PO not yet at
// Reviewing is offered the move first, since Approve is only offered there.

export type ReviewTarget = { id: string; lifecycle: string; archived: boolean; status: string };

export function useReviewModeEntry(): { enter: (o: ReviewTarget) => void; prompt: ReactNode } {
  const { t } = useT();
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const enter = (o: ReviewTarget) => {
    if (asksToMoveToReviewing(o)) setTarget(o);
    else navigate(poCheckPath(o.id));
  };

  const close = () => { if (!busy) setTarget(null); };

  const move = async () => {
    if (!target) return;
    setBusy(true);
    // Set when the PO turned out to be somewhere else: it is entered afresh
    // from where it really stands instead of being moved.
    let elsewhere: ReviewTarget | null = null;
    try {
      // `toStage` is a jump: from a stale row it would move a PO that has
      // since passed Reviewing backwards, or one sent back to Draft forwards
      // past its re-submission. Only the stage the manager was shown moves.
      const fresh = (await api.get<{ order: Order }>(`/api/orders/${target.id}`)).order;
      if (fresh.lifecycle !== target.lifecycle || fresh.archivedAt !== null) {
        elsewhere = { id: fresh.id, lifecycle: fresh.lifecycle, archived: fresh.archivedAt !== null, status: fresh.status };
      } else {
        await api.post(`/api/orders/${target.id}/advance`, { toStage: 'reviewing' });
      }
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
      setTarget(null);
      return;
    }
    setBusy(false);
    setTarget(null);
    if (elsewhere) enter(elsewhere);
    else navigate(poCheckPath(target.id));
  };

  const prompt = target && (
    <Modal onClose={close} shellStyle={{ maxWidth: 460 }}>
      <div className="modal-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="package" size={18} />
          </div>
          <div>
            <div className="modal-title">{t('bcMoveTitle', { id: target.id })}</div>
            <div className="modal-sub">{t('bcMoveMsg', { id: target.id, s: target.status })}</div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy} onClick={close}>{t('cancel')}</button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => { const id = target.id; setTarget(null); navigate(poCheckPath(id)); }}
        >
          {t('bcMoveSkip')}
        </button>
        <button className="btn accent" disabled={busy} onClick={() => { void move(); }} autoFocus>
          {busy ? '…' : t('bcMoveConfirm')}
        </button>
      </div>
    </Modal>
  );

  return { enter, prompt };
}
