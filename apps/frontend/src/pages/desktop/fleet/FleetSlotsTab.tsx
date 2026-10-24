import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { fleetApi, type FleetSlot } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { hrefFor, onLinkClick } from '../../../lib/route';
import { isQuarantined, leaseLive, maskUid } from './fleetBoard';
import { BudgetRing, Clock, ConfirmDialogBody, EmptyRow, TabCard, UnavailableCard, useFleetPoll, WorkerLink } from './shared';

// ─── Slots ────────────────────────────────────────────────────────────────────
// One row per pool account the fleet may run: which worker holds it, on which
// host, under which epoch (a stale epoch is how a second copy of the account
// is refused), how long its lease has, how much of today's budget it has
// used, and whether it is quarantined because its searches found nothing
// where other accounts found listings. The pool page keeps the credentials.

const POOL_CHIP: Record<string, string> = {
  available: 'chip pos', taken: 'chip info', fleet: 'chip accent', problem: 'chip warn', retired: 'chip muted',
};
const POOL_KEY: Record<string, string> = {
  available: 'fpAvailable', taken: 'fpTaken', fleet: 'fpInFleet', problem: 'fpProblem', retired: 'fpRetired',
};

const STATE_CHIP: Record<string, string> = {
  HEALTHY: 'chip pos', DEGRADED: 'chip warn', SESSION_EXPIRED: 'chip warn', CHECKPOINT: 'chip accent',
  CHALLENGE_2FA: 'chip accent', CHALLENGE_EMAIL: 'chip accent', CHALLENGE_CAPTCHA: 'chip accent', DEAD: 'chip neg',
};

export function FleetSlotsTab() {
  const { t } = useT();
  const { data, reload } = useFleetPoll(() => fleetApi.slots());
  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const slots = data ?? [];
  const held = slots.filter(s => s.worker_id && leaseLive(s)).length;
  return (
    <div className="fp-pool">
      <TabCard title={t('fleetSlotsTitle')} className="fleet-slots"
        sub={data ? t('fleetSlotsSub', { held, n: slots.length, quarantined: slots.filter(s => isQuarantined(s)).length }) : ''}
        actions={
          <a className="btn sm" href={hrefFor('/fleet/pool')} onClick={onLinkClick('/fleet/pool')}>
            <Icon name="users" size={13} />{t('fleetSlotsPoolLink')}
          </a>
        }>
        {data === null ? <TableSkeleton rows={6} cols={9} /> : <SlotsTable slots={slots} onChanged={reload} />}
      </TabCard>
    </div>
  );
}

export function SlotsTable({ slots, onChanged, now = Date.now() }: { slots: readonly FleetSlot[]; onChanged: () => void; now?: number }) {
  const { t } = useT();
  const [busy, setBusy] = useState<number | null>(null);
  const [parking, setParking] = useState<FleetSlot | null>(null);

  const releaseQuarantine = async (s: FleetSlot) => {
    if (busy) return;
    setBusy(s.account_no);
    try {
      await fleetApi.releaseQuarantine(s.account_no);
      showSuccessToast(t('fleetQuarantineReleased', { no: s.account_no }));
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fp-table-wrap">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th className="num">{t('fpNo')}</th>
            <th>{t('fpUid')}</th>
            <th>{t('fpStatus')}</th>
            <th>{t('fleetColHost')}</th>
            <th>{t('fleetColWorker')}</th>
            <th className="num">{t('fleetColEpoch')}</th>
            <th>{t('fleetColLease')}</th>
            <th>{t('fleetColMinutes')}</th>
            <th>{t('fleetColQuarantine')}</th>
            <th aria-label={t('fleetColActions')} />
          </tr>
        </thead>
        <tbody>
          {slots.length === 0 && <EmptyRow cols={10}>{t('fleetSlotsNone')}</EmptyRow>}
          {slots.map(s => {
            const live = leaseLive(s, now);
            const quarantined = isQuarantined(s, now);
            const state = s.worker?.state ?? null;
            const rowBusy = busy === s.account_no;
            return (
              <tr key={s.account_no}>
                <td className="num mono">#{s.account_no}</td>
                <td className="mono" title={t('fleetUidMasked')}>{maskUid(s.uid)}</td>
                <td>
                  <span className="fp-holder">
                    <span className={POOL_CHIP[s.pool_status] ?? 'chip muted'}>{POOL_KEY[s.pool_status] ? t(POOL_KEY[s.pool_status]) : s.pool_status}</span>
                    {state && <small><span className={STATE_CHIP[state] ?? 'chip muted'}>{state}</span></small>}
                  </span>
                </td>
                <td>
                  <span className="fp-holder">
                    <span className="mono">{s.host_id ?? <span className="fp-muted">—</span>}</span>
                    {!s.host_id && s.last_host_id && <small>{t('fleetLastHost', { host: s.last_host_id })}</small>}
                  </span>
                </td>
                <td>
                  <span className="fp-holder">
                    <span className={live ? undefined : 'fp-muted'}><WorkerLink id={s.worker_id} /></span>
                    {s.worker?.task && <small>{t('fleetSlotNow', { city: s.worker.task.city_name ?? s.worker.task.city, item: s.worker.task.item })}</small>}
                  </span>
                </td>
                <td className="num mono">{s.epoch}</td>
                <td>
                  {s.lease_expires_at ? (
                    <span className="fp-holder">
                      <span className={live ? '' : 'fp-muted'}>{t(live ? 'fleetLeaseLive' : 'fleetLeaseLapsed')}</span>
                      <small><Clock at={s.lease_expires_at} now={now} /></small>
                    </span>
                  ) : <span className="fp-muted">{t('fleetLeaseNone')}</span>}
                </td>
                <td><BudgetRing minutes={s.minutes_today} budget={s.budget_minutes} /></td>
                <td>
                  {quarantined ? (
                    <span className="fp-holder">
                      <span className="chip warn">{t('fleetQuarantined')}</span>
                      <small>{t('fleetQuarantinedUntil')} <Clock at={s.quarantined_until} now={now} /></small>
                    </span>
                  ) : <span className="fp-muted">—</span>}
                </td>
                <td className="fleet-row-actions">
                  {quarantined && (
                    <button type="button" className="btn sm" onClick={() => releaseQuarantine(s)} disabled={rowBusy} title={t('fleetQuarantineReleaseHint')}>{t('fleetQuarantineRelease')}</button>
                  )}
                  {live && (
                    <button type="button" className="btn sm" onClick={() => setParking(s)} disabled={rowBusy}>{t('fleetPark')}</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {parking && <ParkDialog slot={parking} onClose={() => setParking(null)} onDone={() => { setParking(null); onChanged(); }} />}
    </div>
  );
}

// Parking frees the account: its worker's next call is refused and the
// container exits, so a manager must mean it.
function ParkDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.parkSlot(slot.account_no);
      showSuccessToast(t('fleetParked', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetParkTitle', { no: slot.account_no })} confirm={t('fleetPark')} busy={busy} danger
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetParkBody', { worker: slot.worker_id ?? '—' })}</p>
          <p className="fp-warn">{t('fleetParkWarn')}</p>
        </>} />
    </Modal>
  );
}
