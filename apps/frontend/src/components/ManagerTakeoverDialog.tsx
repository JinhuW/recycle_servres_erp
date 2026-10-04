// Asked before a manager moves a PO that another manager is handling: take it
// over, or leave it with them. Declining still moves the order — the stage
// and the manager are separate questions — and only Cancel stops the move.
// Every door that moves a PO asks through this one hook, so the question reads
// the same wherever it is met.

import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { asksManagerTakeover, readManagerChanged, type TakeoverAnswer } from '../lib/poPermissions';

type TakeoverChoice = 'take' | 'keep';

type TakeoverTarget = { id: string; manager?: { id: string; name: string } | null };

// `ask` resolves at once when there is nothing to ask, null on Cancel; its
// answer rides on the move as part of the /advance body. `advance` posts that
// move, and when the server says the order's manager has changed since the
// page loaded, asks again about the one it named — the question a stale page
// would otherwise never put. False when that second question is cancelled.
export function useManagerTakeover(): {
  ask: (o: TakeoverTarget) => Promise<TakeoverAnswer | null>;
  advance: (o: { id: string }, body: Record<string, unknown>, answer: TakeoverAnswer) => Promise<boolean>;
  asking: boolean;
  dialog: ReactNode;
} {
  const { t } = useT();
  const { user } = useAuth();
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  // Held outside state so a second ask can settle the first instead of
  // stranding the move that is awaiting it.
  const resolver = useRef<((c: TakeoverChoice | null) => void) | null>(null);

  const answer = (c: TakeoverChoice | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(c);
  };

  const ask = async (o: TakeoverTarget): Promise<TakeoverAnswer | null> => {
    const fromManagerId = o.manager?.id ?? null;
    if (!o.manager || !asksManagerTakeover(o.manager, user)) return { fromManagerId };
    const name = o.manager.name;
    resolver.current?.(null);
    const choice = await new Promise<TakeoverChoice | null>((resolve) => {
      resolver.current = resolve;
      setPending({ id: o.id, name });
    });
    if (choice === null) return null;
    return choice === 'take' ? { fromManagerId, takeManager: true } : { fromManagerId };
  };

  const advance = async (
    o: { id: string }, body: Record<string, unknown>, first: TakeoverAnswer,
  ): Promise<boolean> => {
    const post = (a: TakeoverAnswer) => api.post(`/api/orders/${o.id}/advance`, { ...body, ...a });
    try {
      await post(first);
      return true;
    } catch (e) {
      const manager = readManagerChanged(e);
      if (manager === undefined) throw e;
      const again = await ask({ id: o.id, manager });
      if (again === null) return false;
      // Nothing to ask about the new one (nobody, or the mover): a "make me
      // the manager" already given still stands.
      const take = asksManagerTakeover(manager, user) ? again.takeManager : first.takeManager;
      await post(take ? { ...again, takeManager: true } : again);
      return true;
    }
  };

  const dialog = pending && (
    <Modal onClose={() => answer(null)} shellStyle={{ maxWidth: 460 }} ariaLabel={t('mgrTakeTitle', { name: pending.name, id: pending.id })}>
      <div className="modal-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="user" size={18} />
          </div>
          <div>
            <div className="modal-title">{t('mgrTakeTitle', { name: pending.name, id: pending.id })}</div>
            <div className="modal-sub">{t('mgrTakeMsg')}</div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => answer(null)}>{t('cancel')}</button>
        <button className="btn" onClick={() => answer('keep')}>{t('mgrKeep', { name: pending.name })}</button>
        <button className="btn accent" onClick={() => answer('take')} autoFocus>{t('mgrTakeConfirm')}</button>
      </div>
    </Modal>
  );

  return { ask, advance, asking: pending !== null, dialog };
}
