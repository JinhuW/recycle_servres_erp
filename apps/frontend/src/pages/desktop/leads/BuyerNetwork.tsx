import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { ListSkeleton } from '../../../components/Skeleton';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { leadsApi, type RedditBuyer, type RedditBuyerTree, type RedditLead } from '../../../lib/redditLeads';
import { DealRecord, Holder, StageChip, fmtDay } from './shared';

type Props = {
  buyers: RedditBuyer[] | null;
  buyer: string | null;
  onBuyer: (username: string) => void;
  leads: Map<string, RedditLead>;
  manager: boolean;
  onOpen: (username: string) => void;
  onClaim: (usernames: string[]) => void;
  busy: boolean;
};

/**
 * A top buyer and every seller they bought from, as a tree: the buyer at the
 * root, a node per seller, and under each the trades between them. Buyers who
 * buy a lot point at sellers with steady stock.
 */
export function BuyerNetwork({ buyers, buyer, onBuyer, leads, manager, onOpen, onClaim, busy }: Props) {
  const { t, locale } = useT();
  const [find, setFind] = useState('');
  const [tree, setTree] = useState<RedditBuyerTree | null>(null);
  const [onlyFree, setOnlyFree] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const current = buyer ?? buyers?.[0]?.username ?? null;

  useEffect(() => {
    if (!current) return;
    let live = true;
    setTree(null);
    setExpanded(new Set());
    leadsApi.buyer(current).then(r => { if (live) setTree(r); }, handleFetchError);
    return () => { live = false; };
  }, [current]);

  const shown = useMemo(() => (buyers ?? []).filter(b => !find || b.username.includes(find.trim().toLowerCase())), [buyers, find]);

  if (buyers && buyers.length === 0) {
    return <div className="card rl-card"><div className="rl-empty"><p>{t('rlNoBuyers')}</p></div></div>;
  }
  const lead = (u: string) => leads.get(u);
  const free = tree ? tree.sellers.filter(s => lead(s.username) && !lead(s.username)!.claimed)
    .sort((a, b) => lead(b.username)!.sales - lead(a.username)!.sales) : [];
  // Biggest sellers first: they are the ones worth a DM.
  const kids = tree ? tree.sellers
    .filter(s => !onlyFree || (lead(s.username) && !lead(s.username)!.claimed))
    .sort((a, b) => (lead(b.username)?.sales ?? -1) - (lead(a.username)?.sales ?? -1)) : [];
  const toggle = (u: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(u)) n.delete(u); else n.add(u); return n; });

  return (
    <div className="rl-net">
      <div className="card rl-buyers">
        <input className="input" value={find} onChange={e => setFind(e.target.value)} placeholder={t('rlFindBuyer')} aria-label={t('rlFindBuyer')} />
        {!buyers ? <ListSkeleton rows={8} /> : shown.map(b => (
          <button key={b.username} className={`rl-buyer${b.username === current ? ' on' : ''}`} aria-pressed={b.username === current} onClick={() => onBuyer(b.username)}>
            u/{b.name}<span>{t('rlBuysN', { n: b.buys.toLocaleString(locale) })}</span>
          </button>
        ))}
        {buyers && shown.length === 0 && <p className="rl-sub">{t('rlNoBuyerMatch')}</p>}
      </div>

      <div className="card rl-tree">
        {!tree ? <ListSkeleton rows={6} /> : (
          <>
            <div className="rl-root">
              <h2>u/{tree.buyer.name}</h2>
              <span className="rl-record"><b>{tree.buyer.buys.toLocaleString(locale)}</b> {t('rlBuy')}<span className="rl-sep" aria-hidden>|</span><span className="rl-buy"><b>{tree.buyer.sales}</b> {t('rlSale')}</span></span>
              <p>{t('rlBoughtFrom', { n: tree.sellers.length, free: free.length })}</p>
            </div>
            <div className="rl-tree-tools">
              <label className="rl-row"><input type="checkbox" checked={onlyFree} onChange={e => setOnlyFree(e.target.checked)} /> {t('rlOnlyUnclaimed')}</label>
              <button className="rl-link" onClick={() => setExpanded(expanded.size ? new Set() : new Set(tree.sellers.map(s => s.username)))}>
                {expanded.size ? t('rlCollapseAll') : t('rlShowEveryTrade')}
              </button>
              {free.length > 0 && (
                <button className="btn sm rl-push" disabled={busy} onClick={() => onClaim(free.slice(0, 5).map(s => s.username))}>
                  {t('rlClaimTopN', { n: Math.min(5, free.length) })}
                </button>
              )}
            </div>
            <ul className="rl-branches">
              {kids.map(s => {
                const l = lead(s.username);
                const isOpen = expanded.has(s.username);
                return (
                  <li key={s.username}>
                    <div className="rl-node">
                      <button className="rl-node-toggle" aria-expanded={isOpen} aria-label={t('rlShowTradesWith', { name: s.name })} onClick={() => toggle(s.username)}>
                        <Icon name="chevronRight" size={14} />
                      </button>
                      <div>
                        {l ? <button className="rl-user" onClick={() => onOpen(s.username)}>u/{s.name}</button> : <span className="rl-user rl-plain">u/{s.name}</span>}
                        <span className="rl-sub">{t(s.trades.length === 1 ? 'rlTradesWithOne' : 'rlTradesWith', { n: s.trades.length, buyer: tree.buyer.name, date: fmtDay(s.trades[0]?.date ?? null, locale) })}</span>
                      </div>
                      <div className="rl-hide-s">{l ? <DealRecord sales={l.sales} buys={l.buys} /> : <span className="rl-muted">{t('rlNoRecord')}</span>}</div>
                      <div className="rl-hide-s rl-row">{l && <Holder lead={l} manager={manager} />}{l && l.claimed && (l.mine || manager) && <StageChip lead={l} />}</div>
                      <div className="rl-end">
                        {l && !l.claimed && <button className="btn sm" disabled={busy} onClick={() => onClaim([s.username])}>{t('rlClaim')}</button>}
                        {l && l.mine && <button className="btn sm" onClick={() => onOpen(s.username)}>{t('rlOpen')}</button>}
                      </div>
                    </div>
                    {isOpen && (
                      <ul>
                        {s.trades.map((tr, i) => (
                          <li key={i}>
                            <div className="rl-trade">
                              <time>{fmtDay(tr.date, locale)}</time>
                              <span>{tr.item}</span>
                              {tr.url && <a className="rl-link" href={tr.url} target="_blank" rel="noopener noreferrer">{t('rlConfirmation')}</a>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
