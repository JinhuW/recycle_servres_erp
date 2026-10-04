import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { splitQuotedReply } from '../../lib/mailQuote';
import { Icon } from '../../components/Icon';
import type { WebSubmission } from './DesktopWebSubmissions';

// The email conversation on a web submission: replies go out from the shared
// company mailbox, and the customer's answers are pulled back into the same
// thread by the backend's inbox poll.

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

type ThreadResponse = { messages: ThreadMessage[]; mail: { mode: MailMode; address: string | null } };

const POLL_MS = 30_000;
const STATUS_TONE: Partial<Record<ThreadMessage['status'], string>> = {
  sending: 'muted', failed: 'neg', unconfirmed: 'warn',
};

type Props = {
  submission: WebSubmission;
  composerRef: RefObject<HTMLTextAreaElement>;
  // Reports the mail mode up so the page header knows whether "Reply" can
  // focus the composer or has to stay a mailto link.
  onMode: (mode: MailMode) => void;
  onSent: (submission: WebSubmission) => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function SubmissionThread({ submission, composerRef, onMode, onSent, onToast }: Props) {
  const { t } = useT();
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
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

  return (
    <div className="card" style={{ padding: 16, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="card-title" style={{ fontWeight: 600 }}>{t('webSubThreadTitle')}</div>
        {on && mail.address && (
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('webSubThreadFrom', { address: mail.address })}</div>
        )}
        {mail.mode === 'stub' && <span className="chip warn" style={{ fontSize: 11 }}>{t('webSubThreadStub')}</span>}
      </div>

      {messages.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: on ? 14 : 0 }}>
          {messages.map(m => <Bubble key={m.id} m={m} submissionEmail={submission.email} />)}
        </div>
      ) : on && (
        <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginBottom: 12 }}>
          {t('webSubThreadEmpty', { email: submission.email })}
        </div>
      )}

      {on ? (
        <div>
          <textarea
            ref={composerRef}
            className="textarea"
            rows={5}
            value={draft}
            placeholder={t('webSubThreadPlaceholder', { email: submission.email })}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('webSubThreadShortcut')}</span>
            <button className="btn accent" disabled={sending || !draft.trim()} onClick={() => void send()}>
              <Icon name="mail" size={13} /> {sending ? t('webSubThreadSending') : t('webSubThreadSend')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: messages.length > 0 ? 12 : 0 }}>
          {t('webSubThreadOff')}
        </div>
      )}
    </div>
  );
}

function Bubble({ m, submissionEmail }: { m: ThreadMessage; submissionEmail: string }) {
  const { t } = useT();
  const [showQuoted, setShowQuoted] = useState(false);
  const out = m.direction === 'out';
  const { reply, quoted } = splitQuotedReply(m.body);
  // A From header is trivially forged; every inbound bubble names its sender,
  // and one that isn't the submission's address says so.
  const mismatch = !out && m.from.toLowerCase() !== submissionEmail.toLowerCase();
  const tone = STATUS_TONE[m.status];
  return (
    <div style={{
      alignSelf: out ? 'flex-end' : 'flex-start',
      maxWidth: '88%',
      background: out ? 'var(--accent-soft)' : 'var(--bg-soft)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{out ? (m.author?.name ?? m.from) : m.from}</span>
        <span>· {new Date(m.createdAt).toLocaleString()}</span>
        {tone && <span className={'chip ' + tone} style={{ fontSize: 11 }}>{t(`webSubThreadStatus_${m.status}`)}</span>}
      </div>
      {(mismatch || m.dmarc === 'fail') && (
        <div className="chip warn" style={{ display: 'inline-flex', gap: 4, fontSize: 11, marginBottom: 6, whiteSpace: 'normal' }}>
          <Icon name="alert" size={12} /> {t(m.dmarc === 'fail' ? 'webSubThreadDmarcFail' : 'webSubThreadSenderMismatch')}
        </div>
      )}
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {reply || <span style={{ color: 'var(--fg-subtle)' }}>{t('webSubThreadNoText')}</span>}
      </div>
      {quoted && (
        <>
          <button className="btn ghost sm" style={{ marginTop: 6, paddingLeft: 0 }}
                  onClick={() => setShowQuoted(v => !v)}>
            {t(showQuoted ? 'webSubThreadHideQuoted' : 'webSubThreadShowQuoted')}
          </button>
          {showQuoted && (
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--fg-subtle)', borderLeft: '2px solid var(--border)', paddingLeft: 8, marginTop: 6 }}>
              {quoted}
            </div>
          )}
        </>
      )}
      {m.attachmentNames.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--fg-subtle)', marginTop: 6 }}>
          <Icon name="paperclip" size={12} />
          {t('webSubThreadAttachments', { n: m.attachmentNames.length, names: m.attachmentNames.join(', ') })}
        </div>
      )}
      {m.status === 'failed' && m.error && (
        <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 6 }}>{m.error}</div>
      )}
    </div>
  );
}
