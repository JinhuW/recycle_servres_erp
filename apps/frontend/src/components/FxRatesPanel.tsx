import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';
import { Icon } from './Icon';

interface LatestRow {
  rate: number;
  source: string;
  fetchedAt: string;
  effectiveDate: string;
}

interface HistoryRow {
  id: string;
  quote_currency: string;
  rate: number;
  source: string;
  fetched_at: string;
  effective_date: string;
  note: string | null;
}

interface FxResponse {
  latest: Record<string, LatestRow>;
  history: HistoryRow[];
}

// Manager-only FX rates panel, mounted as its own Settings section. Reads +
// writes /api/workspace/fx-rates, where `rate` is the human-friendly USD→quote
// number (e.g. 7.2154 for CNY). The "CNY → USD" inverse is a display-only
// convenience — only the USD→CNY direction is persisted server-side.
export function FxRatesPanel() {
  const { t } = useT();
  const [latest, setLatest] = useState<Record<string, LatestRow>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.get<FxResponse>('/api/workspace/fx-rates');
      setLatest(r.latest);
      setHistory(r.history);
      setError(null);
    } catch (e) {
      setError((e as Error).message || 'Failed to load');
    }
  }

  useEffect(() => { void load(); }, []);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/workspace/fx-rates/refresh', {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitOverride(e: FormEvent) {
    e.preventDefault();
    const rate = Number(overrideRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      setError(t('fx.rate_positive_error'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/workspace/fx-rates', {
        quote: 'CNY',
        rate,
        note: overrideNote || undefined,
      });
      setOverrideOpen(false);
      setOverrideRate('');
      setOverrideNote('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancelOverride() {
    setOverrideOpen(false);
    setOverrideRate('');
    setOverrideNote('');
    setError(null);
  }

  const sourceLabel = (s: string) =>
    s === 'frankfurter' ? t('fx.source.frankfurter')
    : s === 'manual' ? t('fx.source.manual')
    : s;

  const sourceChip = (s: string) =>
    `chip ${s === 'manual' ? 'accent' : 'info'}`;

  const cny = latest.CNY;
  const derived = cny && cny.rate > 0 ? 1 / cny.rate : null;

  // Translation-safe: split the inverse template on its {rate} slot so the
  // number can carry mono styling without hard-coding word order.
  const [invBefore, invAfter] = t('fx.inverse').split('{rate}');

  return (
    <>
      <div className="settings-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('fx.title')}
          </h2>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>
            {t('fx.panel_sub')}
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', marginBottom: 'var(--gap)',
            background: 'var(--neg-soft)', color: 'var(--neg)',
            border: '1px solid color-mix(in oklch, var(--neg) 22%, transparent)',
            borderRadius: 'var(--radius)', fontSize: 13,
          }}
        >
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('fx.current')}</div>
            <div className="card-sub">{t('fx.pair_usd_cny')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" disabled={busy} onClick={refresh}>
              <Icon name="refresh" size={13} />
              {t('fx.refresh')}
            </button>
            <button
              className="btn sm ghost"
              disabled={busy || overrideOpen}
              onClick={() => setOverrideOpen(true)}
            >
              <Icon name="edit" size={13} />
              {t('fx.override')}
            </button>
          </div>
        </div>

        <div className="card-body">
          {/* Rate spotlight — the live USD→CNY number, large and scannable. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 500 }}>1&nbsp;USD&nbsp;=</span>
              <span
                className="mono"
                style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1, color: 'var(--fg)' }}
              >
                {cny ? cny.rate.toFixed(4) : '—'}
              </span>
              <span style={{ fontSize: 16, color: 'var(--fg-muted)', fontWeight: 600 }}>{t('fx.unit_quote')}</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 4 }}>
              {cny ? (
                <>
                  <span className={sourceChip(cny.source)} style={{ alignSelf: 'flex-start' }}>
                    {sourceLabel(cny.source)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {t('fx.updated', { date: fmtDate(cny.fetchedAt) })}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('fx.never_fetched')}</span>
              )}
            </div>
          </div>

          {/* Inverse, derived from the stored rate — display only. */}
          <div
            style={{
              marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-muted)',
            }}
          >
            <span>
              {invBefore}
              <span className="mono" style={{ color: 'var(--fg)' }}>
                {derived !== null ? derived.toFixed(6) : '—'}
              </span>
              {invAfter}
            </span>
            <span className="chip muted">{t('fx.derived_tag')}</span>
          </div>
        </div>
      </div>

      {overrideOpen && (
        <div className="card" style={{ marginTop: 'var(--gap)' }}>
          <div className="card-head">
            <div><div className="card-title">{t('fx.override_title')}</div></div>
          </div>
          <form onSubmit={submitOverride} className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="field" style={{ maxWidth: 280 }}>
              <label className="label">{t('fx.override_rate_label')}</label>
              <input
                className="input mono"
                type="number"
                step="0.0001"
                min="0"
                value={overrideRate}
                onChange={e => setOverrideRate(e.target.value)}
                required
                autoFocus
              />
              <div className="help">{t('fx.override_rate_help')}</div>
            </div>
            <div className="field">
              <label className="label">{t('fx.note_label')}</label>
              <input
                className="input"
                type="text"
                placeholder={t('fx.note_placeholder')}
                value={overrideNote}
                onChange={e => setOverrideNote(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn accent" disabled={busy}>
                <Icon name="check" size={14} />
                {t('fx.save')}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={cancelOverride}>
                {t('fx.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div><div className="card-title">{t('fx.history')}</div></div>
        </div>
        {history.length === 0 ? (
          <div className="card-body" style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('fx.history_empty')}
          </div>
        ) : (
          <div className="table-scroll lb-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('fx.col_when')}</th>
                  <th>{t('fx.col_rate')}</th>
                  <th>{t('fx.col_source')}</th>
                  <th>{t('fx.col_note')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} className="row-hover">
                    <td>{fmtDate(h.fetched_at)}</td>
                    <td className="mono">{h.rate.toFixed(4)}</td>
                    <td><span className={sourceChip(h.source)}>{sourceLabel(h.source)}</span></td>
                    <td className="muted">{h.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
