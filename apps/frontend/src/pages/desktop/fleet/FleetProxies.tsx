import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../../../components/Modal';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../lib/errorToast';
import {
  fleetApi, fleetDeviceFor, fleetErrorCode, type FleetBrowserEngine, type FleetProxy, type FleetProxyHealth, type FleetProxyHealthState, type FleetSlot, type FleetWorkerDetail,
} from '../../../lib/fleet';
import { ApiError } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { deviceSummary, proxyChangeVerdict, proxyChoices, proxyDraftProblem, proxyExit, proxyOpen, proxyPatch, randomOpenProxy, type ProxyDraft } from './proxyRules';
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
      // Accounts that need an exit wait on the first reading of a new URL.
      if (proxy && body.url) fleetApi.checkProxies(saved.id).catch(() => {});
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

type ProxyHealthMap = ReadonlyMap<number, FleetProxyHealthState>;

// Stock sends nothing: an explicit stock engine would enroll the account, which
// refuses a shared exit and pins it to stock once a worker has claimed it.
export const addSlotEngine = (engine: FleetBrowserEngine) => (engine === 'cloak' ? { engine } : {});

export function AddToFleetDialog({ no, proxies, limit, health: given, onClose, onDone }: {
  no: number; proxies: FleetProxy[]; limit: number; health?: ProxyHealthMap; onClose: () => void; onDone: () => void;
}) {
  const { t } = useT();
  // Until the health read answers, or when it fails, no proxy counts as down:
  // the backend refuses a down one anyway.
  const [health, setHealth] = useState<ProxyHealthMap>(() => given ?? new Map());
  useEffect(() => {
    if (given) return;
    let live = true;
    fleetApi.proxyStates().then((h) => {
      if (live) setHealth(new Map(h.states.map((s) => [s.proxy_id, s.state])));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [given]);
  const choices = useMemo(() => proxyChoices(proxies, limit, health), [proxies, limit, health]);
  // null is "any proxy with room", drawn when the form is sent.
  const [proxyId, setProxyId] = useState<number | null>(null);
  const [engine, setEngine] = useState<FleetBrowserEngine>('cloak');
  const [busy, setBusy] = useState(false);
  const chosen = proxyId === null ? null : choices.find((c) => c.proxy.id === proxyId) ?? null;
  const roomLeft = choices.some((c) => !c.full);
  const openLeft = choices.some(proxyOpen);
  // A pick a reload removed, filled or found down is not swapped for a random one.
  const pickGone = proxyId !== null && (!chosen || !proxyOpen(chosen));
  const device = chosen ? deviceSummary(fleetDeviceFor(no, chosen.proxy.timezone)) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const proxy = chosen ? chosen.proxy : randomOpenProxy(choices);
    if (busy || pickGone || !proxy) return;
    setBusy(true);
    try {
      await fleetApi.addSlot({ account_no: no, proxy_id: proxy.id, ...addSlotEngine(engine) });
      showSuccessToast(t('fpAddedToFleetToast', { n: no, proxy: proxy.label }));
      onDone();
    } catch (err) {
      // Went down since this read, or the read failed: the next pick must not
      // draw it again.
      if (fleetErrorCode(err) === 'proxy_down' || fleetErrorCode(err) === 'proxy_exhausted') setHealth((h) => new Map(h).set(proxy.id, 'down'));
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
                {choices.map(({ proxy, load, full, down, exhausted }) => (
                  <option key={proxy.id} value={proxy.id} disabled={full || down || exhausted}>
                    {proxy.label}, {t('fleetProxyUses', { n: load, max: limit })}{full && `, ${t('fpAddToFleetFull')}`}
                    {!full && down && `, ${t('fpAddToFleetDown')}`}
                    {!full && !down && exhausted && `, ${t('fpAddToFleetExhausted')}`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="fp-warn">{t(choices.length ? 'fpAddToFleetAllFull' : 'fpAddToFleetNoProxy')}</p>
          )}
          {roomLeft && !openLeft && <p className="fp-warn">{t('fpAddToFleetAllDown')}</p>}
          {openLeft && pickGone && <p className="fp-warn">{t('fpAddToFleetPickGone')}</p>}
          {device && <p className="fp-muted">{t(engine === 'cloak' ? 'fpAddToFleetDevicePilot' : 'fpAddToFleetDevice', device)}</p>}
          {roomLeft && (
            <label className="fleet-field">
              <span>{t('fpAddToFleetEngine')}</span>
              <select className="input" value={engine} disabled={busy} onChange={(e) => setEngine(e.target.value as FleetBrowserEngine)}>
                <option value="cloak">{t('fpAddToFleetArmCloak')}</option>
                <option value="stock">{t('fpAddToFleetArmStock')}</option>
              </select>
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !openLeft || pickGone}>{t('fpAddToFleetConfirm')}</button>
        </div>
      </form>
    </Modal>
  );
}

// Two steps, because a proxy that drops or shows a bad IP can cost the account:
// the pick only runs a live check, and only the second screen, which says what
// the check found and what the move does, writes anything. Nothing is sent to
// the worker either way (fleet/workers.ts).
export function ChangeProxyDialog({ slot, current, holder, onClose, onDone }: {
  slot: FleetSlot; current: FleetWorkerDetail['proxy']; holder: string | null; onClose: () => void; onDone: () => void;
}) {
  const { t } = useT();
  const no = slot.account_no;
  const [list, setList] = useState<{ proxies: FleetProxy[]; limit: number; health: ProxyHealthMap } | null>(null);
  const [proxyId, setProxyId] = useState<number | null>(null);
  // undefined until checked; null when the check itself could not run.
  const [check, setCheck] = useState<FleetProxyHealth | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) onClose(); };

  const load = useCallback(() => Promise.all([
    fleetApi.proxies(),
    fleetApi.settings().then((s) => s.max_accounts_per_proxy ?? DEFAULT_LIMIT),
    // As in Add to fleet: no health read means no proxy counts as down yet.
    fleetApi.proxyStates().then((h) => new Map(h.states.map((s) => [s.proxy_id, s.state]))).catch(() => new Map<number, FleetProxyHealthState>()),
  ]).then(([proxies, limit, health]) => setList({ proxies, limit, health })), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    load().catch((err) => { handleFetchError(err); closeRef.current(); });
  }, [load]);

  const choices = useMemo(
    () => (list ? proxyChoices(list.proxies, list.limit, list.health, slot.account_no).filter((c) => c.proxy.id !== slot.proxy_id) : []),
    [list, slot.proxy_id, slot.account_no],
  );
  const chosen = choices.find((c) => c.proxy.id === proxyId) ?? null;
  if (!list) return null;

  const runCheck = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !chosen || !proxyOpen(chosen)) return;
    setBusy(true);
    const answer = await fleetApi.checkProxies(chosen.proxy.id).catch(() => null);
    setCheck(answer?.proxies.find((p) => p.proxy_id === chosen.proxy.id) ?? null);
    setBusy(false);
  };

  if (check === undefined || !chosen) {
    const open = choices.some(proxyOpen);
    return (
      <Modal onClose={close} shellStyle={{ maxWidth: 520 }}>
        <form onSubmit={runCheck}>
          <div className="modal-head">
            <div>
              <div className="modal-title">{t('fleetChangeProxyTitle', { no })}</div>
              <div className="modal-sub">{t('fleetChangeProxySub')}</div>
            </div>
          </div>
          <div className="modal-body fleet-form">
            <div className="fleet-field">
              <span>{t('fleetChangeProxyCurrent')}</span>
              <CurrentProxy slot={slot} current={current} />
            </div>
            {open ? (
              <label className="fleet-field">
                <span>{t('fleetChangeProxyNew')}</span>
                <select className="input" value={proxyId ?? ''} disabled={busy} autoFocus
                  onChange={(e) => setProxyId(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">{t('fleetChangeProxyPick')}</option>
                  {choices.map(({ proxy, load: n, full, down, exhausted }) => (
                    <option key={proxy.id} value={proxy.id} disabled={full || down || exhausted}>
                      {proxy.label}, {t('fleetProxyUses', { n, max: list.limit })}{full && `, ${t('fpAddToFleetFull')}`}
                      {!full && down && `, ${t('fpAddToFleetDown')}`}
                      {!full && !down && exhausted && `, ${t('fpAddToFleetExhausted')}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : <p className="fp-warn">{t('fleetChangeProxyNone')}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            <button type="submit" className="btn primary" disabled={busy || !chosen || !proxyOpen(chosen)} aria-busy={busy}>
              {busy ? t('fleetChangeProxyChecking') : t('fleetChangeProxyNext')}
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  const verdict = proxyChangeVerdict(check);
  const confirm = async () => {
    if (busy || verdict === 'blocked') return;
    setBusy(true);
    try {
      await fleetApi.changeSlotProxy(no, chosen.proxy.id, slot.proxy_id);
      showSuccessToast(t('fleetChangeProxyDone', { no, label: chosen.proxy.label }));
      onDone();
    } catch (err) {
      warnOrFail(err);
      setBusy(false);
      // The page's view of the slot is what was wrong, so it reads again.
      if (fleetErrorCode(err) === 'proxy_changed' || fleetErrorCode(err) === 'exists') { onDone(); return; }
      // Filled, failed or exhausted since the list was read: back to a fresh pick.
      if (fleetErrorCode(err) === 'proxy_full' || fleetErrorCode(err) === 'proxy_down' || fleetErrorCode(err) === 'proxy_exhausted') {
        setCheck(undefined);
        setProxyId(null);
        load().catch(handleFetchError);
      }
    }
  };
  const clockFrom = slot.device?.timezone;
  const clockTo = chosen.proxy.timezone;
  const last = check?.last ?? null;
  return (
    <Modal onClose={close} shellStyle={{ maxWidth: 520 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('fleetChangeProxyConfirmTitle', { no, label: chosen.proxy.label })}</div>
          <div className="modal-sub">{t('fleetChangeProxyConfirmSub')}</div>
        </div>
      </div>
      <div className="modal-body fleet-form">
        <div className="fleet-field">
          <span>{t('fleetChangeProxyCurrent')}</span>
          <CurrentProxy slot={slot} current={current} />
        </div>
        <div className="fleet-field">
          <span>{t('fleetChangeProxyNew')}</span>
          <div>{chosen.proxy.label}<br /><small className="fp-muted mono">{proxyExit(chosen.proxy)} · {clockTo}</small></div>
        </div>
        <div className="fleet-field">
          <span>{t('fleetChangeProxyHealth')}</span>
          {!last ? <p className="fp-warn">{t('fleetChangeProxyCheckNone')}</p>
            : last.ok ? (
              <p className={verdict === 'ok' ? 'fp-ok' : 'fp-warn'}>
                {t(verdict === 'ok' ? 'fleetChangeProxyCheckOk' : 'fleetChangeProxyCheckSlow', {
                  ms: last.latency_ms ?? '—',
                  where: [last.exit_ip, [last.city, last.region, last.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—',
                })}
                {check?.uptime != null && <><br /><small className="fp-muted">{t('fleetProxyUptime', { pct: Math.round(check.uptime * 1000) / 10, n: check.checks })}</small></>}
              </p>
            ) : <p className="fp-warn">{t('fleetChangeProxyCheckFailed', { error: last.error ?? '—' })}</p>}
        </div>
        {verdict !== 'blocked' && <>
          {!slot.device?.browser_engine && clockFrom && clockFrom !== clockTo && <p>{t('fleetChangeProxyClock', { from: clockFrom, to: clockTo })}</p>}
          <p>{slot.parked ? t('fleetChangeProxyWhenParked')
            : holder ? t('fleetChangeProxyWhenRunning', { worker: holder })
            : t('fleetChangeProxyWhenFree')}</p>
          <p className="fp-warn">{t('fleetChangeProxyRisk')}</p>
        </>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={() => setCheck(undefined)} disabled={busy}>{t('fleetChangeProxyBack')}</button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="btn primary fleet-danger" onClick={confirm} disabled={busy || verdict === 'blocked'}>{t('fleetChangeProxyConfirm')}</button>
      </div>
    </Modal>
  );
}

function CurrentProxy({ slot, current }: { slot: FleetSlot; current: FleetWorkerDetail['proxy'] }) {
  const { t } = useT();
  if (current) return <div>{current.label}<br /><small className="fp-muted mono">{proxyExit(current)} · {current.timezone}</small></div>;
  return <div className="fp-muted">{slot.has_proxy ? t('fleetProxyUnlisted') : '—'}</div>;
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
