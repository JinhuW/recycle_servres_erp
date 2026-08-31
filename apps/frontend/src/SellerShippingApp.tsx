import { useEffect, useState } from 'react';
import { getSellerFill, postSellerFill, type ShipmentAddressInput } from './lib/api';
import { useT } from './lib/i18n';

// Public seller-fill page (/s/<token>): the seller a purchaser is buying from
// enters their ship-from address and box size, no login. Single column,
// phone-first — most sellers open this from a chat message.

type Props = { token: string };

export function SellerShippingApp({ token }: Props) {
  const { t } = useT();
  const [state, setState] = useState<'loading' | 'form' | 'done' | 'invalid'>('loading');
  const [destination, setDestination] = useState<string | null>(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState<ShipmentAddressInput>({
    name: '', phone: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US',
  });
  const [pkg, setPkg] = useState({ weightOz: '', lengthIn: '', widthIn: '', heightIn: '' });

  useEffect(() => {
    getSellerFill(token)
      .then((r) => {
        setDestination(r.destination);
        setAlreadySubmitted(r.submitted);
        setFrom((p) => ({
          ...p,
          name: r.from.name ?? '', phone: r.from.phone ?? '',
          street1: r.from.street1 ?? '', street2: r.from.street2 ?? '',
          city: r.from.city ?? '', state: r.from.state ?? '', zip: r.from.zip ?? '',
          country: r.from.country ?? 'US',
        }));
        setPkg({
          weightOz: r.package.weightOz != null ? String(r.package.weightOz) : '',
          lengthIn: r.package.lengthIn != null ? String(r.package.lengthIn) : '',
          widthIn: r.package.widthIn != null ? String(r.package.widthIn) : '',
          heightIn: r.package.heightIn != null ? String(r.package.heightIn) : '',
        });
        setState('form');
      })
      .catch(() => setState('invalid'));
  }, [token]);

  const setF = (k: keyof ShipmentAddressInput, v: string) => setFrom((p) => ({ ...p, [k]: v }));
  const setP = (k: keyof typeof pkg, v: string) => setPkg((p) => ({ ...p, [k]: v }));

  const num = (s: string) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : null; };
  const ready = !!(from.name.trim() && from.street1.trim() && from.city.trim()
    && from.state.trim() && from.zip.trim()
    && num(pkg.weightOz) && num(pkg.lengthIn) && num(pkg.widthIn) && num(pkg.heightIn));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postSellerFill(token, {
        from,
        package: {
          weightOz: num(pkg.weightOz)!, lengthIn: num(pkg.lengthIn)!,
          widthIn: num(pkg.widthIn)!, heightIn: num(pkg.heightIn)!,
        },
      });
      setState('done');
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('sellerFillFailed'));
    } finally {
      setBusy(false);
    }
  };

  const shellStyle: React.CSSProperties = {
    maxWidth: 560, margin: '0 auto', padding: '28px 16px 60px',
    display: 'flex', flexDirection: 'column', gap: 14,
  };

  if (state === 'loading') {
    return <div style={shellStyle}><div className="skeleton" style={{ width: '60%', height: 16, borderRadius: 4 }} /></div>;
  }

  if (state === 'invalid') {
    return (
      <div style={shellStyle}>
        <div className="brand-mark">RS</div>
        <h1 style={{ fontSize: 20, margin: '6px 0 0' }}>{t('sellerLinkInvalidTitle')}</h1>
        <p style={{ color: 'var(--fg-muted)', margin: 0 }}>{t('sellerLinkInvalidBody')}</p>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div style={shellStyle}>
        <div className="brand-mark">RS</div>
        <h1 style={{ fontSize: 20, margin: '6px 0 0' }}>{t('sellerFillDoneTitle')}</h1>
        <p style={{ color: 'var(--fg-muted)', margin: 0 }}>{t('sellerFillDoneBody')}</p>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="brand-mark">RS</div>
        <div style={{ fontWeight: 650 }}>Recycle Servers</div>
      </div>
      <h1 style={{ fontSize: 20, margin: 0, letterSpacing: '-0.01em' }}>{t('sellerFillTitle')}</h1>
      <p style={{ color: 'var(--fg-muted)', margin: 0, fontSize: 13.5 }}>
        {destination ? t('sellerFillIntroDest', { dest: destination }) : t('sellerFillIntro')}
      </p>
      {alreadySubmitted && (
        <div className="ai-banner" style={{ fontSize: 12.5 }}>{t('sellerFillEditNote')}</div>
      )}

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650 }}>{t('sellerFillYourAddress')}</div>
        <div className="field">
          <label className="label">{t('sellerFillName')} <span className="req">*</span></label>
          <input className="input" value={from.name} onChange={(e) => setF('name', e.target.value)} autoComplete="name" />
        </div>
        <div className="field">
          <label className="label">{t('shipSellerPhone')}</label>
          <input className="input" value={from.phone ?? ''} onChange={(e) => setF('phone', e.target.value)} autoComplete="tel" />
        </div>
        <div className="field">
          <label className="label">{t('shipStreet')} <span className="req">*</span></label>
          <input className="input" value={from.street1} onChange={(e) => setF('street1', e.target.value)} autoComplete="address-line1" />
        </div>
        <div className="field">
          <label className="label">{t('shipStreet2')}</label>
          <input className="input" value={from.street2 ?? ''} onChange={(e) => setF('street2', e.target.value)} autoComplete="address-line2" />
        </div>
        <div className="field-row" style={{ gridTemplateColumns: '1.4fr 0.6fr 0.9fr' }}>
          <div className="field">
            <label className="label">{t('shipCity')} <span className="req">*</span></label>
            <input className="input" value={from.city} onChange={(e) => setF('city', e.target.value)} autoComplete="address-level2" />
          </div>
          <div className="field">
            <label className="label">{t('shipState')} <span className="req">*</span></label>
            <input className="input" value={from.state} onChange={(e) => setF('state', e.target.value.toUpperCase())} autoComplete="address-level1" />
          </div>
          <div className="field">
            <label className="label">{t('shipZip')} <span className="req">*</span></label>
            <input className="input mono" value={from.zip} onChange={(e) => setF('zip', e.target.value)} autoComplete="postal-code" />
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650 }}>{t('sellerFillYourBox')}</div>
        <div className="field-hint">{t('sellerFillBoxHint')}</div>
        <div className="field-row">
          <div className="field">
            <label className="label">{t('shipWeightOz')} <span className="req">*</span></label>
            <input className="input mono" type="number" min={0} inputMode="decimal" value={pkg.weightOz} onChange={(e) => setP('weightOz', e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('shipLengthIn')} <span className="req">*</span></label>
            <input className="input mono" type="number" min={0} inputMode="decimal" value={pkg.lengthIn} onChange={(e) => setP('lengthIn', e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('shipWidthIn')} <span className="req">*</span></label>
            <input className="input mono" type="number" min={0} inputMode="decimal" value={pkg.widthIn} onChange={(e) => setP('widthIn', e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('shipHeightIn')} <span className="req">*</span></label>
            <input className="input mono" type="number" min={0} inputMode="decimal" value={pkg.heightIn} onChange={(e) => setP('heightIn', e.target.value)} />
          </div>
        </div>
      </div>

      {error && <div style={{ fontSize: 12.5, color: 'var(--neg)' }}>{error}</div>}

      <button className="btn accent lg" style={{ justifyContent: 'center' }} onClick={submit} disabled={busy || !ready}>
        {busy ? '…' : t('sellerFillSubmit')}
      </button>
      <p style={{ fontSize: 11.5, color: 'var(--fg-subtle)', margin: 0 }}>{t('sellerFillFootnote')}</p>
    </div>
  );
}
