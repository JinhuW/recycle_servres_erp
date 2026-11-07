import { useEffect, useState } from 'react';
import type { FbAgentProfileRow, FbSellerAccount } from '@recycle-erp/shared';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { fbAgentApi, fbSellerApi, fbSellerChanged } from '../../../lib/fbSeller';
import { useT } from '../../../lib/i18n';
import { fbSellerTabPath, hrefFor, onLinkClick } from '../../../lib/route';
import '../../../styles/fbSeller.css';

// Whether this worker's account searches or sells, and for a seller whether
// the agent answers its conversations and with which profile version. Only
// rows in the database change: no container restarts and no login happens,
// and a worker picks the role up at its next task.

export function FleetSellerCard({ accountNo, readOnly }: { accountNo: number; readOnly: boolean }) {
  const { t } = useT();
  const [acct, setAcct] = useState<FbSellerAccount | null>(null);
  const [profiles, setProfiles] = useState<FbAgentProfileRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // An ERP without the seller routes yet answers 404; the card stays away.
    fbSellerApi.accounts().then(r => { if (live) setAcct(r.rows.find(a => a.account_no === accountNo) ?? null); }, () => {});
    fbAgentApi.profiles().then(r => { if (live) setProfiles(r.rows); }, () => {});
    return () => { live = false; };
  }, [accountNo]);

  if (!acct) return null;
  const save = async (body: Parameters<typeof fbSellerApi.patchAccount>[1], toast: string) => {
    setBusy(true);
    try { setAcct(await fbSellerApi.patchAccount(accountNo, body)); fbSellerChanged(); showSuccessToast(toast); } catch (e) { handleFetchError(e); } finally { setBusy(false); }
  };
  const seller = acct.role === 'seller';
  const usable = profiles.filter(p => p.state !== 'retired' || p.id === acct.agent_profile_id);
  const leads = fbSellerTabPath('inbox');

  return (
    <section className="card fbs-fleet-card" aria-label={t('fbs_fleet_title')}>
      <div className="fbs-fleet-head">
        <h3>{t('fbs_fleet_title')}</h3>
        {seller && <a className="rl-link" href={hrefFor(leads)} onClick={onLinkClick(leads)}>{t('fbs_fleet_open_leads')}</a>}
      </div>
      <p className="help">{t('fbs_fleet_hint')}</p>
      <fieldset disabled={readOnly || busy} className="fbs-fleet-row">
        <div className="seg" role="group" aria-label={t('fbs_fleet_role')}>
          <button className={!seller ? 'active' : ''} aria-pressed={!seller} onClick={() => seller && void save({ role: 'search' }, t('fbs_fleet_now_search'))}>{t('fbs_role_search')}</button>
          <button className={seller ? 'active' : ''} aria-pressed={seller} onClick={() => !seller && void save({ role: 'seller' }, t('fbs_fleet_now_seller'))}>{t('fbs_role_seller')}</button>
        </div>
        {seller && <>
          <label className="fbs-check"><input type="checkbox" checked={acct.agent_on} onChange={e => void save({ agent_on: e.target.checked }, t(e.target.checked ? 'fbs_fleet_agent_on' : 'fbs_fleet_agent_off'))} />{t('fbs_fleet_agent')}</label>
          <select className="input" value={acct.agent_profile_id ?? ''} aria-label={t('fbs_fleet_profile')}
            onChange={e => void save({ agent_profile_id: e.target.value ? Number(e.target.value) : null }, t('fbs_fleet_profile_set'))}>
            <option value="">{t('fbs_fleet_follow_active')}</option>
            {usable.map(p => <option key={p.id} value={p.id}>{p.name} v{p.version} · {t(`fbs_pstate_${p.state}`)}</option>)}
          </select>
        </>}
      </fieldset>
      {seller && <p className="rl-sub">{t('fbs_fleet_stats', { ads: acct.live_ads, threads: acct.open_threads, waiting: acct.needs_human, sends: acct.sends_today })}</p>}
    </section>
  );
}
