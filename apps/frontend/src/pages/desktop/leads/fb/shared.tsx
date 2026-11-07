import type { ReactNode } from 'react';
import type { FbMessage, FbPlacementState, FbSellerAccount, FbThreadStage } from '@recycle-erp/shared';
import { SEND_STATE_TONE, threadStranded } from '../../../../lib/fbSeller';
import { fmtUSD0, relTime } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';

// Pieces every Leads ▸ Facebook tab draws with. The table and empty-state
// chrome is Leads ▸ Reddit's (styles/redditLeads.css); fbSeller.css only adds
// what is new here.

export function Table({ head, children, foot }: { head: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="card rl-card">
      <div className="table-scroll"><table className="rl-table"><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>
      {foot && <div className="rl-foot">{foot}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card rl-card"><div className="rl-empty">{children}</div></div>;
}

const STAGE_CLASS: Record<FbThreadStage, string> = {
  new: 'rl-st-claimed', screening: 'rl-st-dm', negotiating: 'rl-st-replied', closing: 'rl-st-talks', won: 'rl-st-won', lost: 'rl-st-closed',
};
export function StageChip({ stage }: { stage: FbThreadStage }) {
  const { t } = useT();
  return <span className={`rl-st ${STAGE_CLASS[stage]}`}>{t(`fbs_stage_${stage}`)}</span>;
}

/** An outbound message's send state, in words; nothing for inbound. */
export function SendChip({ m }: { m: Pick<FbMessage, 'send_state' | 'error'> }) {
  const { t } = useT();
  if (!m.send_state) return null;
  return (
    <span className={`chip ${SEND_STATE_TONE[m.send_state]} fbs-send`} data-send={m.send_state} title={m.error ?? t(`fbs_send_hint_${m.send_state}`)}>
      {t(`fbs_send_${m.send_state}`)}
    </span>
  );
}

const PLACEMENT_TONE: Record<FbPlacementState, string> = {
  needs_photos: 'warn', queued: 'muted', live: 'pos', removing: 'info', removed: 'muted', failed: 'neg', uncertain: 'warn',
};
export function PlacementChip({ state }: { state: FbPlacementState }) {
  const { t } = useT();
  return <span className={`chip ${PLACEMENT_TONE[state]}`}>{t(`fbs_pl_${state}`)}</span>;
}

export function Money({ usd }: { usd: number | null | undefined }) {
  const { locale } = useT();
  return usd === null || usd === undefined ? <span className="rl-muted">—</span> : <>{fmtUSD0(usd, locale)}</>;
}

export function Ago({ at }: { at: string | null | undefined }) {
  const { locale } = useT();
  return at ? <time dateTime={at} title={new Date(at).toLocaleString(locale)}>{relTime(at, locale)}</time> : <span className="rl-muted">—</span>;
}

/** The account a thread or placement runs on, marked stranded when it is gone, retired or no longer a seller. */
export function AccountCell({ no, accounts }: { no: number | null; accounts: readonly FbSellerAccount[] | null }) {
  const { t } = useT();
  const stranded = threadStranded(no, accounts);
  return (
    <span className="fbs-acct">
      {no === null ? <span className="rl-muted">{t('fbs_account_gone')}</span> : <span className="mono">#{no}</span>}
      {stranded && <span className="chip warn" title={t('fbs_stranded_hint')}>{t('fbs_stranded')}</span>}
    </span>
  );
}

export function Field({ label, hint, error, children, wide }: { label: string; hint?: string; error?: string | null; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field fbs-field${wide ? ' fbs-wide' : ''}`}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="help fbs-error">{error}</span> : hint ? <span className="help">{hint}</span> : null}
    </label>
  );
}
