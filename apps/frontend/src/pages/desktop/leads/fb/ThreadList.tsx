import { useEffect, useState } from 'react';
import { Icon } from '../../../../components/Icon';
import { TableSkeleton } from '../../../../components/Skeleton';
import type { FbThreadRow } from '@recycle-erp/shared';
import { fbSellerApi, sortNeedsHuman, usePolled } from '../../../../lib/fbSeller';
import { useT } from '../../../../lib/i18n';
import { fbSellerThreadPath, hrefFor, onLinkClick } from '../../../../lib/route';
import { AccountCell, Ago, Empty, Money, StageChip, Table } from './shared';

// Needs human and Inbox are one list read two ways: Needs human is the
// threads waiting on a manager, closing deals first, then whoever has waited
// longest; Inbox is every open thread (closed ones behind a filter), newest
// first, searchable.

const POLL_MS = 30_000;

export function ThreadList({ view }: { view: 'needs_human' | 'inbox' }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(false);
  const [account, setAccount] = useState('');
  // The search asks the server once typing pauses, not on every key.
  const [needle, setNeedle] = useState('');
  useEffect(() => { const h = window.setTimeout(() => setNeedle(q.trim()), 300); return () => window.clearTimeout(h); }, [q]);
  const which = view === 'inbox' && closed ? 'closed' : view;
  const { data } = usePolled(
    () => fbSellerApi.threads(which, { q: needle || undefined, account_no: account ? Number(account) : undefined }),
    POLL_MS, [which, needle, account],
  );
  const accts = usePolled(() => fbSellerApi.accounts(), null, []);
  const accounts = accts.data?.rows ?? null;

  const rows = data ? (view === 'needs_human' ? sortNeedsHuman(data.rows) : data.rows) : null;

  const tools = view === 'inbox' && (
    <div className="fbs-tools">
      <div className="seg" role="group" aria-label={t('fbs_inbox_filter')}>
        <button className={!closed ? 'active' : ''} aria-pressed={!closed} onClick={() => setClosed(false)}>{t('fbs_inbox_open')}</button>
        <button className={closed ? 'active' : ''} aria-pressed={closed} onClick={() => setClosed(true)}>{t('fbs_inbox_closed')}</button>
      </div>
      <select className="input" value={account} onChange={e => setAccount(e.target.value)} aria-label={t('fbs_col_account')}>
        <option value="">{t('fbs_all_accounts')}</option>
        {(accounts ?? []).filter(a => a.role === 'seller' || a.open_threads > 0).map(a => (
          <option key={a.account_no} value={a.account_no}>#{a.account_no}</option>
        ))}
      </select>
      <label className="toolbar-search rl-search">
        <Icon name="search" size={14} />
        <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t('fbs_search')} aria-label={t('fbs_search')} />
      </label>
    </div>
  );

  if (!rows) return <>{tools}<TableSkeleton rows={6} cols={6} /></>;
  if (!rows.length) {
    return <>{tools}<Empty><p>{view === 'needs_human' ? t('fbs_needs_empty') : q ? t('fbs_inbox_no_match', { q }) : t('fbs_inbox_empty')}</p></Empty></>;
  }

  return (
    <>
      {tools}
      {view === 'needs_human' ? <NeedsTable rows={rows} accounts={accounts} /> : <InboxTable rows={rows} accounts={accounts} />}
    </>
  );
}

/** The newer of the last message in and out; the row's own update time otherwise. */
function lastActivity(r: FbThreadRow): string {
  const at = [r.last_inbound_at, r.last_outbound_at].filter((x): x is string => !!x).sort();
  return at[at.length - 1] ?? r.updated_at;
}

function SellerLink({ row }: { row: FbThreadRow }) {
  const { t } = useT();
  const href = fbSellerThreadPath(row.id);
  return (
    <>
      <a className="rl-user" href={hrefFor(href)} onClick={onLinkClick(href)}>{row.seller_name || t('fbs_unknown_seller')}</a>
      <span className="rl-sub rl-clip">{row.listing_title}</span>
    </>
  );
}

function NeedsTable({ rows, accounts }: { rows: FbThreadRow[]; accounts: Parameters<typeof AccountCell>[0]['accounts'] }) {
  const { t } = useT();
  return (
    <Table head={<>
      <th>{t('fbs_col_seller')}</th><th>{t('fbs_col_account')}</th><th>{t('fbs_col_reason')}</th>
      <th className="rl-num">{t('fbs_col_offer')}</th><th className="rl-num">{t('fbs_col_ceiling')}</th><th>{t('fbs_col_waiting')}</th>
    </>}>
      {rows.map(r => (
        <tr key={r.id} className={r.stage === 'closing' ? 'fbs-closing' : undefined}>
          <td><SellerLink row={r} /></td>
          <td><AccountCell no={r.account_no} accounts={accounts} /></td>
          <td className="fbs-reason">
            {r.stage === 'closing' && <span className="chip accent">{t('fbs_stage_closing')}</span>}{' '}
            {r.human_reason ?? t('fbs_no_reason')}
          </td>
          <td className="rl-num"><Money usd={r.offer_usd} /></td>
          <td className="rl-num"><Money usd={r.ceiling_usd} /></td>
          <td><Ago at={r.human_at} /></td>
        </tr>
      ))}
    </Table>
  );
}

function InboxTable({ rows, accounts }: { rows: FbThreadRow[]; accounts: Parameters<typeof AccountCell>[0]['accounts'] }) {
  const { t } = useT();
  return (
    <Table head={<>
      <th className="fbs-dotcol" aria-label={t('fbs_unread')} /><th>{t('fbs_col_seller')}</th><th>{t('fbs_col_stage')}</th>
      <th>{t('fbs_col_account')}</th><th>{t('fbs_col_last')}</th><th className="rl-num">{t('fbs_col_offer')}</th><th>{t('fbs_col_updated')}</th>
    </>}>
      {rows.map(r => (
        <tr key={r.id} className={r.unread ? 'fbs-unread' : undefined}>
          <td className="fbs-dotcol">{r.unread && <span className="fbs-dot" title={t('fbs_unread')} />}</td>
          <td><SellerLink row={r} /></td>
          <td>
            <StageChip stage={r.stage} />
            {r.needs_human && <span className="chip warn fbs-gap" title={r.human_reason ?? undefined}>{t('fbs_tab_needs')}</span>}
            {r.mode === 'human' && !r.needs_human && <span className="chip info fbs-gap">{t('fbs_mode_human')}</span>}
          </td>
          <td><AccountCell no={r.account_no} accounts={accounts} /></td>
          <td className="rl-muted"><span className="rl-clip rl-reply">{r.last_body ?? '—'}</span></td>
          <td className="rl-num"><Money usd={r.offer_usd} /></td>
          <td><Ago at={r.closed_at ?? lastActivity(r)} /></td>
        </tr>
      ))}
    </Table>
  );
}
