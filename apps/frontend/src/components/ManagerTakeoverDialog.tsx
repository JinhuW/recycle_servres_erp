// Asked before a manager moves a PO that another manager is handling: take it
// over, or leave it with them. Declining still moves the order — the stage
// and the manager are separate questions — and only Cancel stops the move.
// Every door that moves a PO asks through this one hook, so the question reads
// the same wherever it is met.

import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { asksManagerTakeover } from '../lib/poPermissions';

export type TakeoverChoice = 'take' | 'keep';

type TakeoverTarget = { id: string; manager?: { id: string; name: string } | null };

// `ask` resolves 'keep' at once when there is nothing to ask, null on Cancel.
// The caller sends `takeManager: true` with its move only on 'take'.
export function useManagerTakeover(): {
  ask: (o: TakeoverTarget) => Promise<TakeoverChoice | null>;
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

  const ask = (o: TakeoverTarget): Promise<TakeoverChoice | null> => {
    if (!o.manager || !asksManagerTakeover(o.manager, user)) return Promise.resolve('keep');
    const name = o.manager.name;
    resolver.current?.(null);
    return new Promise((resolve) => {
      resolver.current = resolve;
      setPending({ id: o.id, name });
    });
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

  return { ask, asking: pending !== null, dialog };
}
