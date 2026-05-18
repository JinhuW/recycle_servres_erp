import { useEffect, useState } from 'react';
import { useT } from './lib/i18n';
import {
  type CatalogItem, type BasketLine, itemLabel, basketTotal,
} from './lib/vendor';

type Tab = 'browse' | 'mine';

export function VendorApp({ token }: { token: string }) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('browse');
  const [me, setMe] = useState<{ customer: { name: string }; label: string | null } | null>(null);
  const [groups, setGroups] = useState<{ category: string; items: CatalogItem[] }[]>([]);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [review, setReview] = useState(false);

  const base = `/api/public/vendor/${encodeURIComponent(token)}`;

  useEffect(() => {
    (async () => {
      const m = await fetch(`${base}/me`);
      if (m.status === 404) { setNotFound(true); return; }
      setMe(await m.json());
      const cat = await fetch(`${base}/catalog`);
      if (cat.ok) setGroups((await cat.json()).groups);
    })();
  }, [base]);

  if (notFound) {
    return <div style={{ padding: 40, textAlign: 'center' }}>
      <h2>Link unavailable</h2>
      <p style={{ color: 'var(--fg-muted)' }}>This link is invalid or has expired.</p>
    </div>;
  }

  function addToBasket(it: CatalogItem, qty: number, unitPrice: number) {
    setBasket(b => {
      const rest = b.filter(x => x.inventoryId !== it.id);
      return [...rest, {
        inventoryId: it.id, label: itemLabel(it), category: it.category,
        qty: Math.max(1, Math.min(qty, it.qty)), unitPrice, available: it.qty,
      }];
    });
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{ background: 'var(--fg)', color: '#fff', padding: '14px 16px' }}>
        <b>Recycle Servers — Stock</b>
        <div style={{ fontSize: 12, color: '#b9c0c8' }}>
          {me ? `Shared with: ${me.customer.name}` : '…'}
        </div>
      </header>

      <div style={{ display: 'flex', margin: 12, background: 'var(--bg-soft)', borderRadius: 8, padding: 3 }}>
        {(['browse', 'mine'] as Tab[]).map(x => (
          <button key={x} onClick={() => { setTab(x); setReview(false); }}
            style={{
              flex: 1, padding: 8, border: 0, borderRadius: 6, cursor: 'pointer',
              background: tab === x ? '#fff' : 'transparent',
              fontWeight: tab === x ? 700 : 400,
            }}>
            {x === 'browse' ? t('vendorBrowse') : t('vendorMyOffers')}
          </button>
        ))}
      </div>

      {tab === 'browse' && !review && (
        <BrowseView groups={groups} t={t} onAdd={addToBasket} basketCount={basket.length}
          onReview={() => setReview(true)} />
      )}
      {tab === 'browse' && review && (
        <ReviewView base={base} basket={basket} t={t}
          onBack={() => setReview(false)}
          onDone={() => { setBasket([]); setReview(false); setTab('mine'); }} />
      )}
      {tab === 'mine' && <MyOffersView base={base} t={t} />}
    </div>
  );
}

function BrowseView({ groups, t, onAdd, basketCount, onReview }: {
  groups: { category: string; items: CatalogItem[] }[];
  t: (k: string, p?: Record<string, string | number>) => string;
  onAdd: (it: CatalogItem, qty: number, price: number) => void;
  basketCount: number; onReview: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState('');
  return (
    <div style={{ padding: '0 12px 90px' }}>
      {groups.map(g => (
        <div key={g.category}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-subtle)', margin: '14px 2px 6px' }}>
            {g.category} · {g.items.length}
          </div>
          {g.items.map(it => (
            <div key={it.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 11, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{itemLabel(it)}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '3px 0 8px' }}>
                {[it.part_number, it.condition].filter(Boolean).join(' · ')}
              </div>
              {openId === it.id ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <label style={{ fontSize: 11 }}>{t('vendorQty')} (≤{it.qty})
                    <input type="number" min={1} max={it.qty} value={qty}
                      onChange={e => setQty(+e.target.value)} className="input" style={{ width: 70 }} />
                  </label>
                  <label style={{ fontSize: 11, flex: 1 }}>{t('vendorYourOffer')}
                    <input type="number" min={0} step="0.01" value={price}
                      onChange={e => setPrice(e.target.value)} className="input"
                      style={{ borderColor: 'var(--accent)' }} />
                  </label>
                  <button className="btn accent" disabled={!price}
                    onClick={() => { onAdd(it, qty, +price); setOpenId(null); setQty(1); setPrice(''); }}>
                    Add
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--accent-strong)' }}>
                    {t('vendorAvailable', { n: it.qty })}
                  </span>
                  <button className="btn" onClick={() => setOpenId(it.id)}>{t('vendorAddOffer')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {basketCount > 0 && (
        <div style={{
          position: 'sticky', bottom: 0, margin: '0 -12px', background: 'var(--fg)',
          color: '#fff', padding: '12px 16px', display: 'flex', justifyContent: 'space-between',
        }}>
          <span>{basketCount} in offer</span>
          <button className="btn accent" onClick={onReview}>{t('vendorReview')} →</button>
        </div>
      )}
    </div>
  );
}

function ReviewView({ base, basket, t, onBack, onDone }: {
  base: string; basket: BasketLine[];
  t: (k: string) => string; onBack: () => void; onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    setBusy(true); setErr('');
    const r = await fetch(`${base}/bids`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactName: name, note,
        lines: basket.map(l => ({ inventoryId: l.inventoryId, qty: l.qty, unitPrice: l.unitPrice })),
      }),
    });
    setBusy(false);
    if (r.ok) onDone();
    else setErr((await r.json().catch(() => ({}))).error ?? 'Submit failed');
  }
  return (
    <div style={{ padding: '0 16px 24px' }}>
      <button className="btn ghost" onClick={onBack}>← Back</button>
      {basket.map(l => (
        <div key={l.inventoryId} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
          <span>{l.label}<br /><small style={{ color: 'var(--fg-muted)' }}>{l.qty} × ${l.unitPrice}</small></span>
          <b>${(l.qty * l.unitPrice).toFixed(2)}</b>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 700 }}>
        <span>{t('vendorTotalOffered')}</span><span>${basketTotal(basket).toFixed(2)}</span>
      </div>
      <input className="input" placeholder={t('vendorContactName')} value={name}
        onChange={e => setName(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
      <textarea className="input" placeholder={t('vendorNote')} value={note}
        onChange={e => setNote(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
      {err && <p style={{ color: 'var(--neg)' }}>{err}</p>}
      <button className="btn accent" disabled={!name || busy}
        onClick={submit} style={{ width: '100%', marginTop: 14 }}>
        {t('vendorSubmit')}
      </button>
      <p style={{ fontSize: 11, color: 'var(--fg-muted)', textAlign: 'center', marginTop: 10 }}>
        {t('vendorNonBinding')}
      </p>
    </div>
  );
}

function MyOffersView({ base, t }: { base: string; t: (k: string) => string }) {
  const [bids, setBids] = useState<Array<{
    id: string; status: string; createdAt: string;
    lines: Array<{ label: string; offeredQty: number; offeredUnitPrice: number;
      status: string; acceptedUnitPrice: number | null }>;
  }>>([]);
  useEffect(() => { (async () => {
    const r = await fetch(`${base}/bids`);
    if (r.ok) setBids((await r.json()).bids);
  })(); }, [base]);
  const badge: Record<string, string> = {
    pending: t('vendorPending'), accepted: t('vendorAccepted'), declined: t('vendorDeclined'),
  };
  return (
    <div style={{ padding: '0 16px 24px' }}>
      {bids.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>No offers yet.</p>}
      {bids.map(b => (
        <div key={b.id} style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>
            {b.id} · {new Date(b.createdAt).toLocaleDateString()}
          </div>
          {b.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{l.label}<br /><small style={{ color: 'var(--fg-muted)' }}>
                {l.offeredQty} × ${l.offeredUnitPrice}
                {l.acceptedUnitPrice != null && ` → @ $${l.acceptedUnitPrice}`}
              </small></span>
              <span className="chip">{badge[l.status] ?? l.status}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
