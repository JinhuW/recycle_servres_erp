import { useEffect, useRef, useState } from 'react';
import { TableSkeleton } from '../../../components/Skeleton';
import { fleetApi, type FleetCohortAccount, type FleetCohortCounts, type FleetCohortGroup, type FleetCohortOutcome, type FleetCohortReport } from '../../../lib/fleet';
import { useT } from '../../../lib/i18n';
import { easternDateTime } from './fleetBoard';
import { EmptyRow, useFleetPoll } from './shared';

// Its figures move over hours and days, and it is the fleet's costliest read.
const COHORT_POLL_MS = 5 * 60_000;

// ─── Cohort report ────────────────────────────────────────────────────────────
// A pilot's arms against the launch plan's fixed measurement rules, or with no
// pilot the supplier scorecard. It shows counts and never a verdict: n is small,
// so a percentage always sits next to what it was taken over.

const SCORECARD_DAYS = [30, 90] as const;

const ratio = (n: number, pct: number | null, decided: number) => `${n}/${decided}${pct === null ? '' : ` · ${pct}%`}`;
const failedRatio = (c: FleetCohortCounts) => ratio(c.failed, c.failed_pct, c.decided);
const lostRatio = (c: FleetCohortCounts) => ratio(c.lost, c.lost_pct, c.decided);

function LostCell({ all, unflagged }: { all: FleetCohortCounts; unflagged: FleetCohortCounts }) {
  const { t } = useT();
  const parts: string[] = [];
  if (all.never_healthy) parts.push(`${all.never_healthy} ${t('fleetCohortNeverHealthy')}`);
  if (all.survived_in_loss_state) parts.push(`${all.survived_in_loss_state} ${t('fleetCohortInLossState')}`);
  if (all.unknown) parts.push(`${all.unknown} ${t('fleetCohortUnknown')}`);
  if (all.running) parts.push(`${all.running} ${t('fleetCohortRunning')}`);
  return (
    <td className="num" title={t('fleetCohortFailedHint')}>
      <b className="mono">{failedRatio(all)}</b>
      <div className="fp-muted"><small>{t('fleetCohortStintLost')} <span className="mono">{lostRatio(all)}</span></small></div>
      {unflagged.decided !== all.decided && (
        <div className="fp-muted"><small>{t('fleetCohortUnflagged')} <span className="mono">{failedRatio(unflagged)}</span> ({t('fleetCohortStintLost')} <span className="mono">{lostRatio(unflagged)}</span>)</small></div>
      )}
      {parts.length > 0 && <div className="fp-muted"><small>{parts.join(' · ')}</small></div>}
    </td>
  );
}

export function CohortTable({ rows, label }: { rows: FleetCohortGroup[]; label: (g: FleetCohortGroup) => string }) {
  const { t } = useT();
  return (
    <div className="fp-table-wrap fleet-table-cap fleet-table-short">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th>{t('fleetCohortBatch')}</th>
            <th>{t('fleetCohortArm')}</th>
            <th className="num">{t('fleetCohortClaimed')}</th>
            <th className="num">{t('fleetCohortNeverClaimed')}</th>
            <th className="num">{t('fleetCohortHealthy')}</th>
            <th className="num">{t('fleetCohortFailedStarts')}</th>
            <th className="num">{t('fleetCohortFailed24h')}</th>
            <th className="num">{t('fleetCohortFailed7d')}</th>
            <th className="num">{t('fleetCohortSearches')}</th>
            <th className="num">{t('fleetCohortExitChanged')}</th>
            <th className="num">{t('fleetCohortOutage')}</th>
            <th className="num">{t('fleetCohortRecoveryBoots')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={12}>{t('fleetCohortNone')}</EmptyRow>}
          {rows.map(g => (
            <tr key={`${g.batch ?? ''}/${g.arm}`}>
              <td>{label(g)}</td>
              <td>{t(g.arm === 'cloak' ? 'fleetEngine_cloak' : 'fleetEngine_stock')}</td>
              <td className="num"><b>{g.claimed}</b></td>
              <td className="num">{g.never_claimed}</td>
              <td className="num">
                <span className="mono">{g.reached_healthy}/{g.claimed}</span>
                {g.health_unknown > 0 && <div className="fp-muted"><small>{g.health_unknown} {t('fleetCohortHealthUnknown')}</small></div>}
              </td>
              <td className="num">{g.failed_starts}</td>
              <LostCell {...g.lost_24h} />
              <LostCell {...g.lost_7d} />
              <td className="num">
                {g.searches.all.per_account === null ? <span className="fp-muted">—</span> : <b className="mono">{g.searches.all.per_account}</b>}
                <div className="fp-muted"><small className="mono">{g.searches.all.searches}/{g.searches.all.accounts}</small></div>
              </td>
              <td className="num">{g.exit_change_accounts}</td>
              <td className="num">{g.outage_accounts}</td>
              <td className="num">{g.recovery_boots}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CohortAccounts({ rows }: { rows: FleetCohortAccount[] }) {
  const { t, locale } = useT();
  const outcome = (o: FleetCohortOutcome | null, lostState: boolean) =>
    (o === null ? '—' : lostState ? t('fleetCohortInLossState') : t(`fleetCohortOutcome_${o}`));
  return (
    <div className="fp-table-wrap fleet-table-cap fleet-table-short">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>{t('fleetCohortBatch')}</th>
            <th>{t('fleetCohortArm')}</th>
            <th>{t('fleetCohortFirstClaim')}</th>
            <th>{t('fleetCohortAt24h')}</th>
            <th>{t('fleetCohortAt7d')}</th>
            <th className="num">{t('fleetCohortSearches7d')}</th>
            <th className="num">{t('fleetCohortExitChanged')}</th>
            <th className="num">{t('fleetCohortOutage')}</th>
            <th className="num">{t('fleetCohortRecoveryBoots')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.account_no}>
              <td className="num mono">{a.account_no}</td>
              <td className="fp-muted">{a.batch ?? '—'}</td>
              <td>
                {t(a.arm === 'cloak' ? 'fleetEngine_cloak' : 'fleetEngine_stock')}
                {a.crossed_arm && <>{' '}<span className="chip warn" title={t('fleetCohortCrossedHint')}>{t('fleetCohortCrossed')}</span></>}
              </td>
              <td className="fp-muted">{a.first_claimed_at ? easternDateTime(a.first_claimed_at, locale) : t('fleetCohortNotClaimed')}</td>
              <td>{outcome(a.outcome_24h, a.in_loss_state_24h)}</td>
              <td>{outcome(a.outcome_7d, a.in_loss_state_7d)}</td>
              <td className="num">{a.searches_7d ?? '—'}</td>
              <td className="num">{a.exit_changes}</td>
              <td className="num">{a.licence_outages}</td>
              <td className="num">{a.recovery_boots}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CohortBody({ report }: { report: FleetCohortReport }) {
  const { t } = useT();
  const { seats } = report;
  const label = (g: FleetCohortGroup) => g.batch ?? t('fleetCohortNoBatch');
  return (
    <>
      <p className="fleet-note fleet-cohort-note">
        {t('fleetCohortSeats', { active: seats.active, parked: seats.parked, max: seats.max_slots, cap: seats.pilot_cap })}
      </p>
      {report.arms.length > 1 && <CohortTable rows={report.arms} label={() => t('fleetCohortAllBatches')} />}
      <CohortTable rows={report.groups} label={label} />
      {report.accounts.length > 0 && <CohortAccounts rows={report.accounts} />}
      <p className="fp-muted fleet-note fleet-cohort-note">{t('fleetCohortFailedHint')}</p>
      <p className="fp-muted fleet-note fleet-cohort-note">{t('fleetCohortRules')}</p>
      <p className="fp-muted fleet-note fleet-cohort-note">{t('fleetCohortRecoveryNote')}</p>
    </>
  );
}

export function FleetCohortCard() {
  const { t } = useT();
  const [pilot, setPilot] = useState('');
  const [days, setDays] = useState<number>(SCORECARD_DAYS[0]);
  const { data, failed, reload } = useFleetPoll<FleetCohortReport>(
    () => fleetApi.cohorts(pilot ? { pilot } : { days }),
    COHORT_POLL_MS,
  );
  // The poll has just read this selection on mount.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) reload();
    mounted.current = true;
  }, [pilot, days]);
  const loaded = data && data !== 'unavailable' ? data : null;
  // The answer on hand may still be the last selection's; it mustn't show under this one.
  const report = loaded && loaded.pilot === (pilot || null) && (pilot || loaded.days === days) ? loaded : null;
  return (
    <section className="card fleet-card" aria-label={t('fleetCohortTitle')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('fleetCohortTitle')}</h2>
          <span className="card-sub">{pilot ? t('fleetCohortSubPilot') : t('fleetCohortSubScorecard', { days })}</span>
        </div>
        <div className="page-actions">
          <select className="input fleet-select fleet-cohort-pilot" value={pilot} aria-label={t('fleetCohortPilot')} onChange={e => setPilot(e.target.value)}>
            <option value="">{t('fleetCohortScorecard')}</option>
            {loaded?.pilots.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {!pilot && (
            <select className="input fleet-select" value={days} aria-label={t('fleetCohortDays')} onChange={e => setDays(Number(e.target.value))}>
              {SCORECARD_DAYS.map(d => <option key={d} value={d}>{t('fleetCohortDaysOption', { days: d })}</option>)}
            </select>
          )}
        </div>
      </div>
      {data === 'unavailable' || (report === null && failed) ? <p className="fp-muted fleet-note fleet-cohort-note">{t('fleetCohortUnavailable')}</p>
        : report === null ? <TableSkeleton rows={4} cols={12} />
        : <CohortBody report={report} />}
    </section>
  );
}
