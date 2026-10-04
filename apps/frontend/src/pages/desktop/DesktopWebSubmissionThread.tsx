import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { mailDate, mailSnippet, splitQuotedReply } from '../../lib/mailQuote';
import { Icon } from '../../components/Icon';
import type { WebSubmission } from './DesktopWebSubmissions';

// The email conversation on a web submission, laid out the way a mail client
// shows a thread: replies go out from the shared company mailbox, and the
// customer's answers are pulled back into the same thread by the backend's
// inbox poll.

export type MailMode = 'smtp' | 'stub' | 'off';

type ThreadMessage = {
  id: string;
  direction: 'out' | 'in';
  from: string;
  to: string;
  subject: string;
  body: string;
  status: 'sending' | 'sent' | 'failed' | 'received' | 'unconfirmed';
  error: string | null;
  dmarc: string | null;
  attachmentNames: string[];
  author: { id: string; name: string | null } | null;
  createdAt: string;
};

type ThreadResponse = {
  messages: ThreadMessage[];
  mail: {
    mode: MailMode;
    address: string | null;
    // The sender name replies go out under, the thread's title, and the
    // subject the next send carries.
    fromName: string;
    threadSubject: string;
    replySubject: string;
  };
};

const POLL_MS = 30_000;
const STATUS_TONE: Partial<Record<ThreadMessage['status'], string>> = {
  sending: 'muted', failed: 'neg', unconfirmed: 'warn',
};

type Props = {
  submission: WebSubmission;
  composerRef: RefObject<HTMLTextAreaElement>;
  // Reports the mail mode up so the page header knows whether "Reply" can
  // focus the draft or has to stay a mailto link.
  onMode: (mode: MailMode) => void;
  onSent: (submission: WebSubmission) => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function SubmissionThread({ submission, composerRef, onMode, onSent, onToast }: Props) {
  const { t } = useT();
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // What is open: a row the user toggled stays as they left it; otherwise any
  // message that has been the newest while the page is up. A reply landing on
  // the poll opens itself without folding the one being read.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [autoOpen, setAutoOpen] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  const id = submission.id;

  const load = useCallback(async () => {
    try {
      const r = await api.get<ThreadResponse>(`/api/web-submissions/${encodeURIComponent(id)}/messages`);
      if (!alive.current) return;
      setThread(r);
      onMode(r.mail.mode);
    } catch {
      // A backend from before the thread existed answers 404 here; the page
      // keeps working as it did, with the mailto link.
      if (!alive.current) return;
      setThread(null);
      onMode('off');
    }
  }, [id, onMode]);

  useEffect(() => {
    alive.current = true;
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const handle = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive.current = false;
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const lastId = thread?.messages[thread.messages.length - 1]?.id;
  useEffect(() => {
    if (lastId) setAutoOpen(prev => (prev.has(lastId) ? prev : new Set(prev).add(lastId)));
  }, [lastId]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await api.post<{ message: ThreadMessage; submission: WebSubmission }>(
        `/api/web-submissions/${encodeURIComponent(id)}/messages`, { body });
      setDraft('');
      setThread(prev => prev && { ...prev, messages: [...prev.messages, r.message] });
      onSent(r.submission);
      onToast?.(t('webSubThreadSent'));
      // The draft's Subject turns into `Re: …` once something has gone out.
      void load();
    } catch (e) {
      onToast?.(e instanceof ApiError && e.status === 502 ? t('webSubThreadSendFailed') : (e instanceof Error ? e.message : String(e)), 'error');
      // The failed attempt is on the thread now, with its error.
      await load();
    } finally {
      if (alive.current) setSending(false);
    }
  };

  if (!thread) return null;
  const { messages, mail } = thread;
  const on = mail.mode !== 'off';
  const isOpen = (m: ThreadMessage) => toggled.get(m.id) ?? (autoOpen.has(m.id) || m.id === lastId);
  const toggle = (m: ThreadMessage) => setToggled(prev => new Map(prev).set(m.id, !isOpen(m)));

  return (
    <section className="card ws-mail" aria-label={mail.threadSubject}>
      <div className="ws-mail-head">
        <h2 className="ws-mail-subject">{mail.threadSubject}</h2>
        {messages.length > 0 && (
          <span className="ws-mail-count">
            {messages.length === 1 ? t('webSubThreadCountOne') : t('webSubThreadCount', { n: messages.length })}
          </span>
        )}
      </div>

      {messages.length === 0 && on && (
        <div className="ws-mail-empty">{t('webSubThreadEmpty', { email: submission.email })}</div>
      )}

      {messages.map(m => (
        <MessageRow key={m.id} m={m} open={isOpen(m)} onToggle={() => toggle(m)}
                    fromName={mail.fromName} submissionEmail={submission.email} />
      ))}

      {on ? (
        <div className="ws-mail-draft" role="group" aria-label={t('webSubReplyHere')}>
          <dl className="ws-mail-fields">
            <div className="ws-mail-field">
              <dt>{t('webSubThreadFieldFrom')}</dt>
              <dd>{mail.fromName} &lt;{mail.address}&gt;</dd>
            </div>
            <div className="ws-mail-field">
              <dt>{t('webSubThreadFieldTo')}</dt>
              <dd>{submission.email}</dd>
            </div>
            <div className="ws-mail-field">
              <dt>{t('webSubThreadFieldSubject')}</dt>
              <dd>{mail.replySubject}</dd>
            </div>
          </dl>
          <textarea
            ref={composerRef}
            className="ws-mail-compose"
            rows={5}
            value={draft}
            aria-label={t('webSubThreadPlaceholder')}
            placeholder={t('webSubThreadPlaceholder')}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
          />
          <div className="ws-mail-draft-foot">
            <span className="ws-mail-hint">{t('webSubThreadShortcut')}</span>
            {mail.mode === 'stub' && <span className="chip warn" title={t('webSubThreadStub')}>{t('webSubThreadStubShort')}</span>}
            <button className="btn accent" disabled={sending || !draft.trim()} onClick={() => void send()}>
              <Icon name="mail" size={13} /> {sending ? t('webSubThreadSending') : t('webSubThreadSend')}
            </button>
          </div>
        </div>
      ) : (
        <div className="ws-mail-off">{t('webSubThreadOff')}</div>
      )}
    </section>
  );
}

function MessageRow({ m, open, onToggle, fromName, submissionEmail }: {
  m: ThreadMessage;
  open: boolean;
  onToggle: () => void;
  fromName: string;
  submissionEmail: string;
}) {
  const { t, locale } = useT();
  const [showQuoted, setShowQuoted] = useState(false);
  const ours = m.direction === 'out';
  const { reply, quoted } = splitQuotedReply(m.body);
  const snippet = mailSnippet(m.body);
  // A From header is trivially forged; every inbound message names its
  // sender, and one that isn't the submission's address says so.
  const warning = ours ? null
    : m.dmarc === 'fail' ? t('webSubThreadDmarcFail')
    : m.from.toLowerCase() !== submissionEmail.toLowerCase() ? t('webSubThreadSenderMismatch')
    : null;
  const tone = STATUS_TONE[m.status];
  const statusChip = tone && (
    <span className={'chip ' + tone}>
      {m.status === 'sending' && t('webSubThreadShort_sending')}
      {m.status === 'failed' && t('webSubThreadShort_failed')}
      {m.status === 'unconfirmed' && t('webSubThreadShort_unconfirmed')}
    </span>
  );
  const stamp = (
    <span className={'ws-mail-stamp' + (ours ? ' is-ours' : '')} aria-hidden="true">
      {(ours ? fromName : m.from).charAt(0)}
    </span>
  );
  const bodyId = `ws-mail-body-${m.id}`;

  return (
    <article className={'ws-mail-msg' + (open ? ' is-open' : '')}>
      <button type="button" className="ws-mail-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined}
              onClick={onToggle}>
        {stamp}
        {open ? (
          <span className="ws-mail-env">
            <span className="ws-mail-env-top">
              <span className="ws-mail-from">
                <strong>{ours ? fromName : m.from}</strong>
                {ours && <span className="ws-mail-addr"> &lt;{m.from}&gt;</span>}
              </span>
              {statusChip}
              <span className="ws-mail-date">
                {new Date(m.createdAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </span>
            <span className="ws-mail-to">
              {t('webSubThreadToLine', { email: m.to })}
              {ours && m.author?.name && <> · {t('webSubThreadSentBy', { name: m.author.name })}</>}
            </span>
          </span>
        ) : (
          <>
            <span className="ws-mail-who">{ours ? fromName : m.from}</span>
            <span className={'ws-mail-snippet' + (snippet ? '' : ' is-empty')}>
              {snippet || t('webSubThreadNoText')}
            </span>
            <span className="ws-mail-flags">
              {warning && (
                <span className="ws-mail-flag-warn">
                  <Icon name="alert" size={13} /><span className="ws-mail-sr">{warning}</span>
                </span>
              )}
              {m.attachmentNames.length > 0 && <Icon name="paperclip" size={13} />}
              {statusChip}
            </span>
            <span className="ws-mail-date">{mailDate(m.createdAt, new Date(), locale)}</span>
          </>
        )}
      </button>

      {open && (
        <div className="ws-mail-body" id={bodyId}>
          {warning && (
            <p className="ws-mail-note is-warn"><Icon name="alert" size={13} /> {warning}</p>
          )}
          {m.status === 'unconfirmed' && (
            <p className="ws-mail-note is-warn">{t('webSubThreadStatus_unconfirmed')}</p>
          )}
          {m.status === 'failed' && m.error && <p className="ws-mail-note is-neg">{m.error}</p>}
          <div className={'ws-mail-text' + (reply ? '' : ' is-empty')}>{reply || t('webSubThreadNoText')}</div>
          {quoted && (
            <>
              <button type="button" className="ws-mail-quote-toggle" aria-expanded={showQuoted}
                      aria-label={showQuoted ? t('webSubThreadHideQuoted') : t('webSubThreadShowQuoted')}
                      title={showQuoted ? t('webSubThreadHideQuoted') : t('webSubThreadShowQuoted')}
                      onClick={() => setShowQuoted(v => !v)}>
                ···
              </button>
              {showQuoted && <div className="ws-mail-quoted">{quoted}</div>}
            </>
          )}
          {m.attachmentNames.length > 0 && (
            <div className="ws-mail-files">
              {m.attachmentNames.map((name, i) => (
                <span key={i} className="ws-mail-file"><Icon name="paperclip" size={12} />{name}</span>
              ))}
              <span className="ws-mail-files-hint">{t('webSubThreadAttachOpen')}</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
