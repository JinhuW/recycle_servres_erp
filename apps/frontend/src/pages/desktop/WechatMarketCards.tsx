import { useState } from 'react';
import {
  WECHAT_SENTIMENT_LEAN,
  WECHAT_TRADERS_MAX,
  sentimentLean,
  type WechatDaySummary,
  type WechatLineSentiment,
  type WechatMood,
  type WechatMoodTally,
  type WechatSentiment,
  type WechatSide,
  type WechatTrader,
  type WechatTraders,
} from '@recycle-erp/shared';
import { Skeleton } from '../../components/Skeleton';
import { useT } from '../../lib/i18n';
import { MOOD_HINT_KEY, MOOD_KEY, fmtScore, sideShare } from '../../lib/wechatMarket';

// ─── Monitors ▸ WeChat: who trades, and in what mood (RS-599) ────────────────
// memtrade counts these and pushes them with the day. A day pushed before it
// did has none, so every card says so rather than showing zeros.

const MOODS: readonly WechatMood[] = ['bullish', 'neutral', 'bearish'];

// "+12%" against the day before; null when either day has no figure.
function delta(cur: number | null, before: number | null | undefined): string | null {
  if (cur === null || before === null || before === undefined || before === 0) return null;
  const pct = (cur - before) / before;
  if (Math.abs(pct) < 0.005) return '±0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%`;
}

// ── Buyers & sellers ──────────────────────────────────────────────────────────

export function FlowCard({ summary, prev, locale }: {
  summary: WechatDaySummary | null;
  prev: WechatDaySummary | null;
  locale: string;
}) {
  const { t } = useT();
  const fmt = new Intl.NumberFormat(locale);
  const tot = summary?.totals;
  const pt = prev?.totals;
  const has = tot?.buyOnly !== null && tot?.buyOnly !== undefined;
  const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmt.format(v));
  const pairs = tot && [
    { key: 'traders', label: t('wxFlowTraders'), b: tot.buyers, s: tot.sellers, pb: pt?.buyers, ps: pt?.sellers, note: null },
    { key: 'posts', label: t('wxFlowPosts'), b: tot.buyPosts, s: tot.sellPosts, pb: pt?.buyPosts, ps: pt?.sellPosts, note: null },
    {
      key: 'qty', label: t('wxFlowQty'), b: tot.buyQty, s: tot.sellQty, pb: pt?.buyQty, ps: pt?.sellQty,
      note: tot.buyQtyPosts === null ? null : {
        text: t('wxFlowQtyFrom', { b: fmt.format(tot.buyQtyPosts), s: fmt.format(tot.sellQtyPosts ?? 0) }),
        hint: t('wxFlowQtyHint', { b: fmt.format(tot.buyQtyPosts), s: fmt.format(tot.sellQtyPosts ?? 0) }),
      },
    },
  ];
  const split = has && tot ? [
    { key: 'buy', label: t('wxFlowBuyOnly'), n: tot.buyOnly ?? 0 },
    { key: 'both', label: t('wxFlowBoth'), n: tot.both ?? 0 },
    { key: 'sell', label: t('wxFlowSellOnly'), n: tot.sellOnly ?? 0 },
  ] : null;
  const splitTotal = split?.reduce((a, x) => a + x.n, 0) ?? 0;

  return (
    <section className="card wx-flow" aria-label={t('wxFlowTitle')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('wxFlowTitle')}</h2>
          <span className="card-sub">{t('wxFlowSub')}</span>
        </div>
        <span className="wx-flow-legend">
          <span><i className="wx-dot wx-buy" />{t('wxFlowBuy')}</span>
          <span><i className="wx-dot wx-sell" />{t('wxFlowSell')}</span>
        </span>
      </div>
      <div className="card-body">
        {!pairs ? <Skeleton width="100%" height={120} /> : <>
          <dl className="wx-flow-pairs">
            {pairs.map(p => {
              const share = p.b === null || p.s === null ? null : sideShare(p.b, p.s);
              const db = delta(p.b, p.pb);
              const ds = delta(p.s, p.ps);
              return (
                <div key={p.key} className="wx-flow-pair">
                  <dt>{p.label}</dt>
                  <dd>
                    <span className="wx-flow-n wx-buy" title={db && prev ? `${t('wxFlowVsPrev', { date: prev.date })}: ${db}` : undefined}>
                      <b className="mono">{num(p.b)}</b>{db && <small>{db}</small>}
                    </span>
                    <span className="wx-flow-bar" aria-hidden>
                      {share !== null && <>
                        <i className="wx-buy" style={{ width: `${share}%` }} />
                        <i className="wx-sell" style={{ width: `${100 - share}%` }} />
                      </>}
                    </span>
                    <span className="wx-flow-n wx-sell" title={ds && prev ? `${t('wxFlowVsPrev', { date: prev.date })}: ${ds}` : undefined}>
                      <b className="mono">{num(p.s)}</b>{ds && <small>{ds}</small>}
                    </span>
                    {p.note && <small className="wx-flow-note" title={p.note.hint}>{p.note.text}</small>}
                  </dd>
                </div>
              );
            })}
          </dl>
          {split ? (
            <div className="wx-flow-split">
              <div className="fp-section-label">{t('wxFlowSplit')}</div>
              <div className="wx-flow-seg" aria-hidden>
                {splitTotal > 0 && split.map(x => x.n > 0 && (
                  <i key={x.key} className={`wx-seg-${x.key}`} style={{ flexGrow: x.n }} />
                ))}
              </div>
              <ul className="wx-flow-seg-keys">
                {split.map(x => (
                  <li key={x.key}><i className={`wx-seg-${x.key}`} />{x.label} <b className="mono">{fmt.format(x.n)}</b></li>
                ))}
              </ul>
              {tot.newBuyers !== null && (
                <p className="wx-flow-new" title={t('wxFlowNewHint')}>
                  {t('wxFlowNew', { b: num(tot.newBuyers), s: num(tot.newSellers) })}
                </p>
              )}
            </div>
          ) : <p className="fp-muted wx-card-note">{t('wxFlowNone')}</p>}
        </>}
      </div>
    </section>
  );
}

// ── Market mood ───────────────────────────────────────────────────────────────

export function MoodChip({ sentiment, title }: { sentiment: WechatLineSentiment | null; title?: string }) {
  const { t } = useT();
  if (!sentiment || sentiment.score === null) return <span className="fp-muted">—</span>;
  const lean = sentimentLean(sentiment.score)!;
  return (
    <span className={`chip wx-mood-${lean}`}
      title={title ?? t('wxMoodTally', { up: sentiment.bullish, flat: sentiment.neutral, down: sentiment.bearish })}>
      {fmtScore(sentiment.score)}
    </span>
  );
}

function TallyBar({ tally }: { tally: WechatMoodTally }) {
  const total = tally.bullish + tally.neutral + tally.bearish;
  return (
    <span className="wx-tally" aria-hidden>
      {total > 0 && MOODS.map(m => tally[m] > 0 && <i key={m} className={`wx-mood-${m}`} style={{ flexGrow: tally[m] }} />)}
    </span>
  );
}

export function SentimentCard({ sentiment, loading }: { sentiment: WechatSentiment | null; loading: boolean }) {
  const { t } = useT();
  const s = sentiment;
  const voters = s ? s.bullish + s.neutral + s.bearish : 0;
  const lean = s ? sentimentLean(s.score) : null;
  // −100…100 onto the gauge's 0–100%.
  const at = s?.score === null || s?.score === undefined ? null : (s.score + 100) / 2;
  return (
    <section className="card wx-sent" aria-label={t('wxSentTitle')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('wxSentTitle')}</h2>
          <span className="card-sub">{t('wxSentSub')}</span>
        </div>
      </div>
      <div className="card-body">
        {loading ? <Skeleton width="100%" height={120} /> : !s ? (
          <p className="fp-muted wx-card-note">{t('wxSentNone')}</p>
        ) : <>
          <div className="wx-sent-head" title={t('wxSentScoreHint')}>
            <b className={`wx-sent-score mono${lean ? ` wx-mood-text-${lean}` : ''}`}>
              {s.score === null ? '—' : fmtScore(s.score)}
            </b>
            <span>
              {lean ? <span className={`chip wx-mood-${lean}`}>{t(MOOD_KEY[lean])}</span>
                : <span className="fp-muted">{t('wxSentFew')}</span>}
              <small className="fp-muted">{t('wxSentVoters', { n: voters })}</small>
            </span>
          </div>
          <div className="wx-gauge" aria-hidden>
            <i className="wx-gauge-lean" style={{ left: `${(100 - WECHAT_SENTIMENT_LEAN) / 2}%`, width: `${WECHAT_SENTIMENT_LEAN}%` }} />
            {at !== null && <i className="wx-gauge-at" style={{ left: `${at}%` }} />}
          </div>
          <div className="wx-gauge-ends" aria-hidden>
            <span>{t('wxMoodBearish')}</span><span>{t('wxMoodBullish')}</span>
          </div>
          <dl className="wx-sent-rows">
            {MOODS.map(m => (
              <div key={m} title={t(MOOD_HINT_KEY[m])}>
                <dt><i className={`wx-dot wx-mood-${m}`} />{t(MOOD_KEY[m])}</dt>
                <dd className="mono">{s[m]}</dd>
              </div>
            ))}
          </dl>
          {([['buy', s.buy, 'wxSentBuySide'], ['sell', s.sell, 'wxSentSellSide']] as const).map(([k, tally, label]) => (
            <div key={k} className="wx-sent-side"
              title={t('wxMoodTally', { up: tally.bullish, flat: tally.neutral, down: tally.bearish })}>
              <span><i className={`wx-dot wx-${k}`} />{t(label)}</span>
              <TallyBar tally={tally} />
            </div>
          ))}
          <p className="wx-sent-urgent" title={t('wxSentUrgentHint')}>{t('wxSentUrgent', { n: s.urgent })}</p>
        </>}
      </div>
    </section>
  );
}

// ── Most active traders ───────────────────────────────────────────────────────

export function TradersCard({ traders, loading, locale }: {
  traders: WechatTraders | null;
  loading: boolean;
  locale: string;
}) {
  const { t } = useT();
  const [side, setSide] = useState<WechatSide>('buy');
  const fmt = new Intl.NumberFormat(locale);
  const list: WechatTrader[] = traders?.[side] ?? [];
  const most = list[0]?.posts ?? 1;
  return (
    <section className="card wx-top wx-traders" aria-label={t('wxTradersTitle')}>
      <div className="card-head">
        <h2 className="card-title">{t('wxTradersTitle')}</h2>
        <span className="card-sub">{t('wxTradersSub', { n: WECHAT_TRADERS_MAX })}</span>
        {traders && (
          <div className="seg wx-seg-sm" role="tablist" aria-label={t('wxTradersTitle')}>
            {(['buy', 'sell'] as const).map(s => (
              <button key={s} role="tab" aria-selected={side === s} className={side === s ? 'active' : ''} onClick={() => setSide(s)}>
                {t(s === 'buy' ? 'wxFlowBuy' : 'wxFlowSell')}
              </button>
            ))}
          </div>
        )}
      </div>
      <ol>
        {loading && [0, 1, 2, 3].map(i => <li key={i} aria-hidden><Skeleton width="100%" height={12} /></li>)}
        {!loading && !traders && <li className="fp-muted wx-card-note">{t('wxFlowNone')}</li>}
        {list.map(tr => (
          <li key={tr.senderId} className="wx-trader">
            <span className="wx-top-key" title={tr.senderId}>
              {tr.mood && <i className={`wx-dot wx-mood-${tr.mood}`} title={t(MOOD_KEY[tr.mood])} />}
              <span className="wx-trader-name">{tr.name || tr.senderId}</span>
              {tr.both && <span className="chip muted" title={t('wxTraderBothHint')}>{t('wxTraderBoth')}</span>}
            </span>
            <span className="wx-top-n">{t('wxTraderStats', { posts: tr.posts, lines: tr.lines, groups: tr.groups })}</span>
            <span className="wx-top-p mono">{tr.qty > 0 ? t('wxTraderQty', { n: fmt.format(tr.qty) }) : '—'}</span>
            <i className={`wx-bar wx-${side}`} style={{ width: `${(tr.posts / most) * 100}%` }} />
          </li>
        ))}
        {traders && list.length === 0 && <li className="fp-muted">{t('wxTradersNone')}</li>}
      </ol>
    </section>
  );
}
