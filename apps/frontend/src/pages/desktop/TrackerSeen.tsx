import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/Skeleton';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { trackerApi, type SeenAlert, type SeenPerson, type TrackerSeen } from '../../lib/tracker';

// ─── Who saw the alerts ───────────────────────────────────────────────────────
// Read receipts come only for alerts the tracker's user account sent; the bot
// gets none from Telegram. So a bot alert reads "no receipts", never "nobody",
// and the people table counts against the alerts that could report a read.
// With several buyer chats, each person and alert is counted within its own.

const REFRESH_MS = 60_000;

type Props = { locale: string };

export function SeenCard({ locale }: Props) {
  const { t } = useT();
  const [data, setData] = useState<TrackerSeen | 'unavailable' | null>(null);

  const load = useCallback(() => {
    trackerApi.seen().then(setData).catch(() => setData('unavailable'));
  }, []);

  useEffect(() => {
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const s = data && data !== 'unavailable' ? data : null;

  return (
    <section className="card rt-analytics" aria-label={t('trkSeenCardTitle')} aria-busy={!data}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('trkSeenCardTitle')}</h2>
          <span className="card-sub">{t('trkSeenSub')}</span>
        </div>
      </div>
      <div className="card-body rt-an-body">
        {data === 'unavailable'
          ? <p className="fp-muted rt-note">{t('trkSeenUnavailable')}</p>
          : <Body s={s} locale={locale} />}
      </div>
    </section>
  );
}

function Body({ s, locale }: { s: TrackerSeen | null; locale: string }) {
  const { t } = useT();
  const withReceipts = s ? s.alerts.filter(a => a.sentAs === 'user') : [];
  const seenByAnyone = withReceipts.filter(a => a.readers.length > 0).length;
  const members = s ? s.people.filter(p => p.member) : [];
  const names = useMemo(() => new Map(s?.people.map(p => [p.userId, p]) ?? []), [s]);

  const kpis: Array<{ label: string; value: string | null; sub?: string }> = s ? [
    { label: t('trkSeenKpiAlerts'), value: String(s.alerts.length),
      sub: t('trkSeenKpiAlertsSub', { n: withReceipts.length }) },
    { label: t('trkSeenKpiSeen'), value: withReceipts.length ? t('trkPromptOf', { x: seenByAnyone, n: withReceipts.length }) : '—',
      sub: t('trkSeenKpiSeenSub') },
    { label: t('trkSeenKpiPeople'), value: String(members.filter(p => p.seen > 0).length),
      sub: t('trkSeenKpiPeopleSub', { n: members.length }) },
  ] : Array.from({ length: 3 }, () => ({ label: '', value: null }));

  return (
    <>
      {s && !s.userSenderLive && (
        <div className="rt-seen-note">
          <Icon name="info" size={16} />
          <span>{t('trkSeenBotOnly')}</span>
        </div>
      )}

      <div className="rt-an-kpis rt-seen-kpis">
        {kpis.map((k, i) => (
          <div key={i} className="kpi rt-an-kpi">
            <div className="kpi-label">{k.value === null ? <Skeleton width={80} height={12} /> : k.label}</div>
            <div className="kpi-value mono">{k.value ?? <Skeleton width={50} height={24} />}</div>
            {k.sub && <div className="rt-an-kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      <div className="rt-an-panel">
        <div className="fp-section-label">{t('trkSeenPeople')}</div>
        <PeopleTable people={s?.people ?? null} locale={locale} />
      </div>

      <div className="rt-an-panel">
        <div className="fp-section-label">{t('trkSeenAlerts')}</div>
        <AlertsTable alerts={s?.alerts ?? null} names={names} locale={locale} />
      </div>
    </>
  );
}

function who(p: SeenPerson | undefined, userId: string): string {
  return p ? p.name : userId;
}

function PeopleTable({ people, locale }: { people: SeenPerson[] | null; locale: string }) {
  const { t } = useT();
  return (
    <div className="fp-table-wrap">
      <table className="fp-table rt-an-table">
        <thead>
          <tr>
            <th>{t('trkSeenColPerson')}</th>
            <th>{t('trkSeenColSeen')}</th>
            <th>{t('trkSeenColLastRead')}</th>
          </tr>
        </thead>
        <tbody>
          {people === null && <tr><td colSpan={3}><Skeleton width="100%" height={12} /></td></tr>}
          {people?.length === 0 && <tr><td colSpan={3} className="fp-muted">{t('trkSeenNoPeople')}</td></tr>}
          {people?.map(p => (
            <tr key={p.userId}>
              <td>
                <b>{p.name}</b>
                {p.username && <span className="mono fp-muted"> @{p.username}</span>}
                {!p.member && <> <span className="fp-chip ff-stale">{t('trkSeenLeft')}</span></>}
              </td>
              <td>
                <div className="rt-seen-bar">
                  <span className="mono">{t('trkPromptOf', { x: p.seen, n: p.reachable })}</span>
                  <i style={{ '--w': p.reachable ? `${Math.min(p.seen / p.reachable, 1) * 100}%` : '0%' } as CSSProperties} />
                </div>
              </td>
              <td className="fp-muted">{p.lastReadAt ? relTime(p.lastReadAt, locale) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertsTable({ alerts, names, locale }: {
  alerts: SeenAlert[] | null; names: Map<string, SeenPerson>; locale: string;
}) {
  const { t } = useT();
  return (
    <div className="fp-table-wrap">
      <table className="fp-table rt-an-table">
        <thead>
          <tr>
            <th>{t('trkSeenColSent')}</th>
            <th>{t('trkAnColPost')}</th>
            <th>{t('trkSeenColSeenBy')}</th>
          </tr>
        </thead>
        <tbody>
          {alerts === null && <tr><td colSpan={3}><Skeleton width="100%" height={12} /></td></tr>}
          {alerts?.length === 0 && <tr><td colSpan={3} className="fp-muted">{t('trkSeenNoAlerts')}</td></tr>}
          {alerts?.map(a => (
            <tr key={`${a.chatId}:${a.messageId}`}>
              <td className="fp-muted" title={new Date(a.sentAt).toLocaleString(locale)}>{relTime(a.sentAt, locale)}</td>
              <td className="rt-an-post">
                <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
                <span className="mono fp-muted"> r/{a.subreddit}</span>
              </td>
              <td className="rt-seen-cell"><div className="rt-seen-readers">
                {a.sentAs === 'bot'
                  ? <span className="fp-muted">{t('trkSeenNoReceipts')}</span>
                  : a.readers.length === 0
                    ? <span className="fp-muted">{t('trkSeenNobody')}</span>
                    : <>
                      <span className="mono">{a.members ? t('trkPromptOf', { x: a.readers.length, n: a.members }) : a.readers.length}</span>
                      {a.readers.map(r => (
                        <span key={r.userId} className="fp-chip" title={new Date(r.readAt).toLocaleString(locale)}>
                          {who(names.get(r.userId), r.userId)}
                        </span>
                      ))}
                    </>}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
