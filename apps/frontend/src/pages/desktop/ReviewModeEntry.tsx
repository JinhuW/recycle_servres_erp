import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useManagerTakeover } from '../../components/ManagerTakeoverDialog';
import { Modal } from '../../components/Modal';
import { asksToMoveToReviewing, readStageMoved, stashEntryAnswer } from '../../lib/boxCheck';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { poStageName } from '../../lib/orderPresentation';
import { navigate, poCheckPath } from '../../lib/route';

// The way into review mode from the PO page and the PO list. A PO not yet at
// Reviewing is offered the move first, since Approve is only offered there.

export type ReviewTarget = {
  id: string; lifecycle: string; archived: boolean;
  manager?: { id: string; name: string } | null;
};

// `onStale` hears where a PO really stands when a move finds it gone from the
// stage the caller showed, so the caller can stop showing the old one.
export function useReviewModeEntry(
  opts: { onStale?: (id: string, lifecycle: string) => void } = {},
): { enter: (o: ReviewTarget) => void; prompt: ReactNode } {
  const { t } = useT();
  const [target, setTarget] = useState<ReviewTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const takeover = useManagerTakeover();

  const enter = (o: ReviewTarget) => {
    // A visit's answer is its own: one from an earlier visit asks again.
    stashEntryAnswer(o.id, null);
    if (asksToMoveToReviewing(o)) setTarget(o);
    else navigate(poCheckPath(o.id));
  };

  const close = () => { if (!busy && !takeover.asking) setTarget(null); };

  const move = async () => {
    if (!target) return;
    // Cancelling the takeover question leaves this prompt up, unmoved.
    const answer = await takeover.ask(target);
    if (answer === null) return;
    setBusy(true);
    // Set when the PO turned out to be somewhere else: it is entered afresh
    // from where it really stands instead of being moved.
    let elsewhere: string | null = null;
    try {
      // `toStage` is a jump: from a stale row it would move a PO that has
      // since passed Reviewing backwards, or one sent back to Draft forwards
      // past its re-submission. `fromStage` has the server refuse, under the
      // row lock, anything but the stage the manager was shown. Review mode
      // collects none of the hand-off's facts, so a Draft it jumps past In
      // Transit must carry them already (`enforce`).
      const moved = await takeover.advance(target, {
        toStage: 'reviewing', fromStage: target.lifecycle, enforce: 'all',
      }, answer);
      if (!moved) { setBusy(false); return; }
    } catch (e) {
      elsewhere = readStageMoved(e);
      if (elsewhere === null) {
        handleFetchError(e);
        setBusy(false);
        setTarget(null);
        return;
      }
    }
    setBusy(false);
    setTarget(null);
    if (elsewhere !== null) {
      opts.onStale?.(target.id, elsewhere);
      enter({ ...target, lifecycle: elsewhere, archived: false });
    } else {
      // Approve asks the same question; answered here, it isn't asked twice.
      stashEntryAnswer(target.id, answer);
      navigate(poCheckPath(target.id));
    }
  };

  // While the takeover question is up this prompt waits under it.
  const locked = busy || takeover.asking;

  // Siblings, not nested: the takeover question sits on top of this prompt.
  const prompt = (
    <>
      {target && (
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
                <div className="modal-sub">{t('bcMoveMsg', { id: target.id, s: poStageName(target.lifecycle, t) })}</div>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn" disabled={locked} onClick={close}>{t('cancel')}</button>
            <button
              className="btn"
              disabled={locked}
              onClick={() => { const id = target.id; setTarget(null); navigate(poCheckPath(id)); }}
            >
              {t('bcMoveSkip')}
            </button>
            <button className="btn accent" disabled={locked} onClick={() => { void move(); }} autoFocus>
              {busy ? '…' : t('bcMoveConfirm')}
            </button>
          </div>
        </Modal>
      )}
      {takeover.dialog}
    </>
  );

  return { enter, prompt };
}
