import type { SerialIssue } from '@recycle-erp/shared';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { useEscapeKey } from '../lib/useEscapeKey';

export type SerialLineIssue = {
  lineNo: number;
  label: string;
  issue: SerialIssue;
};

// Blocking reminder shown when a save would violate the serial rules (DDR5
// requires serials; entered serials must match qty). Purely informational —
// dismissing it returns the user to the still-open form; the save never ran.
export function SerialCheckDialog({ issues, onClose }: {
  issues: SerialLineIssue[];
  onClose: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onClose);
  return (
    // Above the line drawer (z 80) so it reads as a reply to the save click.
    <div className="modal-backdrop" style={{ zIndex: 120 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
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
              <div className="modal-title">{t('serialCheckTitle')}</div>
              <div className="modal-sub">{t('serialCheckSub')}</div>
            </div>
          </div>
        </div>
        <div className="modal-body">
          <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
            {issues.map((it, i) => (
              <li key={i}>
                {it.issue.kind === 'ddr5Required'
                  ? t('serialDdr5Required', { line: it.lineNo, label: it.label })
                  : t('serialCountMismatch', {
                      line: it.lineNo, label: it.label,
                      n: it.issue.count, qty: it.issue.qty,
                    })}
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-foot">
          <button className="btn accent" onClick={onClose}>{t('serialFixBtn')}</button>
        </div>
      </div>
    </div>
  );
}
