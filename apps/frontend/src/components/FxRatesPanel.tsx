import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDate } from '../lib/format';

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

// Manager-only FX rates panel. Reads + writes /api/workspace/fx-rates, where
// `rate` is the human-friendly USD→quote number (e.g. 7.2154 for CNY).
// The "CNY → USD (derived)" row is purely a display convenience — only the
// USD→CNY direction is persisted server-side.
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
      setError('Rate must be > 0');
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

  const cny = latest.CNY;
  const derived = cny && cny.rate > 0 ? 1 / cny.rate : null;

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
        {t('fx.title')}
      </h2>

      {error && (
        <div style={{ color: 'crimson', marginTop: 8, marginBottom: 8 }}>{error}</div>
      )}

      <table className="ph-table" style={{ maxWidth: 520, marginTop: 12 }}>
        <thead>
          <tr>
            <th>Pair</th>
            <th>Rate</th>
            <th>Source</th>
            <th>Fetched</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t('fx.pair_usd_cny')}</td>
            <td className="mono">{cny ? cny.rate.toFixed(4) : '—'}</td>
            <td>{cny ? sourceLabel(cny.source) : '—'}</td>
            <td>{cny ? fmtDate(cny.fetchedAt) : '—'}</td>
          </tr>
          <tr>
            <td>{t('fx.pair_cny_usd_derived')}</td>
            <td className="mono">{derived !== null ? derived.toFixed(6) : '—'}</td>
            <td>(derived)</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="ph-btn" disabled={busy} onClick={refresh}>
          {t('fx.refresh')}
        </button>
        <button
          className="ph-btn ghost"
          disabled={busy || overrideOpen}
          onClick={() => setOverrideOpen(true)}
        >
          {t('fx.override')}
        </button>
      </div>

      {overrideOpen && (
        <form
          onSubmit={submitOverride}
          style={{
            marginTop: 12,
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 8,
            maxWidth: 520,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div className="ph-field">
            <label className="label">USD → CNY rate</label>
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
          </div>
          <div className="ph-field">
            <label className="label">Note (optional)</label>
            <input
              className="input"
              type="text"
              value={overrideNote}
              onChange={e => setOverrideNote(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="ph-btn accent" disabled={busy}>Save</button>
            <button type="button" className="ph-btn ghost" disabled={busy} onClick={cancelOverride}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <h3 style={{ marginTop: 24, fontSize: 15, fontWeight: 600 }}>{t('fx.history')}</h3>
      <table className="ph-table" style={{ maxWidth: 720, marginTop: 8 }}>
        <thead>
          <tr>
            <th>When</th>
            <th>Rate</th>
            <th>Source</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {history.length === 0 ? (
            <tr><td colSpan={4} style={{ color: 'var(--fg-subtle)' }}>—</td></tr>
          ) : history.map(h => (
            <tr key={h.id}>
              <td>{fmtDate(h.fetched_at)}</td>
              <td className="mono">{h.rate.toFixed(4)}</td>
              <td>{sourceLabel(h.source)}</td>
              <td>{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
