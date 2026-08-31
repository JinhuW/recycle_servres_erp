import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { useEscapeKey } from '../lib/useEscapeKey';

export type ErrorDialogContent = {
  msg: string;
  // Per-problem lines. A blocked save lists every field it is waiting on so
  // the fix is one pass, not one dialog per attempt.
  details?: string[];
  title?: string;
};

type QueuedError = ErrorDialogContent & { seq: number };

const sameProblem = (a: ErrorDialogContent, b: ErrorDialogContent) =>
  a.msg === b.msg && a.title === b.title
  && (a.details ?? []).join('\n') === (b.details ?? []).join('\n');

/**
 * Errors queue instead of overwriting one another: a photo upload and an
 * evidence upload can fail in the same submit, and the second problem used to
 * replace the first before it had been read.
 *
 * Both shells share it so they cannot answer the same failure differently.
 */
export function useErrorDialogQueue() {
  const [queue, setQueue] = useState<QueuedError[]>([]);
  const seq = useRef(0);
  // A repeat of a problem still waiting to be read is the same problem, so it
  // doesn't earn a second OK click.
  const push = useCallback((next: ErrorDialogContent) => {
    setQueue(prev => (prev.some(d => sameProblem(d, next))
      ? prev
      : [...prev, { ...next, seq: ++seq.current }]));
  }, []);
  const dismiss = useCallback(() => setQueue(ds => ds.slice(1)), []);
  return { current: queue[0] ?? null, push, dismiss };
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// The single surface for errors: a blocking dialog, not a corner toast that
// scrolls a validation message past the user in 2.6s. Both shells render one
// of these and register it on window (see lib/errorToast.ts).
export function ErrorDialog({ content, onClose }: {
  content: ErrorDialogContent;
  onClose: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onClose);
  const shellRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  // The caret goes back where it came from. The dialog interrupts an action —
  // a Save, a photo pick — and leaves the user at the control that raised it.
  // Read during the first render, not in the effect: by the time effects run,
  // `autoFocus` has already moved focus onto the OK button.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => () => { if (opener instanceof HTMLElement) opener.focus(); }, [opener]);

  // Tab must not reach the drawer behind an opaque backdrop: the fields are
  // invisible, so a keyboard user would be typing into a form they can't see.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = [...(shellRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    if (document.activeElement !== edge) return;
    e.preventDefault();
    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
  };

  return (
    // Above every other modal (drawers sit at 80, dialogs at 100–120): an error
    // is always a reply to whatever is already open.
    <div className="modal-backdrop" style={{ zIndex: 200 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={shellRef}
        className="modal-shell"
        style={{ maxWidth: 460 }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={trapTab}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--warn-soft)', color: 'var(--warn-strong)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="alert" size={18} />
            </div>
            <div>
              <div className="modal-title" id={titleId}>{content.title ?? t('errDialogTitle')}</div>
              <div className="modal-sub" id={bodyId}>{content.msg}</div>
            </div>
          </div>
        </div>
        {content.details && content.details.length > 0 && (
          <div className="modal-body">
            <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
              {content.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
        )}
        <div className="modal-foot">
          <button className="btn accent" autoFocus onClick={onClose}>{t('errDialogOk')}</button>
        </div>
      </div>
    </div>
  );
}
