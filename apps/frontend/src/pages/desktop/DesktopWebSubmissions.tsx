import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { match, navigate, useRoute } from '../../lib/route';
import { Icon } from '../../components/Icon';
import { SubmissionThread, type MailMode } from './DesktopWebSubmissionThread';

// Manager inbox for the public website forms: ram4cash.com sell lots and
// recycleservers.com quote requests. A sell lot becomes a Draft PO only when
// someone clicks Create Draft PO here.

type Status = 'new' | 'contacted' | 'converted' | 'archived' | 'spam';
type Site = 'ram4cash' | 'recycleservers';

type SellLine = { category: string; qty: number; fields: Record<string, string> };
type SellPayload = {
  email: string; notes: string | null; source: string;
  handoff: 'ship' | 'pickup'; pickup_location: string | null; lines: SellLine[];
};
type QuotePayload = {
  customer_type: string; hardware: string[]; quantity: string | null; condition: string | null;
  data_handling: string | null; pickup_method: string | null; origin_zip: string | null;
  timeline: string | null;
};

export type WebSubmission = {
  id: string;
  site: Site;
  kind: 'sell_lot' | 'quote';
  status: Status;
  name: string | null;
  company: string | null;
  email: string;
  phone: string | null;
  notes: string | null;
  source: string | null;
  payload: SellPayload | QuotePayload;
  orderId: string | null;
  staffNote: string | null;
  handledBy: { id: string; name: string | null } | null;
  photoCount: number;
  createdAt: string;
  updatedAt: string;
  photos?: { id: string; lineIndex: number; filename: string; url: string }[];
};

type ListResponse = { items: WebSubmission[]; nextCursor: string | null; counts: Record<Status, number> };

const STATUSES: Status[] = ['new', 'contacted', 'converted', 'archived', 'spam'];
const STATUS_TONE: Record<Status, string> = {
  new: 'accent', contacted: 'info', converted: 'pos', archived: 'muted', spam: 'neg',
};
const SITE_LABEL: Record<Site, string> = { ram4cash: 'ram4cash.com', recycleservers: 'recycleservers.com' };

type Props = { onToast?: (msg: string, kind?: 'success' | 'error') => void };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function summarize(s: WebSubmission): string {
  if (s.kind === 'sell_lot') {
    const p = s.payload as SellPayload;
    const units = p.lines.reduce((n, l) => n + l.qty, 0);
    const cats = [...new Set(p.lines.map(l => l.category))].join(' / ');
    return `${cats} · ${p.lines.length} line${p.lines.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'}`;
  }
  const p = s.payload as QuotePayload;
  return [p.hardware.join(', '), p.quantity].filter(Boolean).join(' · ');
}

function lineLabel(l: SellLine): string {
  const f = l.fields;
  return [f.brand, f.capacity, f.classification, f.speed, f.rank, f.interface, f.form_factor, f.description]
    .filter(Boolean).join(' ') || l.category;
}

export function DesktopWebSubmissions({ onToast }: Props = {}) {
  const { path } = useRoute();
  const detail = match('/web-submissions/:id', path);
  return detail
    ? <SubmissionDetail id={decodeURIComponent(detail.id!)} onToast={onToast} />
    : <SubmissionList onToast={onToast} />;
}

function SubmissionList({ onToast }: Props) {
  const { t } = useT();
  const [status, setStatus] = useState<Status | 'all'>('new');
  const [site, setSite] = useState<Site | 'all'>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<WebSubmission[] | null>(null);
  const [counts, setCounts] = useState<Record<Status, number> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A filter change bumps reqId, so a "load more" still in flight from the old
  // filters can't append its page under the new ones.  The ref, not the state,
  // is the in-flight guard: a double click lands before the re-render.
  const reqId = useRef(0);
  const moreInFlight = useRef(false);

  // The search box settles before it queries.
  useEffect(() => {
    const h = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);

  const url = useCallback((after: string | null) => {
    const sp = new URLSearchParams();
    if (status !== 'all') sp.set('status', status);
    if (site !== 'all') sp.set('site', site);
    if (query) sp.set('q', query);
    if (after) sp.set('cursor', after);
    return `/api/web-submissions?${sp.toString()}`;
  }, [status, site, query]);

  useEffect(() => {
    let live = true;
    ++reqId.current;
    moreInFlight.current = false;
    setLoadingMore(false);
    setItems(null);
    setCursor(null);
    api.get<ListResponse>(url(null))
      .then(r => {
        if (!live) return;
        setItems(r.items);
        setCounts(r.counts);
        setCursor(r.nextCursor);
      })
      .catch(e => { if (live) { setItems([]); onToast?.(errMsg(e), 'error'); } });
    return () => { live = false; };
  }, [url, onToast]);

  const loadMore = async () => {
    if (!cursor || moreInFlight.current) return;
    const id = reqId.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(url(cursor));
      if (id !== reqId.current) return;
      setItems(prev => [...(prev ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (id === reqId.current) onToast?.(errMsg(e), 'error');
    } finally {
      if (id === reqId.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  };

  const total = counts ? STATUSES.reduce((n, s) => n + counts[s], 0) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('webSubTitle')}</h1>
          <div className="page-sub">{t('webSubSubtitle')}</div>
        </div>
        <div className="page-actions">
          {(['all', 'ram4cash', 'recycleservers'] as const).map(s => (
            <button key={s} className={'btn' + (site === s ? ' accent' : '')} onClick={() => setSite(s)}>
              {s === 'all' ? t('webSubSiteAll') : SITE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {(['all', ...STATUSES] as const).map(s => (
          <button key={s} className={'btn' + (status === s ? ' accent' : '')} onClick={() => setStatus(s)}>
            {t(s === 'all' ? 'webSubStatusAll' : `webSubStatus_${s}`)}
            {counts && (
              <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>
                {s === 'all' ? total : counts[s]}
              </span>
            )}
          </button>
        ))}
        <input
          className="input"
          style={{ marginLeft: 'auto', minWidth: 240 }}
          placeholder={t('webSubSearch')}
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {items === null ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('webSubLoading')}</div>
      ) : items.length === 0 ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('webSubEmpty')}</div>
      ) : (
        <div className="card" style={{ padding: 0, flexShrink: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('webSubColRef')}</th>
                <th>{t('webSubColReceived')}</th>
                <th>{t('webSubColSite')}</th>
                <th>{t('webSubColFrom')}</th>
                <th>{t('webSubColSummary')}</th>
                <th>{t('webSubColStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(s => (
                <tr key={s.id} style={{ cursor: 'pointer' }}
                    onClick={() => navigate('/web-submissions/' + encodeURIComponent(s.id))}>
                  <td className="mono" style={{ fontWeight: 600 }}>{s.id}</td>
                  <td>{new Date(s.createdAt).toLocaleString()}</td>
                  <td>{SITE_LABEL[s.site]}</td>
                  <td>
                    <div>{s.name ?? s.email}{s.company ? ` · ${s.company}` : ''}</div>
                    {s.name && <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{s.email}</div>}
                  </td>
                  <td>
                    {summarize(s)}
                    {s.photoCount > 0 && (
                      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                        {' · '}{t('webSubPhotos', { n: s.photoCount })}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={'chip ' + STATUS_TONE[s.status]} style={{ fontSize: 11 }}>
                      {t(`webSubStatus_${s.status}`)}
                    </span>
                    {s.orderId && <span className="mono" style={{ fontSize: 12, marginLeft: 6 }}>{s.orderId}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? '…' : t('webSubLoadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, padding: '6px 0' }}>
      <div style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  );
}

function SubmissionDetail({ id, onToast }: Props & { id: string }) {
  const { t } = useT();
  const [s, setS] = useState<WebSubmission | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Unknown until the thread loads; the header keeps the mailto link until
  // the backend says it can send.
  const [mailMode, setMailMode] = useState<MailMode | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    api.get<{ submission: WebSubmission }>(`/api/web-submissions/${encodeURIComponent(id)}`)
      .then(r => { if (live) { setS(r.submission); setNote(r.submission.staffNote ?? ''); } })
      .catch(e => { if (live) { setMissing(true); onToast?.(errMsg(e), 'error'); } });
    return () => { live = false; };
  }, [id, onToast]);

  const patch = async (body: { status?: Status; staffNote?: string }) => {
    setBusy(true);
    try {
      const r = await api.patch<{ submission: WebSubmission }>(`/api/web-submissions/${encodeURIComponent(id)}`, body);
      setS(r.submission);
      onToast?.(t('webSubSaved'));
    } catch (e) {
      onToast?.(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const convert = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ orderId: string; submission: WebSubmission }>(
        `/api/web-submissions/${encodeURIComponent(id)}/convert`, {});
      setS(r.submission);
      onToast?.(t('webSubConverted', { id: r.orderId }));
    } catch (e) {
      onToast?.(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button className="btn" onClick={() => navigate('/web-submissions')}>
      <Icon name="chevronLeft" size={13} /> {t('webSubBack')}
    </button>
  );

  if (missing) return <div style={{ padding: 24 }}>{back}<div className="page-sub" style={{ marginTop: 16 }}>{t('webSubNotFound')}</div></div>;
  if (!s) return <div className="page-sub" style={{ padding: 24 }}>{t('webSubLoading')}</div>;

  const sell = s.kind === 'sell_lot' ? (s.payload as SellPayload) : null;
  const quote = s.kind === 'quote' ? (s.payload as QuotePayload) : null;
  const replySubject = encodeURIComponent(`Re: your ${s.kind === 'sell_lot' ? 'sell request' : 'quote request'} ${s.id}`);

  return (
    <>
      <div className="page-head">
        <div>
          <div style={{ marginBottom: 8 }}>{back}</div>
          <h1 className="page-title">
            <span className="mono">{s.id}</span>{' '}
            <span className={'chip ' + STATUS_TONE[s.status]} style={{ fontSize: 12, verticalAlign: 'middle' }}>
              {t(`webSubStatus_${s.status}`)}
            </span>
          </h1>
          <div className="page-sub">
            {t(s.kind === 'sell_lot' ? 'webSubKind_sell_lot' : 'webSubKind_quote')} · {SITE_LABEL[s.site]} · {new Date(s.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="page-actions">
          {mailMode && mailMode !== 'off' ? (
            <button className="btn" onClick={() => {
              composerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              composerRef.current?.focus({ preventScroll: true });
            }}>
              <Icon name="mail" size={13} /> {t('webSubReplyHere')}
            </button>
          ) : (
            <a className="btn" href={`mailto:${s.email}?subject=${replySubject}`}>
              <Icon name="mail" size={13} /> {t('webSubReply')}
            </a>
          )}
          {sell && !s.orderId && (
            <button className="btn accent" disabled={busy} onClick={convert}>
              <Icon name="plus" size={13} /> {t('webSubConvert')}
            </button>
          )}
          {s.orderId && (
            <button className="btn accent" onClick={() => navigate('/purchase-orders/' + encodeURIComponent(s.orderId!))}>
              <Icon name="arrow" size={13} /> {t('webSubOpenPo', { id: s.orderId })}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 16, flexShrink: 0 }}>
            <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>{t('webSubContact')}</div>
            <Field label={t('webSubName')} value={s.name} />
            <Field label={t('webSubCompany')} value={s.company} />
            <Field label={t('webSubEmail')} value={<a href={`mailto:${s.email}`}>{s.email}</a>} />
            <Field label={t('webSubPhone')} value={s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : null} />
            {sell && (
              <>
                <Field label={t('webSubHandoff')}
                       value={sell.handoff === 'pickup'
                         ? t('webSubHandoffPickup', { city: sell.pickup_location ?? '?' })
                         : t('webSubHandoffShip')} />
                <Field label={t('webSubSource')} value={sell.source} />
              </>
            )}
            {quote && (
              <>
                <Field label={t('webSubCustomerType')} value={quote.customer_type} />
                <Field label={t('webSubHardware')} value={quote.hardware.join(', ')} />
                <Field label={t('webSubQuantity')} value={quote.quantity} />
                <Field label={t('webSubCondition')} value={quote.condition} />
                <Field label={t('webSubDataHandling')} value={quote.data_handling} />
                <Field label={t('webSubPickupMethod')} value={quote.pickup_method} />
                <Field label={t('webSubZip')} value={quote.origin_zip} />
                <Field label={t('webSubTimeline')} value={quote.timeline} />
              </>
            )}
            <Field label={t('webSubNotes')} value={s.notes} />
          </div>

          {sell && (
            <div className="card" style={{ padding: 16, flexShrink: 0 }}>
              <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>{t('webSubLines')}</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('webSubColCategory')}</th>
                    <th>{t('webSubColItem')}</th>
                    <th>{t('webSubColPart')}</th>
                    <th style={{ textAlign: 'right' }}>{t('webSubColQty')}</th>
                    <th>{t('webSubColPhotos')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sell.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td>{l.category}</td>
                      <td>{lineLabel(l)}</td>
                      <td className="mono">{l.fields.part_number ?? ''}</td>
                      <td style={{ textAlign: 'right' }}>{l.qty}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {(s.photos ?? []).filter(p => p.lineIndex === i).map(p => (
                            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" title={p.filename}>
                              <img src={p.url} alt={p.filename}
                                   style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                            </a>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <SubmissionThread submission={s} composerRef={composerRef} onMode={setMailMode} onSent={setS} onToast={onToast} />
        </div>

        <div className="card" style={{ padding: 16, flexShrink: 0 }}>
          <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>{t('webSubTriage')}</div>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-subtle)', marginBottom: 4 }}>
            {t('webSubColStatus')}
          </label>
          <select
            className="input"
            value={s.status}
            disabled={busy || s.status === 'converted'}
            onChange={e => patch({ status: e.target.value as Status })}
            style={{ width: '100%', marginBottom: 12 }}
          >
            {STATUSES.filter(x => x !== 'converted' || s.status === 'converted').map(x => (
              <option key={x} value={x}>{t(`webSubStatus_${x}`)}</option>
            ))}
          </select>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--fg-subtle)', marginBottom: 4 }}>
            {t('webSubStaffNote')}
          </label>
          <textarea className="textarea" rows={5} value={note} onChange={e => setNote(e.target.value)}
                    style={{ width: '100%' }} />
          <button className="btn" style={{ marginTop: 8 }}
                  disabled={busy || note === (s.staffNote ?? '')}
                  onClick={() => patch({ staffNote: note })}>
            {t('save')}
          </button>
          {s.handledBy && (
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 12 }}>
              {t('webSubHandledBy', { name: s.handledBy.name ?? '—', when: new Date(s.updatedAt).toLocaleString() })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
