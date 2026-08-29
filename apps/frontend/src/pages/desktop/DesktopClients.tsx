// Clients — who we buy from, and who needs a call today.
//
// Opens filtered to "Needs a call" rather than everything: a list of four is a
// task, a list of sixty-seven is a chore someone closes. Everything a purchaser
// does here is meant to cost two taps — ring them from the row, log what
// happened, and the next call schedules itself.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { RhythmStrip } from '../../components/RhythmStrip';
import { TableSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD0, fmtDate } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { useAuth } from '../../lib/auth';
import {
  type Client, type ClientList, type Suggestion,
  TIER_KEY, HEALTH_KEY, HEALTH_TONE, dueLabel, dueTone, rhythmMarks,
} from '../../lib/clients';
import { ClientDrawer } from './clients/ClientDrawer';
import { AddClientModal } from './clients/AddClientModal';

type Filter = 'due' | 'soon' | 'quiet' | 'all';

export function DesktopClients({ showToast }: { showToast: (m: string, k?: 'success' | 'error' | 'warn') => void }) {
  const { t, lang } = useT();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [data, setData] = useState<ClientList | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = usePersisted<Filter>('desktop.clients.filter', 'due');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [suggOpen, setSuggOpen] = usePersisted('desktop.clients.suggOpen', true);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    return Promise.all([
      api.get<ClientList>('/api/suppliers'),
      api.get<{ items: Suggestion[] }>('/api/suppliers/suggestions'),
    ])
      .then(([list, sugg]) => { setData(list); setSuggestions(sugg.items); })
      .catch(handleFetchError)
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase().trim();
    return data.items.filter((c) => {
      if (filter === 'due' && !(c.dueState === 'overdue' || c.dueState === 'today')) return false;
      if (filter === 'soon' && c.dueState !== 'soon') return false;
      if (filter === 'quiet' && !(c.health === 'quiet' || c.health === 'lost')) return false;
      if (!q) return true;
      return [c.name, c.company, c.address.city, c.phone, ...c.supplies, ...c.itemTypes]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [data, filter, search]);

  const addSuggestion = async (s: Suggestion) => {
    setBusy(s.matchKey);
    try {
      const r = await api.post<{ id: string; linked: number }>('/api/suppliers/adopt', s);
      await reload();
      showToast(r.linked
        ? t('cliAddedWithOrders', { name: s.name, n: r.linked })
        : t('cliAdded', { name: s.name }));
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('cliAddFailed'));
    } finally { setBusy(null); }
  };

  const dismiss = async (s: Suggestion) => {
    setBusy(s.matchKey);
    try {
      await api.post('/api/suppliers/suggestions/dismiss', { matchKey: s.matchKey });
      setSuggestions((prev) => prev.filter((x) => x.matchKey !== s.matchKey));
      showToast(t('cliDismissed', { name: s.name }));
    } catch (e) { handleFetchError(e); } finally { setBusy(null); }
  };

  const counts = data?.counts ?? { due: 0, soon: 0, quiet: 0, total: 0 };
  const tiles: { k: Filter; label: string; n: number; sub: string; tone: string }[] = [
    { k: 'due',   label: t('cliTileDue'),   n: counts.due,   sub: t('cliTileDueSub'),   tone: 'neg' },
    { k: 'soon',  label: t('cliTileSoon'),  n: counts.soon,  sub: t('cliTileSoonSub'),  tone: 'info' },
    { k: 'quiet', label: t('cliTileQuiet'), n: counts.quiet, sub: t('cliTileQuietSub'), tone: 'warn' },
    { k: 'all',   label: t('cliTileAll'),   n: counts.total, sub: t('cliTileAllSub'),   tone: '' },
  ];

  return (
    <div className="clients-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('cliTitle')}</h1>
          <p className="page-sub">{t('cliSub', { n: counts.total })}</p>
        </div>
        <div className="page-head-actions">
          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('cliSearchPh')}
              aria-label={t('cliSearchPh')}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            {t('cliAddBtn')}
          </button>
        </div>
      </div>

      <div className="cli-rail">
        {tiles.map((tile) => (
          <button
            key={tile.k}
            type="button"
            className={`so-stat cli-tile cli-tile-${tile.tone}${filter === tile.k ? ' on' : ''}`}
            aria-pressed={filter === tile.k}
            onClick={() => setFilter(tile.k)}
          >
            <div className="so-stat-head">{tile.label}</div>
            <div className="so-stat-num">{tile.n}</div>
            <div className="so-stat-sub">{tile.sub}</div>
          </button>
        ))}
      </div>

      {suggestions.length > 0 && (
        <section className={`cli-sugg${suggOpen ? '' : ' closed'}`}>
          <button
            type="button"
            className="cli-sugg-head"
            aria-expanded={suggOpen}
            onClick={() => setSuggOpen((v) => !v)}
          >
            <span className="cli-sugg-title">{t('cliSuggTitle', { n: suggestions.length })}</span>
            <span className="cli-sugg-why">{t('cliSuggWhy')}</span>
            <Icon name="chevronDown" size={13} className="cli-chev" />
          </button>
          {suggOpen && (
            <div>
              {suggestions.map((s) => (
                <div className="cli-sugg-row" key={s.matchKey}>
                  <div>
                    <div className="cli-sugg-name">{s.name}</div>
                    <div className="cli-sugg-meta">
                      {[s.city, s.state].filter(Boolean).join(', ')}
                      {s.poCount > 0 && ` · ${t('cliSuggPos', { n: s.poCount })}`}
                      {s.spend > 0 && ` · ${fmtUSD0(s.spend)}`}
                    </div>
                  </div>
                  <div className="cli-sugg-acts">
                    <button
                      type="button" className="btn btn-sm"
                      disabled={busy === s.matchKey}
                      onClick={() => void addSuggestion(s)}
                    >{t('cliSuggAdd')}</button>
                    <button
                      type="button" className="btn btn-sm btn-ghost"
                      disabled={busy === s.matchKey}
                      onClick={() => void dismiss(s)}
                    >{t('cliSuggSkip')}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="card">
        {!loaded ? (
          <TableSkeleton rows={6} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState filter={filter} search={search} onAdd={() => setAdding(true)}
            onShowAll={() => setFilter('all')} total={counts.total} />
        ) : (
          <div className="table-scroll">
            <table className="table cli-table">
              <thead>
                <tr>
                  <th>{t('cliColClient')}</th>
                  {isManager && <th>{t('cliColOwner')}</th>}
                  <th>{t('cliColRhythm')}</th>
                  <th>{t('cliColDeals')}</th>
                  <th>{t('cliColLastPo')}</th>
                  <th>{t('cliColDue')}</th>
                  <th aria-label={t('cliColAction')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <Row key={c.id} c={c} isManager={isManager} locale={locale}
                    onOpen={() => setOpenId(c.id)} t={t} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openId && (
        <ClientDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void reload()}
          showToast={showToast}
        />
      )}
      {adding && (
        <AddClientModal
          onClose={() => setAdding(false)}
          onCreated={(id) => { setAdding(false); void reload(); setOpenId(id); }}
        />
      )}
    </div>
  );
}

function Row({ c, isManager, locale, onOpen, t }: {
  c: Client; isManager: boolean; locale: string; onOpen: () => void;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const late = c.dueState === 'overdue' || c.dueState === 'today';
  const deals = c.supplies.length ? c.supplies : c.itemTypes;
  return (
    <tr
      className={`cli-row${late ? ' cli-row-late' : c.health === 'quiet' ? ' cli-row-quiet' : ''}`}
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      <td className="cli-cell-name">
        <div className="cli-name">{c.name}</div>
        <div className="cli-where">
          {[c.address.city, c.address.state].filter(Boolean).join(', ')}
          {c.poCount > 0 && ` · ${t(TIER_KEY[c.tier])}`}
          {' · '}
          <span className={`chip chip-${HEALTH_TONE[c.health]}`}>{t(HEALTH_KEY[c.health])}</span>
        </div>
      </td>
      {isManager && <td className="cli-owner">{c.ownerName ?? t('cliHouse')}</td>}
      <td>
        <RhythmStrip poDaysAgo={c.rhythm} gapDays={c.typicalGapDays} health={c.health}
          label={t('cliRhythmAria', { n: c.poCount, d: c.daysSinceLastPo ?? 0 })} />
      </td>
      <td>
        <div className="cli-tags">
          {deals.slice(0, 3).map((d) => <span className="cli-tag" key={d}>{d}</span>)}
        </div>
      </td>
      <td className="cli-num">
        {c.lastPoAt
          ? (c.daysSinceLastPo === 1 ? t('cliDaysAgo1') : t('cliDaysAgo', { n: c.daysSinceLastPo ?? 0 }))
          : '—'}
      </td>
      <td><span className={`chip chip-${dueTone(c.dueState)}`}>{dueLabel(c, t)}</span></td>
      <td className="cli-act">
        {c.phone
          ? <a className="btn btn-primary btn-sm" href={`tel:${c.phone}`}
              onClick={(e) => e.stopPropagation()}>{t('cliCall')}</a>
          : <span className="cli-nophone">{t('cliNoPhone')}</span>}
      </td>
    </tr>
  );
}

function EmptyState({ filter, search, total, onAdd, onShowAll }: {
  filter: Filter; search: string; total: number; onAdd: () => void; onShowAll: () => void;
}) {
  const { t } = useT();
  if (search) {
    return (
      <div className="cli-empty">
        <h4>{t('cliEmptySearch', { q: search })}</h4>
        <p>{t('cliEmptySearchSub')}</p>
        <button type="button" className="btn btn-primary" onClick={onAdd}>
          {t('cliEmptySearchAdd', { q: search })}
        </button>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="cli-empty">
        <h4>{t('cliEmptyNoneTitle')}</h4>
        <p>{t('cliEmptyNoneSub')}</p>
        <button type="button" className="btn btn-primary" onClick={onAdd}>{t('cliAddBtn')}</button>
      </div>
    );
  }
  return (
    <div className="cli-empty">
      <h4>{filter === 'due' ? t('cliEmptyCaughtUp') : t('cliEmptyFilter')}</h4>
      <p>{filter === 'due' ? t('cliEmptyCaughtUpSub') : t('cliEmptyFilterSub')}</p>
      <button type="button" className="btn" onClick={onShowAll}>{t('cliEmptySeeAll')}</button>
    </div>
  );
}
