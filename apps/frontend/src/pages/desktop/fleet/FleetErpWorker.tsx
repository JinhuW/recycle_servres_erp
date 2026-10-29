import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { handleFetchError } from '../../../lib/errorToast';
import type { FbWorkerStint } from '../../../lib/facebookPool';
import { fleetSlotRetirable, fleetApi, type FleetCity, type FleetSlot, type FleetWorkerDetail } from '../../../lib/fleet';
import { browserLabel, SESSION_WARN_DAYS } from '../../../lib/fleetView';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { CityChip, fmtDays, HITS_DAYS, stateLabel, WatchButton } from '../FleetAccounts';
import { CityLogCard } from '../FleetCityLog';
import { RemoveFromFleetDialog } from './FleetProxies';
import { SearchNowDialog } from './FleetTasksTab';
import { dueLabel, leaseLive } from './fleetBoard';
import {
  deviceText, erpCheckpoint, erpCityChips, erpCityLog, erpHistory, erpHistoryDot, erpProxyText, erpWorkerStatus, sessionDaysLeft,
  type ErpHistoryLine,
} from './fleetWorkerView';
import { ParkDialog, ReleaseQuarantineButton, RetireSlotDialog, UnparkDialog, useFleetMirror } from './shared';
import {
  AccountsUsed, CheckpointsCard, ErpBuildChip, Muted, NoThumb, WorkerCard, WorkerHead, WorkerHistory, type HistoryEntry, type WorkerField,
} from './workerDetail';

// ─── One ERP-fleet worker ─────────────────────────────────────────────────────
// The homelab worker page (FleetWorker.tsx), fed by the ERP's own fleet: the
// worker row, the slot it holds (or its account's last one), the pool account
// without a secret, the listed proxy, and its tasks and events
// (GET /api/fleet/workers/:id). The actions are the fleet's: watch (the watch
// page, FleetErpWatch.tsx, through the ERP's relay), park or unpark the slot,
// take the account out of the fleet, search a city now. A row the fleet has no source for reads "—".

type Dialog = 'park' | 'unpark' | 'remove' | 'retire' | 'search' | null;

export function ErpWorkerView({ detail: d, stints, onReload, now = Date.now() }: {
  detail: FleetWorkerDetail; stints: FbWorkerStint[] | null; onReload: () => void; now?: number;
}) {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const [dialog, setDialog] = useState<Dialog>(null);
  const w = d.worker;
  const acct = d.account;
  const slot = d.slot ? ({ ...d.slot, worker: d.holds_slot ? w : null } as FleetSlot) : null;
  const name = acct?.email ?? acct?.uid ?? w.worker_id;
  const status = erpWorkerStatus(w, now);
  const checkpoint = erpCheckpoint(w, now);
  const chips = useMemo(() => erpCityChips(d, now), [d, now]);
  const visits = useMemo(() => erpCityLog(d), [d]);
  const history = useMemo(() => erpHistory(d.events, stints ?? []), [d.events, stints]);
  const running = status !== 'offline';
  const canWatch = running && w.vnc_port !== null;
  const task = running ? w.task : null;
  const days = sessionDaysLeft(w, now);
  const device = slot?.device ?? null;
  const ua = browserLabel(device?.user_agent) ?? (device?.native?.includes('user_agent') ? t('fleetUaNative') : null);
  const proxy = erpProxyText(d);
  const heldLease = !!slot && d.holds_slot && leaseLive(slot, now);

  const note = status === 'offline'
    ? (w.last_heartbeat_at ? t('fbcNoteSilent', { age: relTime(w.last_heartbeat_at, locale) }) : t('fbcNeverReported'))
    : checkpoint ? stateLabel(t, checkpoint.state)
    : slot?.parked ? t('fleetNoteParked')
    : task ? t('fleetNoteSearching', { city: task.city_name ?? task.city, item: task.item })
    : t('fleetNoteIdle');

  const slotText = !slot ? <Muted>{t('fleetSlotNone')}</Muted>
    : slot.parked ? <span className="chip warn">{t('fleetNoteParked')}</span>
    : slot.reserved_until ? <span>{t('fleetSlotReserved', { time: dueLabel(t, slot.reserved_until, now) })}</span>
    : heldLease ? <span>{t('fleetEpochN', { n: slot.epoch })} · {t('fleetLeaseUntil', { time: dueLabel(t, slot.lease_expires_at, now) })}</span>
    : <Muted>{t('fleetSlotFree')}</Muted>;

  const fields: WorkerField[] = [
    { label: t('fbcDetailFbLogin'), value: acct?.email ?? acct?.uid ?? <Muted>{t('fleetNoPoolAccount')}</Muted> },
    { label: t('fbcDetailFbUser'), value: acct?.uid
      ? <a className="mono" href={`https://www.facebook.com/profile.php?id=${encodeURIComponent(acct.uid)}`} target="_blank" rel="noopener">{acct.uid}</a>
      : <Muted>—</Muted> },
    { label: t('fleetDetailPoolAccount'), value: acct
      ? <><span className="mono">#{acct.no}</span> <span className={`chip ${acct.status === 'fleet' ? 'muted' : 'warn'}`}>{acct.status}</span>{acct.holder && <span className="fp-muted"> · {acct.holder}</span>}</>
      : <Muted>—</Muted> },
    { label: t('fbcDetailSecrets'), value: acct?.secrets.length
      ? acct.secrets.map(k => <span key={k} className="chip muted mono" style={{ marginRight: 4 }}>{k}</span>)
      : <Muted>{t('fbcNone')}</Muted> },
    { label: t('fbcColSession'), value: days !== null
      ? <span className={days <= SESSION_WARN_DAYS ? 'fp-warn' : 'fp-ok'} title={String(w.detail?.session_expiry)}>{fmtDays(t, days)}</span>
      : <Muted>—</Muted> },
    { label: t('fbcDetailUa'), value: ua || device
      ? <span title={device?.user_agent ?? undefined}>
          {ua ?? '—'}{w.detail?.browser_ok === false && <> <span className="chip warn">{t('fleetBrowserDown')}</span></>}
          {deviceText(device) && <><br /><small className="fp-muted">{deviceText(device)}</small></>}
        </span>
      : <Muted>—</Muted> },
    { label: t('fbcDetailBackup'), value: acct?.cookie_at
      ? <span title={acct.cookie_at}>{relTime(acct.cookie_at, locale)}</span>
      : <Muted>{t('fbcNeverBackedUp')}</Muted> },
    { label: t('fbcDetailProxy'), value: proxy === null ? <Muted>—</Muted>
      : proxy === 'unlisted' ? <Muted>{t('fleetProxyUnlisted')}</Muted>
      : <span>{proxy.label}<br /><small className="fp-muted mono">{proxy.where}</small></span> },
    { label: t('fleetDetailSlot'), value: <>
      {slotText}
      {slot?.quarantined_until && Date.parse(slot.quarantined_until) > now && (
        <><br /><small className="fp-warn">{t('fleetQuarantinedUntil', { time: dueLabel(t, slot.quarantined_until, now) })}</small></>
      )}
    </>, wrap: true },
    { label: t('fbcColCities'), wrap: true, value: <>
      {chips.cities.length
        ? <span className="fl-cities ff-wrap-cell">
            {chips.cities.map(c => <CityChip key={c.slug} city={c} hits={chips.hits} terms={[]} tone="muted" />)}
          </span>
        : <Muted>{t('fbcNoCities')}</Muted>}
      {/* Read as an assigned list otherwise: the queue picks every city. */}
      <small className="fp-muted" style={{ display: 'block', marginTop: 4 }}>{t('fleetCitiesNote', { days: d.stats.days })}</small>
    </> },
    { label: t('fbcFoldPacing'), value: slot
      ? t('fleetPacingBudget', { used: slot.minutes_today, budget: slot.budget_minutes })
      : <Muted>—</Muted> },
    { label: t('fbcDetailSessionFile'), value: <Muted>—</Muted> },
    { label: t('fleetDetailHost'), value: w.host_id ? <span className="mono">{w.host_id}</span> : <Muted>—</Muted> },
    { label: t('fbcColBuild'), value: <ErpBuildChip version={w.version} release={d.release_version} /> },
  ];

  // The watch page, as the homelab worker's Watch browser opens it; a worker
  // with nothing to show gets the button greyed out with the reason.
  const watchButton = (cls: string) => canWatch
    ? <WatchButton workerId={w.worker_id} className={cls} />
    : (
      <button type="button" className={cls} disabled title={running ? t('fleetWatchNoVnc') : t('fleetWorkerNotRunning')}>
        <Icon name="eye" size={13} />{t('fbcWatchBrowser')}
      </button>
    );
  // Removing deletes the slot, which only a slot nobody holds allows.
  const removable = !!slot && (slot.parked || !leaseLive(slot, now)) && !slot.reserved_until;
  // A lost account on this worker's own slot, or on one parked with none.
  const retirable = !!slot && (d.holds_slot || slot.worker_id === null)
    && fleetSlotRetirable({ parked: slot.parked, poolStatus: slot.pool_status, state: w.state, operator: w.detail?.operator === true });

  return (
    <div className="fp-pool">
      <WorkerHead title={name} status={status}
        sub={<><span className="mono">{w.worker_id}</span> · {w.host_id ?? '—'}{note && ` · ${note}`}</>} />

      <div className="ff-worker-layout">
        <div className="ff-worker-main">
          <WorkerCard name={name} status={status} userId={acct?.email ? acct.uid : null}
            stubNote={w.last_heartbeat_at ? t('fbcHeartbeatAge', { age: relTime(w.last_heartbeat_at, locale) }) : t('fbcNeverReported')}
            headSub={<>{w.host_id ?? '—'} · {t('fbcCities', { n: chips.cities.length })}</>}
            stats={[
              { label: t('fbcColAlerts', { days: HITS_DAYS }), value: d.stats.alerts },
              { label: t('fbcColLastSearch'), value: d.stats.last_search_at ? relTime(d.stats.last_search_at, locale) : '—' },
              { label: t('fbcDetailLastListing'), value: '—' },
              { label: t('fbcDetailErrors'), value: d.stats.errors },
              { label: t('fbcOpenCheckpoints'), value: checkpoint ? 1 : 0 },
            ]}
            fields={fields}
            actions={<>
              {watchButton('btn')}
              {!mirror && <>
                {slot && !slot.parked && <button type="button" className="btn" onClick={() => setDialog('park')}>{t('fleetPark')}</button>}
                {slot?.parked && <button type="button" className="btn" onClick={() => setDialog('unpark')}>{t('fleetUnpark')}</button>}
                {slot && (
                  <button type="button" className="btn" onClick={() => setDialog('remove')} disabled={!removable}
                    title={removable ? undefined : t('fleetRemoveHeld')}>{t('fpRemoveFromFleet')}</button>
                )}
                {retirable && <button type="button" className="btn fleet-danger-text" onClick={() => setDialog('retire')}>{t('fleetRetireFree')}</button>}
                <button type="button" className="btn" onClick={() => setDialog('search')}>{t('fleetSearchCityNow')}</button>
              </>}
              {slot?.quarantined_until && Date.parse(slot.quarantined_until) > now && <ReleaseQuarantineButton slot={slot} onDone={onReload} />}
            </>} />

          <CheckpointsCard sub={t('fleetCheckpointsSub')} items={checkpoint ? [{
            key: 'wall',
            thumb: <NoThumb />,
            kind: checkpoint.kind,
            what: <><span className="mono">{w.worker_id}</span> {t('fbcAttnParked', { kind: checkpoint.kind })}</>,
            sub: <>
              {checkpoint.seenAt && t('fleetCheckpointSeen', { age: relTime(checkpoint.seenAt, locale) })}
              {checkpoint.reason && ` · ${checkpoint.reason}`}
              {checkpoint.url && <> · <a href={checkpoint.url} target="_blank" rel="noreferrer" className="mono">{checkpoint.url}</a></>}
            </>,
            actions: <>
              {watchButton('btn sm')}
              {slot && !slot.parked && !mirror && <button type="button" className="btn sm" onClick={() => setDialog('park')}>{t('fleetPark')}</button>}
            </>,
          }] : []} />

          <AccountsUsed stints={stints} locale={locale} />
          <CityLogCard log={visits} />
        </div>
        <WorkerHistory entries={history.map(line => historyEntry(line))} locale={locale} />
      </div>

      {dialog === 'park' && slot && <ParkDialog slot={slot} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
      {dialog === 'unpark' && slot && <UnparkDialog slot={slot} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
      {dialog === 'remove' && slot && <RemoveFromFleetDialog slot={slot} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
      {dialog === 'retire' && slot && <RetireSlotDialog accountNo={slot.account_no} workerId={w.worker_id} operator={w.detail?.operator === true}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
      {dialog === 'search' && <SearchCityDialog detail={d} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onReload(); }} />}
    </div>
  );
}

function historyEntry(line: ErpHistoryLine): HistoryEntry {
  return { at: line.at, dot: erpHistoryDot(line), text: <ErpHistoryText line={line} /> };
}

function ErpHistoryText({ line }: { line: ErpHistoryLine }) {
  const { t } = useT();
  if (line.kind === 'signon') return <>{t('fbcHistSignOn', { n: line.stint.accountNo, login: line.stint.email ?? line.stint.uid })}</>;
  if (line.kind === 'left') return <>{t('fbcHistLeft', { n: line.stint.accountNo, outcome: t(`fbcStint_${line.stint.outcome}`) })}</>;
  const e = line.event;
  const where = { city: e.city_name ?? e.city, item: e.task_kind === 'search' ? e.item : e.task_kind };
  const d = e.detail ?? {};
  const word = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (e.kind === 'done') {
    if (d.stopped === true) return <>{t('fleetHist_doneStopped', where)}</>;
    return <>{t('fleetHist_done', { ...where, cards: Number(d.cards ?? 0), alerts: Number(d.alerted ?? 0) })}</>;
  }
  if (e.kind === 'stopped') {
    const reason = [word(d.reason), word(d.wall)].filter(Boolean).join(' · ') || word(d.error) || '—';
    return <>{t('fleetHist_stopped', { ...where, reason })}</>;
  }
  if (e.kind === 'released') {
    const reason = word(d.reason);
    return <>{t('fleetHist_released', { ...where, reason: reason ? stateLabel(t, reason) : '—' })}</>;
  }
  return <>{t('fleetHist_expired', where)}</>;
}

// Search now needs the city list and the items, which the page does not keep;
// they are read when the dialog opens.
function SearchCityDialog({ detail, onClose, onDone }: { detail: FleetWorkerDetail; onClose: () => void; onDone: () => void }) {
  const [catalog, setCatalog] = useState<{ cities: FleetCity[]; items: string[] } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    let live = true;
    Promise.all([fleetApi.cities(), fleetApi.items()])
      .then(([cities, items]) => { if (live) setCatalog({ cities, items: items.filter(i => i.enabled).map(i => i.name) }); })
      .catch(err => { if (live) { handleFetchError(err); closeRef.current(); } });
    return () => { live = false; };
  }, []);
  if (!catalog) return null;
  const initial = detail.cities[0]?.slug ?? '';
  return <SearchNowDialog cities={catalog.cities} items={catalog.items} tasks={detail.log} initial={initial} onClose={onClose} onDone={onDone} />;
}
