import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Modal } from '../../../components/Modal';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../lib/errorToast';
import {
  fleetApi, fleetDeviceFor, fleetErrorCode, type FleetProxy, type FleetSlot,
} from '../../../lib/fleet';
import { ApiError } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { deviceSummary, proxyChoices, proxyDraftProblem, proxyExit, proxyPatch, randomOpenProxy, type ProxyDraft } from './proxyRules';
import { ConfirmDialogBody } from './shared';
import '../../../styles/fleet.css';

// ─── Proxies and Add to fleet ─────────────────────────────────────────────────
// The Account pool tab's way into the ERP fleet: the dialogs that put an
// available account on one of the ERP's proxies or take a fleet account out
// again, and the proxy add/edit/remove dialogs the Proxies tab opens. The ERP generates the account's browser and the host
// agent starts a worker for it; nothing here talks to a worker.

const DEFAULT_LIMIT = 2;

export type FleetProxyState = { proxies: FleetProxy[] | null; limit: number; reload: () => void };

/** The proxy list and the per-proxy limit, for a manager's pool tab; null until read, or when the fleet API is not served. */
export function useFleetProxies(on: boolean): FleetProxyState {
  const [proxies, setProxies] = useState<FleetProxy[] | null>(null);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const reload = useCallback(() => {
    fleetApi.proxies().then(setProxies).catch(() => undefined);
    fleetApi.settings().then((s) => setLimit(s.max_accounts_per_proxy ?? DEFAULT_LIMIT)).catch(() => undefined);
  }, []);
  useEffect(() => { if (on) reload(); }, [on, reload]);
  return { proxies, limit, reload };
}

/** A refusal the backend explains in `detail`; anything else is the usual error dialog. */
function warnOrFail(err: unknown): void {
  const detail = err instanceof ApiError ? (err.body as { detail?: unknown } | undefined)?.detail : undefined;
  if (err instanceof ApiError && (err.status === 409 || err.status === 422) && typeof detail === 'string') showWarnToast(detail);
  else handleFetchError(err);
}

// The URL field starts empty even when editing: the ERP never sends it back.
export function ProxyDialog({ proxy, onClose, onDone }: { proxy: FleetProxy | null; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [draft, setDraft] = useState<ProxyDraft>({
    label: proxy?.label ?? '', url: '', timezone: proxy?.timezone ?? 'America/New_York', note: proxy?.note ?? '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ProxyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const bad = proxyDraftProblem(draft, proxy !== null);
    if (bad) { setProblem(t(bad)); return; }
    const body = proxyPatch(draft, proxy);
    if (proxy && Object.keys(body).length === 0) { onClose(); return; }
    setBusy(true);
    setProblem(null);
    try {
      const saved = proxy
        ? await fleetApi.updateProxy(proxy.id, body)
        : await fleetApi.addProxy({ label: body.label, url: body.url, timezone: body.timezone, ...(body.note ? { note: body.note } : {}) });
      showSuccessToast(t('fleetProxySaved', { label: saved.label }));
      onDone();
    } catch (err) {
      const detail = err instanceof ApiError ? (err.body as { detail?: unknown } | undefined)?.detail : undefined;
      if (typeof detail === 'string' && err instanceof ApiError && err.status < 500) setProblem(detail);
      else handleFetchError(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{proxy ? t('fleetProxyEditTitle', { label: proxy.label }) : t('fleetProxyAddTitle')}</div>
            <div className="modal-sub">{t('fleetProxiesSub')}</div>
          </div>
        </div>
        <div className="modal-body fleet-form">
          <label className="fleet-field">
            <span>{t('fleetProxyLabel')}</span>
            <input className="input" value={draft.label} onChange={(e) => set({ label: e.target.value })} maxLength={80} autoFocus
              placeholder="Decodo NY 1" />
          </label>
          <label className="fleet-field">
            <span>{t('fleetProxyUrl')}</span>
            <input className="input mono" type="password" value={draft.url} onChange={(e) => set({ url: e.target.value })}
              autoComplete="new-password" spellCheck={false} placeholder={proxy ? proxyExit(proxy) : 'http://user:pass@host:port'} />
            <small className="fp-muted">{t('fleetProxyUrlHint')}{proxy && <> {t('fleetProxyUrlKeep')}</>}</small>
          </label>
          <label className="fleet-field">
            <span>{t('fleetProxyTimezone')}</span>
            <input className="input mono" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} spellCheck={false}
              list="fleet-proxy-zones" />
            <datalist id="fleet-proxy-zones">
              {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'].map((z) => <option key={z} value={z} />)}
            </datalist>
            <small className="fp-muted">{t('fleetProxyTimezoneHint')}</small>
          </label>
          <label className="fleet-field">
            <span>{t('fleetProxyNote')}</span>
            <input className="input" value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} />
          </label>
          {problem && <p role="alert" className="fp-warn">{problem}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RemoveProxyDialog({ proxy, onClose, onDone }: { proxy: FleetProxy; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.removeProxy(proxy.id);
      showSuccessToast(t('fleetProxyRemoved', { label: proxy.label }));
      onDone();
    } catch (err) {
      warnOrFail(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetProxyRemoveTitle', { label: proxy.label })} confirm={t('fleetProxyRemove')} busy={busy} danger
        onClose={onClose} onConfirm={confirm} body={<p>{t('fleetProxyRemoveBody')}</p>} />
    </Modal>
  );
}

export function AddToFleetDialog({ no, proxies, limit, onClose, onDone }: {
  no: number; proxies: FleetProxy[]; limit: number; onClose: () => void; onDone: () => void;
}) {
  const { t } = useT();
  const choices = useMemo(() => proxyChoices(proxies, limit), [proxies, limit]);
  // null is "any proxy with room", drawn when the form is sent.
  const [proxyId, setProxyId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = proxyId === null ? null : choices.find((c) => c.proxy.id === proxyId) ?? null;
  const roomLeft = choices.some((c) => !c.full);
  const device = chosen ? deviceSummary(fleetDeviceFor(no, chosen.proxy.timezone)) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const proxy = chosen ? chosen.proxy : randomOpenProxy(choices);
    if (busy || !proxy) return;
    setBusy(true);
    try {
      await fleetApi.addSlot({ account_no: no, proxy_id: proxy.id });
      showSuccessToast(t('fpAddedToFleetToast', { n: no, proxy: proxy.label }));
      onDone();
    } catch (err) {
      warnOrFail(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fpAddToFleetTitle', { n: no })}</div>
            <div className="modal-sub">{t('fpAddToFleetSub')}</div>
          </div>
        </div>
        <div className="modal-body fleet-form">
          {roomLeft ? (
            <label className="fleet-field">
              <span>{t('fpAddToFleetProxy')}</span>
              <select className="input" value={proxyId ?? ''} disabled={busy}
                onChange={(e) => setProxyId(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">{t('fpAddToFleetRandom')}</option>
                {choices.map(({ proxy, load, full }) => (
                  <option key={proxy.id} value={proxy.id} disabled={full}>
                    {proxy.label}, {t('fleetProxyUses', { n: load, max: limit })}{full && `, ${t('fpAddToFleetFull')}`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="fp-warn">{t(choices.length ? 'fpAddToFleetAllFull' : 'fpAddToFleetNoProxy')}</p>
          )}
          {device && <p className="fp-muted">{t('fpAddToFleetDevice', device)}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !roomLeft}>{t('fpAddToFleetConfirm')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RemoveFromFleetDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.removeSlot(slot.account_no);
      showSuccessToast(t('fpRemovedFromFleetToast', { n: slot.account_no }));
      onDone();
    } catch (err) {
      if (fleetErrorCode(err) === 'leased') showWarnToast(t('fpRemoveFromFleetLeased'));
      else warnOrFail(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fpRemoveFromFleetTitle', { n: slot.account_no })} confirm={t('fpRemoveFromFleet')} busy={busy} danger
        onClose={onClose} onConfirm={confirm} body={<p>{t('fpRemoveFromFleetBody')}</p>} />
    </Modal>
  );
}
