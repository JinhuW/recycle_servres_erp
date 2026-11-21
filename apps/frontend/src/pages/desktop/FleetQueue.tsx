import { useState } from 'react';
import { coordinatorApi, type FleetAccount, type FleetDoc } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import { queueCityName } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import '../../styles/facebookPool.css';

// ─── The city queue ───────────────────────────────────────────────────────────
// Enrolled workers ask the coordinator for each city instead of walking their
// own lists. The worker page says what one worker took and moves it in or out
// of the queue.

/** The worker page's "City queue" row. */
export function QueueField({ worker: w, fleet }: { worker: FleetAccount; fleet: FleetDoc }) {
  const { t } = useT();
  const q = w.queue;
  if (!q) return null;
  if (q.quarantined) {
    return <span><span className="chip warn">{t('fbcQueueQuarantined')}</span> {t('fbcQueueQuarantinedNote')}</span>;
  }
  if (!q.enrolled) {
    return <span className="fp-muted">
      {t(q.capable ? 'fbcQueueOut' : 'fbcQueueOutOld', { version: q.version ?? t('fbcQueueUnknownVersion') })}
    </span>;
  }
  if (!q.capable) {
    return <span className="fp-warn">{t('fbcQueueInOld', { version: q.version ?? t('fbcQueueUnknownVersion') })}</span>;
  }
  const now = q.open[0];
  return (
    <span>
      {t('fbcQueueIn', { minutes: q.minutes_today, budget: q.budget_minutes, n: q.handed_today })}
      {now && <> {t('fbcQueueNow', { city: queueCityName(fleet, now.city), item: now.item })}</>}
    </span>
  );
}

/** Move one worker into the queue, or back to its own list. */
export function QueueButton({ worker: w, onSaved }: { worker: FleetAccount; onSaved: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const q = w.queue;
  if (!q) return null;
  const joining = !q.enrolled;
  const blocked = joining && !q.capable;

  async function toggle() {
    if (busy || blocked) return;
    setBusy(true);
    try {
      await coordinatorApi.setWorkerQueue(w.worker_id, joining);
      showSuccessToast(t(joining ? 'fbcQueueJoined' : 'fbcQueueLeft', { id: w.worker_id }));
      onSaved();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" onClick={toggle} disabled={busy || blocked}
      title={blocked ? t('fbcQueueJoinOld', { version: q.version ?? t('fbcQueueUnknownVersion') }) : undefined}>
      {t(joining ? 'fbcQueueJoin' : 'fbcQueueLeave')}
    </button>
  );
}
