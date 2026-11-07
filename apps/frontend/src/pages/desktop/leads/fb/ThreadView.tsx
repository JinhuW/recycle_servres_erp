import { useEffect, useRef, useState } from 'react';
import type { FbAgentRunBrief, FbMessage, FbSellerSettings, FbThreadDetail, FbThreadEvent } from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { Modal } from '../../../../components/Modal';
import { TableSkeleton } from '../../../../components/Skeleton';
import { handleFetchError, showSuccessToast } from '../../../../lib/errorToast';
import { fbSellerApi, fbSellerChanged, offerLadder, usePolled } from '../../../../lib/fbSeller';
import { fmtDateShort } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { fbSellerTabPath, hrefFor, onLinkClick } from '../../../../lib/route';
import { AccountCell, Ago, Money, SendChip, StageChip } from './shared';

// One seller conversation: the messages with who wrote each outbound and how
// far it got, and beside them what the agent made of it — the items and ask
// it extracted, the Market rows and ceiling, the offer ladder, the rules that
// fired, the thread's events. A manager takes over, replies, hands back or
// closes from here. Polls every 15 s while the tab is visible.

const POLL_MS = 15_000;

export function ThreadView({ id }: { id: number }) {
  const { t } = useT();
  const { data: d, setData, reload } = usePolled(() => fbSellerApi.thread(id), POLL_MS, [id]);
  const settings = usePolled(() => fbSellerApi.settings(), null, []);
  const accts = usePolled(() => fbSellerApi.accounts(), null, []);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'won' | 'lost' | 'case' | null>(null);

  // Opening the thread is reading it.
  const marked = useRef(false);
  useEffect(() => {
    if (!d?.unread || marked.current) return;
    marked.current = true;
    fbSellerApi.read(id).then(() => { setData(x => x && { ...x, unread: false }); fbSellerChanged(); }, () => {});
  }, [d?.unread, id, setData]);

  const act = async (run: () => Promise<FbThreadDetail>, toast: string) => {
    setBusy(true);
    try {
      setData(await run());
      fbSellerChanged();
      showSuccessToast(toast);
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };

  const back = fbSellerTabPath(d?.needs_human ? 'needs' : 'inbox');
  if (!d) return <TableSkeleton rows={6} cols={2} />;
  const closed = !!d.closed_at;

  return (
    <div className="fbs-thread">
      <div className="fbs-thread-head">
        <a className="btn ghost sm" href={hrefFor(back)} onClick={onLinkClick(back)}><Icon name="chevronLeft" size={13} />{t(d.needs_human ? 'fbs_tab_needs' : 'fbs_tab_inbox')}</a>
        <div className="fbs-thread-title">
          <h2>{d.seller_name || t('fbs_unknown_seller')}</h2>
          <div className="rl-dmeta">
            <StageChip stage={d.stage} />
            <span className={`chip ${d.mode === 'human' ? 'info' : 'muted'}`}>{t(d.mode === 'human' ? 'fbs_mode_human' : 'fbs_mode_agent')}</span>
            <AccountCell no={d.account_no} accounts={accts.data?.rows ?? null} />
            <span className="rl-clip">{d.listing_title}</span>
          </div>
        </div>
        <div className="rl-actions">
          {!closed && d.mode === 'agent' && (
            <button className="btn" disabled={busy} onClick={() => void act(() => fbSellerApi.takeOver(id), t('fbs_took_over'))}>{t('fbs_take_over')}</button>
          )}
          {!closed && (d.mode === 'human' || d.needs_human) && (
            <button className="btn" disabled={busy} onClick={() => void act(() => fbSellerApi.handBack(id), t('fbs_handed_back'))}
              title={t('fbs_hand_back_hint')}>{t('fbs_hand_back')}</button>
          )}
          {!closed && <button className="btn" disabled={busy} onClick={() => setDialog('won')}>{t('fbs_close_won')}</button>}
          {!closed && <button className="btn" disabled={busy} onClick={() => setDialog('lost')}>{t('fbs_close_lost')}</button>}
          <button className="btn ghost" disabled={busy} onClick={() => setDialog('case')}>{t('fbs_save_case')}</button>
        </div>
      </div>

      {d.needs_human && (
        <div className="fbs-banner warn"><Icon name="alert" size={14} />
          <div><b>{t('fbs_needs_since')} <Ago at={d.human_at} /></b><p>{d.human_reason ?? t('fbs_no_reason')}</p></div>
        </div>
      )}
      {closed && (
        <div className="fbs-banner"><Icon name="check" size={14} />
          <div><b>{t('fbs_closed_as', { outcome: t(`fbs_stage_${d.stage}`) })}</b>{d.close_note && <p>{d.close_note}</p>}</div>
        </div>
      )}

      <div className="fbs-thread-layout">
        <div className="card fbs-convo">
          <Conversation messages={d.messages} />
          {!closed && <Composer id={id} human={d.mode === 'human'} onSent={m => { setData(x => x && { ...x, messages: [...x.messages, m] }); void reload(); }} />}
        </div>
        <ThreadSide d={d} offer={settings.data?.value.offer ?? null} />
      </div>

      {(dialog === 'won' || dialog === 'lost') && (
        <CloseDialog outcome={dialog} onClose={() => setDialog(null)}
          onDone={next => { setDialog(null); setData(next); fbSellerChanged(); showSuccessToast(t('fbs_closed_toast')); }} id={id} />
      )}
      {dialog === 'case' && <SaveCaseDialog thread={d} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ─── The conversation ─────────────────────────────────────────────────────────

const AUTHOR_KEY: Record<FbMessage['author'], string> = {
  seller: 'fbs_author_seller', agent: 'fbs_author_agent', staff: 'fbs_author_staff', facebook: 'fbs_author_facebook',
};

export function Conversation({ messages }: { messages: readonly FbMessage[] }) {
  const { t, locale } = useT();
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1]?.id;
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [last]);
  if (!messages.length) return <p className="rl-empty">{t('fbs_no_messages')}</p>;
  return (
    <ol className="fbs-msgs">
      {messages.map(m => {
        const side = m.direction === 'in' ? 'in' : m.direction === 'out' ? 'out' : 'unknown';
        return (
          <li key={m.id} className={`fbs-msg fbs-msg-${side} fbs-by-${m.author}`}>
            <div className="fbs-bubble">
              {m.body}
              {m.has_image && <span className="fbs-img"><Icon name="image" size={13} />{t('fbs_has_image')}</span>}
            </div>
            <div className="fbs-msg-meta">
              <span>{m.author === 'staff' && m.staff_name ? m.staff_name : t(AUTHOR_KEY[m.author])}</span>
              {side === 'unknown' && <span className="chip warn" title={t('fbs_unknown_dir_hint')}>{t('fbs_unknown_dir')}</span>}
              <time dateTime={m.sent_at ?? m.created_at}>{new Date(m.sent_at ?? m.created_at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
              <SendChip m={m} />
            </div>
            {m.send_state === 'failed' && m.error && <div className="fbs-msg-error">{m.error}</div>}
          </li>
        );
      })}
      <div ref={end} />
    </ol>
  );
}

function Composer({ id, human, onSent }: { id: number; human: boolean; onSent: (m: FbMessage) => void }) {
  const { t } = useT();
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      onSent(await fbSellerApi.reply(id, text));
      setBody('');
    } catch (err) {
      handleFetchError(err);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="fbs-composer">
      {!human && <p className="help">{t('fbs_reply_while_agent')}</p>}
      <textarea className="input" rows={3} value={body} maxLength={600} placeholder={t('fbs_reply_placeholder')} aria-label={t('fbs_reply_placeholder')}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      <div className="rl-between">
        <span className="help">{t('fbs_reply_hint', { n: body.length })}</span>
        <button className="btn primary" disabled={!body.trim() || sending} onClick={() => void send()}>
          <Icon name="mail" size={13} />{t('fbs_send')}
        </button>
      </div>
    </div>
  );
}

// ─── The side panel ───────────────────────────────────────────────────────────

function ThreadSide({ d, offer }: { d: FbThreadDetail; offer: FbSellerSettings['offer'] | null }) {
  const { t, locale } = useT();
  const x = 'items' in d.extracted ? d.extracted : null;
  const ladder = offer && d.ceiling_usd !== null ? offerLadder(d.ceiling_usd, offer) : null;
  const fired = d.runs.filter(r => !r.shadow).slice(0, 5);
  return (
    <aside className="fbs-side">
      <section className="card fbs-panel">
        <h3>{t('fbs_extracted')}</h3>
        {!x ? <p className="rl-muted">{t('fbs_nothing_extracted')}</p> : (
          <>
            <ul className="fbs-items">
              {x.items.map((it, i) => (
                <li key={i}><span className="mono">{it.part_number ?? '—'}</span> <span>{it.description}</span> <b>× {it.qty ?? '?'}</b></li>
              ))}
            </ul>
            <dl className="fbs-dl">
              <dt>{t('fbs_seller_ask')}</dt><dd><Money usd={x.seller_ask_usd} /></dd>
              <dt>{t('fbs_intent')}</dt><dd>{t(`fbs_intent_${x.intent}`)}{x.agreeing && <> · <b>{t('fbs_agreeing')}</b></>}</dd>
              <dt>{t('fbs_confidence')}</dt><dd>{Math.round(x.confidence * 100)}%</dd>
            </dl>
          </>
        )}
      </section>

      <section className="card fbs-panel">
        <h3>{t('fbs_market')}</h3>
        {!d.market.length ? <p className="rl-muted">{t('fbs_no_market')}</p> : (
          <ul className="fbs-items">
            {d.market.map(m => (
              <li key={m.canon}>
                <span className="mono">{m.part_number}</span> <span>{m.label}</span>
                <span className="rl-sub">{t('fbs_max_buy', { usd: m.max_buy_unit === null ? '—' : `$${m.max_buy_unit}` })} · {m.price_at ? t('fbs_price_from', { date: fmtDateShort(m.price_at, locale) }) : t('fbs_no_price_date')}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="fbs-dl">
          <dt>{t('fbs_col_ceiling')}</dt><dd><Money usd={d.ceiling_usd} /></dd>
          <dt>{t('fbs_col_offer')}</dt><dd><Money usd={d.offer_usd} />{d.round > 0 && <span className="rl-muted"> · {t('fbs_round_n', { n: d.round })}</span>}</dd>
        </dl>
      </section>

      {ladder && (
        <section className="card fbs-panel">
          <h3>{t('fbs_ladder')}</h3>
          <ol className="fbs-ladder">
            {ladder.map((usd, r) => (
              <li key={r} className={r === d.round && d.offer_usd !== null ? 'on' : r < d.round ? 'past' : undefined}>
                <span>{t('fbs_round_n', { n: r })}</span><b><Money usd={usd} /></b>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="card fbs-panel">
        <h3>{t('fbs_runs')}</h3>
        {!fired.length ? <p className="rl-muted">{t('fbs_no_runs')}</p> : (
          <ul className="fbs-runs">{fired.map(r => <RunLine key={r.id} r={r} />)}</ul>
        )}
      </section>

      <section className="card fbs-panel">
        <h3>{t('fbs_events')}</h3>
        <ul className="fbs-events">
          {[...d.events].reverse().map(e => <EventLine key={e.id} e={e} />)}
        </ul>
      </section>
    </aside>
  );
}

export function RunLine({ r }: { r: FbAgentRunBrief }) {
  const { t } = useT();
  const dec = r.decision;
  return (
    <li>
      <div className="rl-between">
        <span className={`chip ${r.outcome === 'send' ? 'pos' : r.outcome === 'handoff' ? 'warn' : r.outcome === 'blocked' || r.outcome === 'error' ? 'neg' : 'muted'}`}>
          {t(`fbs_outcome_${r.outcome ?? r.state}`)}
        </span>
        <Ago at={r.finished_at ?? r.created_at} />
      </div>
      {dec?.rules_fired.map((f, i) => <p key={i} className="fbs-fired"><b>{f.kind}</b> {f.reason}</p>)}
      {dec && !dec.guard.ok && dec.guard.failures.map((f, i) => <p key={`g${i}`} className="fbs-fired neg">{f}</p>)}
      {dec?.reply && <p className="fbs-said">“{dec.reply}”</p>}
      {r.error && <p className="fbs-fired neg">{r.error}</p>}
    </li>
  );
}

function EventLine({ e }: { e: FbThreadEvent }) {
  const { t } = useT();
  const reason = typeof e.detail.reason === 'string' ? e.detail.reason : null;
  return (
    <li>
      <span>{t(`fbs_event_${e.kind}`)}{e.actor_name !== 'system' && <span className="rl-muted"> · {e.actor_name}</span>}</span>
      <Ago at={e.created_at} />
      {reason && <p className="rl-sub">{reason}</p>}
    </li>
  );
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

function CloseDialog({ id, outcome, onClose, onDone }: { id: number; outcome: 'won' | 'lost'; onClose: () => void; onDone: (d: FbThreadDetail) => void }) {
  const { t } = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { onDone(await fbSellerApi.close(id, outcome, note.trim() || undefined)); } catch (err) { handleFetchError(err); setBusy(false); }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <div className="modal-head"><div><div className="modal-title">{t(outcome === 'won' ? 'fbs_close_won' : 'fbs_close_lost')}</div>
        <div className="modal-sub">{t('fbs_close_sub')}</div></div></div>
      <div className="modal-body">
        <label className="field"><span className="label">{t('fbs_close_note')}</span>
          <textarea className="input" rows={3} value={note} onChange={e => setNote(e.target.value)} autoFocus /></label>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>{t(outcome === 'won' ? 'fbs_close_won' : 'fbs_close_lost')}</button>
      </div>
    </Modal>
  );
}

function SaveCaseDialog({ thread, onClose }: { thread: FbThreadDetail; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(`${thread.seller_name || t('fbs_unknown_seller')} · ${t(`fbs_stage_${thread.stage}`)}`);
  const [handoff, setHandoff] = useState(thread.needs_human);
  const [reason, setReason] = useState('');
  const [maxOffer, setMaxOffer] = useState('');
  const [banned, setBanned] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const words = banned.split('\n').map(s => s.trim()).filter(Boolean);
      await fbSellerApi.saveCase(thread.id, name.trim(), {
        handoff,
        ...(reason.trim() ? { reason_kind: reason.trim() } : {}),
        ...(maxOffer.trim() ? { max_offer_usd: Number(maxOffer) } : {}),
        ...(words.length ? { must_not_contain: words } : {}),
      });
      showSuccessToast(t('fbs_case_saved'));
      onClose();
    } catch (err) {
      handleFetchError(err);
      setBusy(false);
    }
  };
  const badOffer = maxOffer.trim() !== '' && !(Number(maxOffer) >= 0);
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <div className="modal-head"><div><div className="modal-title">{t('fbs_save_case')}</div><div className="modal-sub">{t('fbs_save_case_sub')}</div></div></div>
      <div className="modal-body">
        <label className="field"><span className="label">{t('fbs_case_name')}</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
        <label className="fbs-check"><input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} />{t('fbs_case_expect_handoff')}</label>
        <label className="field"><span className="label">{t('fbs_case_reason_kind')}</span>
          <input className="input mono" value={reason} onChange={e => setReason(e.target.value)} placeholder="closing" /></label>
        <label className="field"><span className="label">{t('fbs_case_max_offer')}</span>
          <input className="input" inputMode="decimal" value={maxOffer} onChange={e => setMaxOffer(e.target.value)} />
          {badOffer && <span className="help fbs-error">{t('fbs_err_number')}</span>}</label>
        <label className="field"><span className="label">{t('fbs_case_banned')}</span>
          <textarea className="input" rows={2} value={banned} onChange={e => setBanned(e.target.value)} /><span className="help">{t('fbs_one_per_line')}</span></label>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !name.trim() || badOffer}>{t('fbs_save_case')}</button>
      </div>
    </Modal>
  );
}
