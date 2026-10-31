import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  REDDIT_LEAD_STAGES, redditLeadIsDue, redditLeadIsOpen, redditLeadIsStale, redditLeadNeedsAction, redditLeadRank,
  type RedditLeadStage,
} from '@recycle-erp/shared';
import { Icon, type IconName } from '../../components/Icon';
import { TableSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { handleFetchError, showWarnToast } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePreference } from '../../lib/preferences';
import {
  leadsApi, leadsChanged, parseLeadsFile, type RedditBuyer, type RedditLead,
} from '../../lib/redditLeads';
import { hrefFor, leadsTabPath, matchLeadsTab, navigate, onLinkClick, replaceRoute, useRoute, type LeadsTab } from '../../lib/route';
import { useEffectiveUser } from '../../lib/tweaks';
import { BuyerNetwork } from './leads/BuyerNetwork';
import { LeadDrawer } from './leads/LeadDrawer';
import { DealRecord, Holder, NextStep, StageChip, fmtDay, leadToday, type RunLead } from './leads/shared';
import '../../styles/redditLeads.css';

// ─── Leads ▸ Reddit ───────────────────────────────────────────────────────────
// Sellers from the swap subreddits' trade-bot records, worked as a sales
// pipeline. Pool is who nobody holds; My leads is the viewer's own queue from
// first DM to deal; Buyer network walks from a big buyer to the sellers they
// bought from. Team and Import are the managers'. The API hides other
// purchasers' conversations, so the page renders what it is given.

type Tab = 'pool' | LeadsTab;
type Props = { showToast?: (message: string, kind?: 'success' | 'error') => void };

const TABS: { id: Tab; icon: IconName; key: string; manager?: true }[] = [
  { id: 'pool', icon: 'globe', key: 'rlTabPool' },
  { id: 'mine', icon: 'user', key: 'rlTabMine' },
  { id: 'network', icon: 'tree', key: 'rlTabNetwork' },
  { id: 'team', icon: 'users', key: 'rlTabTeam', manager: true },
  { id: 'import', icon: 'upload', key: 'rlTabImport', manager: true },
];
const LEDE: Record<Tab, string> = {
  pool: 'rlLedePool', mine: 'rlLedeMine', network: 'rlLedeNetwork', team: 'rlLedeTeam', import: 'rlLedeImport',
};
const KNOWN_REFUSALS = new Set(['rlTakenElsewhere', 'rlNotClaimed']);
const PAGE = 50;

export function LeadsReddit({ showToast }: Props) {
  const { path } = useRoute();
  const user = useEffectiveUser();
  const { t, locale } = useT();
  const manager = user?.role === 'manager';
  const routed = matchLeadsTab(path);
  const tab: Tab = routed && (manager || !TABS.find(x => x.id === routed)?.manager) ? routed : 'pool';
  useEffect(() => { if (routed && routed !== tab) replaceRoute(leadsTabPath('pool')); }, [routed, tab]);

  const [leads, setLeads] = useState<RedditLead[] | null>(null);
  const [buyers, setBuyers] = useState<RedditBuyer[] | null>(null);
  const [openLead, setOpenLead] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const today = leadToday();

  const load = useCallback(() => {
    leadsApi.list().then(r => setLeads(r.leads), handleFetchError);
  }, []);
  useEffect(() => { load(); }, [load, user?.role]);
  useEffect(() => { leadsApi.buyers().then(r => setBuyers(r.buyers), handleFetchError); }, []);
  useEffect(() => setQ(''), [tab]);

  const byName = useMemo(() => new Map((leads ?? []).map(l => [l.username, l])), [leads]);
  const patch = (lead: RedditLead) => setLeads(ls => ls && ls.map(l => (l.username === lead.username ? lead : l)));

  // Every write answers with the lead it changed. A refusal with a known code
  // is a warning and a fresh list; anything else is the usual error dialog.
  const run: RunLead = async (request, toast) => {
    setBusy(true);
    try {
      const next = await request;
      patch(next);
      leadsChanged();
      if (toast) showToast?.(toast);
      return next;
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      if (err instanceof ApiError && err.status === 409 && code && KNOWN_REFUSALS.has(code)) {
        showWarnToast(t(code));
        load();
      } else handleFetchError(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const claim = async (names: string[]) => {
    let got = 0;
    for (const u of names) if (await run(leadsApi.claim(u))) got++;
    if (got) showToast?.(names.length === 1 ? t('rlClaimedToast', { name: byName.get(names[0])?.name ?? names[0] }) : t('rlClaimedManyToast', { n: got }));
  };

  const all = leads ?? [];
  const mine = all.filter(l => l.mine);
  const pending = mine.filter(l => redditLeadNeedsAction(l, today)).length;
  const counts: Partial<Record<Tab, number>> = {
    pool: all.filter(l => !l.claimed).length,
    mine: mine.length,
    network: buyers?.length,
    team: all.filter(l => l.claimed).length,
  };
  const max = all.reduce((m, l) => Math.max(m, l.sales), 0);
  const match = (l: RedditLead) => {
    const n = q.trim().toLowerCase();
    return !n || l.username.includes(n) || l.itemsSold.some(i => i.toLowerCase().includes(n))
      || (l.lastReply?.text.toLowerCase().includes(n) ?? false);
  };
  const lead = openLead ? byName.get(openLead) ?? null : null;
  const showBuyer = (u: string) => { setOpenLead(null); setBuyer(u); navigate(leadsTabPath('network')); };

  const tabs = (
    <nav className="tabs rl-tabs" aria-label={t('rlViews')}>
      {TABS.filter(x => !x.manager || manager).map(x => {
        const n = counts[x.id];
        const hot = x.id === 'mine' && pending > 0;
        const href = leadsTabPath(x.id);
        return (
          <a key={x.id} className={`tab ${tab === x.id ? 'active' : ''}`} href={hrefFor(href)} onClick={onLinkClick(href)} aria-current={tab === x.id ? 'page' : undefined}>
            <Icon name={x.icon} size={14} />{t(x.key)}
            {n !== undefined && <span className={`chip muted${hot ? ' rl-hot' : ''}`} title={hot ? t('rlNavHint', { n: pending }) : undefined}>{n.toLocaleString(locale)}</span>}
          </a>
        );
      })}
    </nav>
  );

  const [view, setView] = usePreference('leads.view', 'list');
  const search = tab === 'pool' || tab === 'mine' || tab === 'team';
  const actions: ReactNode = (
    <>
      {tab === 'mine' && (
        <div className="seg" role="group" aria-label={t('rlLayout')}>
          <button className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('rlList')}</button>
          <button className={view === 'board' ? 'active' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')}>{t('rlBoard')}</button>
        </div>
      )}
      {search && (
        <label className="toolbar-search rl-search">
          <Icon name="search" size={14} />
          <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder={t('rlSearch')} aria-label={t('rlSearch')} />
        </label>
      )}
    </>
  );

  let body: ReactNode;
  if (!leads && tab !== 'import') body = <TableSkeleton rows={8} cols={5} />;
  else if (tab === 'pool') body = <PoolTab leads={all.filter(l => !l.claimed && match(l))} max={max} q={q} busy={busy} onOpen={setOpenLead} onClaim={u => void claim([u])} onClear={() => setQ('')} />;
  else if (tab === 'mine') body = <MineTab leads={mine.filter(match)} board={view === 'board'} max={max} today={today} onOpen={setOpenLead} empty={mine.length === 0} />;
  else if (tab === 'network') body = <BuyerNetwork buyers={buyers} buyer={buyer} onBuyer={setBuyer} leads={byName} manager={manager} onOpen={setOpenLead} onClaim={u => void claim(u)} busy={busy} />;
  else if (tab === 'team') body = <TeamTab leads={all.filter(l => l.claimed)} match={match} max={max} today={today} me={user?.id ?? ''} busy={busy} onOpen={setOpenLead}
    onRelease={l => void run(leadsApi.release(l.username), t('rlReleasedToast', { name: l.name }))} />;
  else body = <ImportTab onDone={() => { load(); leadsApi.buyers().then(r => setBuyers(r.buyers), handleFetchError); }} showToast={showToast} />;

  return (
    <>
      <div className="page-head"><div>
        <div className="page-sub">{t('nav_leads')} / {t('nav_leads_reddit')}</div>
        <h1 className="page-title">{t('rlTitle')}</h1>
      </div></div>
      {tabs}
      <div className="rl-tab-head">
        <p className="rl-lede">{t(LEDE[tab])}</p>
        <div className="rl-actions">{actions}</div>
      </div>
      {body}
      {lead && user && (
        <LeadDrawer key={lead.username} lead={lead} me={user} manager={manager} run={run} onClose={() => setOpenLead(null)} onBuyer={showBuyer} />
      )}
    </>
  );
}

function SellerCell({ lead, onOpen }: { lead: RedditLead; onOpen: (u: string) => void }) {
  return (
    <>
      <button className="rl-user" onClick={() => onOpen(lead.username)}>u/{lead.name}</button>
      {lead.subreddits.length > 0 && <span className="rl-sub">{lead.subreddits.map(s => `r/${s}`).join(', ')}</span>}
    </>
  );
}

function Table({ head, children, foot }: { head: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="card rl-card">
      <div className="table-scroll"><table className="rl-table"><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>
      {foot && <div className="rl-foot">{foot}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="card rl-card"><div className="rl-empty">{children}</div></div>;
}

function PoolTab({ leads, max, q, busy, onOpen, onClaim, onClear }: {
  leads: RedditLead[]; max: number; q: string; busy: boolean;
  onOpen: (u: string) => void; onClaim: (u: string) => void; onClear: () => void;
}) {
  const { t, locale } = useT();
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [q]);
  if (!leads.length) {
    return <Empty>{q
      ? <><p>{t('rlNoPoolMatch', { q })}</p><button className="btn ghost" onClick={onClear}>{t('rlClearSearch')}</button></>
      : <p>{t('rlPoolEmpty')}</p>}</Empty>;
  }
  return (
    <Table
      head={<><th>{t('rlSeller')}</th><th>{t('rlDealRecord')}</th><th>{t('rlLastDeal')}</th><th>{t('rlSoldLately')}</th><th className="rl-act" /></>}
      foot={<div className="rl-between"><span>{t('rlUnclaimedShown', { n: leads.length.toLocaleString(locale), shown: Math.min(shown, leads.length) })}</span>
        {shown < leads.length && <button className="btn sm ghost" onClick={() => setShown(shown + PAGE)}>{t('rlShowMore', { n: Math.min(PAGE, leads.length - shown) })}</button>}</div>}
    >
      {leads.slice(0, shown).map(l => (
        <tr key={l.username}>
          <td><SellerCell lead={l} onOpen={onOpen} /></td>
          <td><DealRecord sales={l.sales} buys={l.buys} max={max} /></td>
          <td>{fmtDay(l.lastDeal, locale)}</td>
          <td className="rl-muted"><span className="rl-clip" title={l.itemsSold.join(' · ')}>{l.itemsSold.join(' · ') || '—'}</span></td>
          <td className="rl-act"><button className="btn sm" disabled={busy} onClick={() => onClaim(l.username)}>{t('rlClaim')}</button></td>
        </tr>
      ))}
    </Table>
  );
}

const BOARD: { key: string; pick: (l: RedditLead) => boolean }[] = [
  ...REDDIT_LEAD_STAGES.filter(s => s !== 'won').map(s => ({ key: s, pick: (l: RedditLead) => l.stage === s && l.closed === '' })),
  { key: 'done', pick: (l: RedditLead) => !redditLeadIsOpen(l) },
];
const BOARD_TITLE: Record<string, string> = { claimed: 'rlStageClaimed', dm: 'rlStageDm', replied: 'rlStageReplied', talks: 'rlStageTalks', done: 'rlClosedCol' };

function MineTab({ leads, board, max, today, onOpen, empty }: {
  leads: RedditLead[]; board: boolean; max: number; today: string; onOpen: (u: string) => void; empty: boolean;
}) {
  const { t, locale } = useT();
  if (empty) {
    const pool = leadsTabPath('pool');
    return <Empty><p>{t('rlMineEmpty')}</p><a className="btn primary" href={hrefFor(pool)} onClick={onLinkClick(pool)}>{t('rlOpenPool')}</a></Empty>;
  }
  const ranked = [...leads].sort((a, b) => redditLeadRank(a, today) - redditLeadRank(b, today) || (a.claimedAt ?? 0) - (b.claimedAt ?? 0));
  if (board) {
    return (
      <div className="rl-board">
        {BOARD.map(col => {
          const cards = ranked.filter(col.pick);
          return (
            <section key={col.key} className="rl-col" aria-label={t(BOARD_TITLE[col.key])}>
              <h3>{t(BOARD_TITLE[col.key])}<span>{cards.length}</span></h3>
              {cards.map(l => (
                <button key={l.username} className={`rl-lead${redditLeadNeedsAction(l, today) && (redditLeadIsDue(l, today) || redditLeadIsStale(l, Date.now())) ? ' rl-due' : ''}`} onClick={() => onOpen(l.username)}>
                  <b>u/{l.name}</b>
                  <DealRecord sales={l.sales} buys={l.buys} />
                  <span className="rl-sub"><NextStep lead={l} today={today} /></span>
                </button>
              ))}
              {cards.length === 0 && <span className="rl-sub">{t('rlNone')}</span>}
            </section>
          );
        })}
      </div>
    );
  }
  return (
    <Table
      head={<><th>{t('rlSeller')}</th><th>{t('rlDealRecord')}</th><th>{t('rlStage')}</th><th>{t('rlNextStep')}</th><th>{t('rlLastReply')}</th><th className="rl-act" /></>}
      foot={t('rlLeadsN', { n: ranked.length })}
    >
      {ranked.map(l => {
        const first = l.stage === 'claimed' && l.closed === '';
        const due = redditLeadIsDue(l, today);
        return (
          <tr key={l.username}>
            <td><SellerCell lead={l} onOpen={onOpen} /></td>
            <td><DealRecord sales={l.sales} buys={l.buys} max={max} /></td>
            <td><StageChip lead={l} /></td>
            <td><NextStep lead={l} today={today} /></td>
            <td className="rl-reply">{l.lastReply
              ? <><span className="rl-clip" title={l.lastReply.text}>{l.lastReply.text}</span><span className="rl-sub">{relTime(new Date(l.lastReply.at), locale)}</span></>
              : <span className="rl-muted">—</span>}</td>
            <td className="rl-act">
              <button className={`btn sm${first || due ? ' primary' : ''}`} onClick={() => onOpen(l.username)}>
                {first ? t('rlSendDm') : due ? t('rlFollowUpBtn') : t('rlOpen')}
              </button>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function TeamTab({ leads, match, max, today, me, busy, onOpen, onRelease }: {
  leads: RedditLead[]; match: (l: RedditLead) => boolean; max: number; today: string; me: string; busy: boolean;
  onOpen: (u: string) => void; onRelease: (l: RedditLead) => void;
}) {
  const { t, locale } = useT();
  const [who, setWho] = useState('');
  const now = Date.now();
  const people = useMemo(() => {
    const m = new Map<string, { id: string; name: string; ls: RedditLead[] }>();
    for (const l of leads) {
      const id = l.holderId ?? '';
      if (!m.has(id)) m.set(id, { id, name: l.holderName ?? '', ls: [] });
      m.get(id)!.ls.push(l);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [leads]);
  if (!leads.length) return <Empty><p>{t('rlTeamEmpty')}</p></Empty>;
  const warn = (n: number) => (n ? <span className="chip rl-chip-warn">{n}</span> : <span className="rl-muted">0</span>);
  const atLeast = (l: RedditLead, s: RedditLeadStage) => REDDIT_LEAD_STAGES.indexOf(l.stage) >= REDDIT_LEAD_STAGES.indexOf(s);
  const rows = leads.filter(l => (!who || l.holderId === who) && match(l))
    .sort((a, b) => Number(redditLeadIsStale(b, now)) - Number(redditLeadIsStale(a, now)) || (b.claimedAt ?? 0) - (a.claimedAt ?? 0));
  const whoName = people.find(p => p.id === who)?.name;
  return (
    <>
      <Table head={<><th>{t('rlPurchaser')}</th><th className="rl-num">{t('rlClaimedCol')}</th><th className="rl-num" title={t('rlStaleHint')}>{t('rlStale')}</th>
        <th className="rl-num">{t('rlFollowsDue')}</th><th className="rl-num">{t('rlStageDm')}</th><th className="rl-num">{t('rlStageReplied')}</th>
        <th className="rl-num">{t('rlStageTalks')}</th><th className="rl-num">{t('rlDeals')}</th><th className="rl-act" /></>}>
        {people.map(p => {
          const n = (f: (l: RedditLead) => boolean) => p.ls.filter(f).length;
          const dm = n(l => atLeast(l, 'dm'));
          const won = n(l => l.stage === 'won');
          return (
            <tr key={p.id} className={who === p.id ? 'rl-picked' : undefined}>
              <td><b>{p.id === me ? t('rlYou') : p.name}</b></td>
              <td className="rl-num">{p.ls.length}</td>
              <td className="rl-num">{warn(n(l => redditLeadIsStale(l, now)))}</td>
              <td className="rl-num">{warn(n(l => redditLeadIsDue(l, today)))}</td>
              <td className="rl-num">{dm} <span className="rl-muted">· {Math.round((100 * dm) / p.ls.length)}%</span></td>
              <td className="rl-num">{n(l => atLeast(l, 'replied'))}</td>
              <td className="rl-num">{n(l => l.stage === 'talks' && l.closed === '')}</td>
              <td className="rl-num">{won ? <span className="rl-st rl-st-won">{won}</span> : '0'}</td>
              <td className="rl-act"><button className="btn sm ghost" aria-pressed={who === p.id} onClick={() => setWho(who === p.id ? '' : p.id)}>{who === p.id ? t('rlShowEveryone') : t('rlShowLeads')}</button></td>
            </tr>
          );
        })}
      </Table>
      {whoName && <p className="rl-lede">{t('rlShowingWhose', { name: whoName })}</p>}
      <Table
        head={<><th>{t('rlSeller')}</th><th>{t('rlDealRecord')}</th><th>{t('rlClaimedBy2')}</th><th>{t('rlSince')}</th><th>{t('rlStage')}</th><th>{t('rlNextStep')}</th><th className="rl-act" /></>}
        foot={t('rlLeadsN', { n: rows.length })}
      >
        {rows.map(l => {
          const stale = redditLeadIsStale(l, now);
          return (
            <tr key={l.username}>
              <td><SellerCell lead={l} onOpen={onOpen} /></td>
              <td><DealRecord sales={l.sales} buys={l.buys} max={max} /></td>
              <td><Holder lead={l} manager /></td>
              <td className="rl-muted">{l.claimedAt ? relTime(new Date(l.claimedAt), locale) : '—'}{stale && <> <span className="chip rl-chip-warn">{t('rlStale')}</span></>}</td>
              <td><StageChip lead={l} /></td>
              <td><NextStep lead={l} today={today} /></td>
              <td className="rl-act"><button className={`btn sm${stale ? '' : ' ghost'}`} disabled={busy} onClick={() => onRelease(l)}>{t('rlReleaseShort')}</button></td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}

function ImportTab({ onDone, showToast }: { onDone: () => void; showToast?: Props['showToast'] }) {
  const { t, locale } = useT();
  const [file, setFile] = useState<{ name: string; body: ReturnType<typeof parseLeadsFile> } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const read = async (f: File | undefined) => {
    if (!f) return;
    setError('');
    try {
      setFile({ name: f.name, body: parseLeadsFile(f.name, await f.text()) });
    } catch (e) {
      setFile(null);
      setError(e instanceof Error && e.message.startsWith('rlImport') ? t(e.message) : t('rlImportBadJson'));
    }
  };
  const go = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await leadsApi.import(file.body);
      showToast?.(t('rlImportedToast', { n: r.sellers.toLocaleString(locale), added: r.added }));
      setFile(null);
      onDone();
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card rl-import">
      <label className="rl-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void read(e.dataTransfer.files[0]); }}>
        <b>{t('rlDropFile')}</b>
        <span>{t('rlDropFileHint')}</span>
        <input type="file" accept=".json,.csv" className="rl-file" onChange={e => void read(e.target.files?.[0])} />
      </label>
      {error && <p className="rl-error" role="alert">{error}</p>}
      {file && (
        <dl className="rl-dl">
          <dt>{t('rlFile')}</dt><dd>{file.name}</dd>
          <dt>{t('rlSellers')}</dt><dd>{file.body.sellers.length.toLocaleString(locale)}</dd>
          <dt>{t('rlTabNetwork')}</dt><dd>{file.body.buyers ? t('rlImportNetwork', { buyers: file.body.buyers.length, trades: (file.body.trades ?? []).length.toLocaleString(locale) }) : t('rlImportNoNetwork')}</dd>
        </dl>
      )}
      <p className="rl-sub">{t('rlImportKeeps')}</p>
      <div className="rl-row rl-end">
        <button className="btn primary" disabled={!file || busy} onClick={() => void go()}>
          {file ? t('rlImportN', { n: file.body.sellers.length.toLocaleString(locale) }) : t('rlTabImport')}
        </button>
      </div>
    </div>
  );
}
