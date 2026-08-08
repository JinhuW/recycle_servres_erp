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

// The single surface for errors: a blocking dialog, not a corner toast that
// scrolls a validation message past the user in 2.6s. Both shells render one
// of these and register it on window (see lib/errorToast.ts).
export function ErrorDialog({ content, onClose }: {
  content: ErrorDialogContent;
  onClose: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onClose);
  return (
    // Above every other modal (drawers sit at 80, dialogs at 100–120): an error
    // is always a reply to whatever is already open.
    <div className="modal-backdrop" style={{ zIndex: 200 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal-shell"
        style={{ maxWidth: 460 }}
        role="alertdialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="alert" size={18} />
            </div>
            <div>
              <div className="modal-title">{content.title ?? t('errDialogTitle')}</div>
              <div className="modal-sub">{content.msg}</div>
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
