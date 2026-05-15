import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { fmtUSD, fmtUSD0, relTime } from '../lib/format';
import { usePhScrolled } from '../lib/usePhScrolled';
import type { RefPrice } from '../lib/types';
import { PhoneListSkeleton } from '../components/Skeleton';

export function Market() {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'HDD' | 'Other'>('all');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<RefPrice[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('category', filter);
      if (search.trim()) params.set('q', search.trim());
      api.get<{ items: RefPrice[] }>(`/api/market?${params}`)
        .then(r => setItems(r.items))
        .catch(console.error)
        .finally(() => setLoadedOnce(true));
    }, 250);
    return () => clearTimeout(handle);
  }, [filter, search]);

  return (
    <>
      <PhHeader title={t('marketTitle')} sub={t('marketSub', { n: items.length })} scrolled={scrolled} />
      <div className="ph-scroll" ref={scrollRef}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: 'var(--accent-soft)', border: '1px solid color-mix(in oklch, var(--accent) 25%, transparent)', borderRadius: 12, marginTop: 4, fontSize: 12, color: 'var(--accent-strong)' }}>
          <Icon name="zap" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <div>{t('marketHint')}</div>
        </div>

        <div style={{ position: 'relative', marginTop: 12 }}>
          <Icon name="search" size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)' }} />
          <input className="input" placeholder={t('searchPart')} style={{ paddingLeft: 32, height: 38, fontSize: 13, width: '100%' }} value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <div className="ph-chip-scroller">
          {(['all', 'RAM', 'SSD', 'HDD', 'Other'] as const).map(f => (
            <button key={f} className={'ph-chip-btn ' + (filter === f ? 'active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('filterAll') : f}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!loadedOnce && <PhoneListSkeleton rows={5} />}
          {loadedOnce && items.slice(0, 30).map(r => {
            const open = openId === r.id;
            const trendUp = r.trend > 0.005;
            const trendDown = r.trend < -0.005;
            const trendColor = trendUp ? 'var(--pos)' : trendDown ? 'var(--neg)' : 'var(--fg-subtle)';
            const onTarget = r.target <= r.maxBuy;
            return (
              <div key={r.id} className="ph-inv-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: 0, cursor: 'pointer' }} onClick={() => setOpenId(open ? null : r.id)}>
                <div style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="ph-inv-thumb" style={{
                    background: r.category === 'RAM' ? 'var(--info-soft)'
                              : r.category === 'SSD' ? 'var(--pos-soft)'
                              : r.category === 'HDD' ? 'oklch(0.96 0.04 295)'
                              : 'var(--warn-soft)',
                    color: r.category === 'RAM' ? 'oklch(0.45 0.13 250)'
                         : r.category === 'SSD' ? 'var(--accent-strong)'
                         : r.category === 'HDD' ? 'oklch(0.45 0.16 295)'
                         : 'oklch(0.45 0.13 75)',
                  }}>
                    <Icon name={r.category === 'RAM' ? 'chip' : (r.category === 'SSD' || r.category === 'HDD') ? 'drive' : 'box'} size={16} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--pos)' }}>{fmtUSD0(r.avgSell)}</div>
                    <div style={{ fontSize: 10.5, color: trendColor, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <Icon name={trendUp ? 'arrowUp' : trendDown ? 'arrowDown' : 'minus'} size={9} />
                      {Math.abs(r.trend * 100).toFixed(1)}%
                    </div>
                  </div>
                </div>

                <div style={{
                  margin: '0 12px 12px', padding: '8px 10px',
                  background: 'color-mix(in oklch, var(--accent) 8%, transparent)',
                  border: '1px dashed color-mix(in oklch, var(--accent) 35%, transparent)',
                  borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span style={{ fontSize: 11, color: 'var(--accent-strong)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {t('maxBuy')}
                  </span>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-strong)' }}>≤ {fmtUSD(r.maxBuy)}</span>
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: 12, background: 'var(--bg-soft)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--fg-muted)' }}>{t('lastPaid')}</span>
                      <span className="mono" style={{ color: onTarget ? 'var(--pos)' : 'var(--neg)', fontWeight: 600 }}>
                        {fmtUSD(r.target)} {onTarget ? '✓' : '↑ over'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--fg-muted)' }}>{t('rangeSeen')}</span>
                      <span className="mono">{fmtUSD0(r.low)} – {fmtUSD0(r.high)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span style={{ color: 'var(--fg-muted)' }}>{t('status')}</span>
                      <span className="mono">{t('units', { n: r.stock })}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                      {t('updatedRel', { rel: relTime(r.updated), s: r.samples })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
