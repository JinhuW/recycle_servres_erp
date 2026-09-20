import { Icon } from '../../../components/Icon';
import { fmtUSD } from '../../../lib/format';
import { useT } from '../../../lib/i18n';

// The page's sticky foot: the money the page is about, what is unsaved, and
// Save. The line and unit counts that used to sit here are the items card's
// head; the total is the one figure worth keeping in view while the table
// scrolls.

type Props = {
  total: number;
  fees: number;
  goodsOverridden: boolean;
  earnName: string;
  earn: number;
  /** Names of the sections with unsaved edits, already translated. */
  dirtySections: string[];
  /** The stage a Save would move the order to, when one is staged. */
  stagePending: string | null;
  onUndoStage: (() => void) | null;
  retryablePhotos: number;
  onRetryPhotos: () => void;
  retryDisabled: boolean;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  saveTitle?: string;
  locale: string;
};

export function OrderFooter(p: Props) {
  const { t } = useT();
  return (
    <div className="oe-foot">
      <div className="oe-foot-stat">
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          {t('totalCost')} {p.goodsOverridden && (
            <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
          )}
        </div>
        <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{fmtUSD(p.total, p.locale)}</div>
        {p.fees > 0 && (
          <div style={{ fontSize: 11, color: 'var(--accent-strong)', marginTop: 1 }}>
            {t('inclFees', { fees: fmtUSD(p.fees, p.locale) })}
          </div>
        )}
      </div>
      <div className="oe-foot-stat">
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('eoEarns', { name: p.earnName })}</div>
        <div className="mono" style={{ fontWeight: 600, fontSize: 17, color: p.earn >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
          {fmtUSD(p.earn, p.locale)}
        </div>
      </div>
      <div className="oe-foot-state">
        {p.stagePending && (
          <span className="chip info oe-foot-pill">
            <Icon name="flag" size={11} /> {t('eoStagePending', { s: p.stagePending })}
            {p.onUndoStage && (
              <button type="button" className="oe-foot-undo" onClick={p.onUndoStage}>{t('eoUndoStage')}</button>
            )}
          </span>
        )}
        {p.dirtySections.length > 0 && (
          <span className="oe-foot-dirty">
            <span className="oe-tab-dot blue" aria-hidden="true" />
            {t('eoUnsavedIn', { sections: p.dirtySections.join(', ') })}
          </span>
        )}
      </div>
      <div className="oe-foot-actions">
        <button className="btn" onClick={p.onCancel}>{t('cancel')}</button>
        {/* Only ever shown for photos whose upload failed: a queued photo on a
            line that has no id yet is waiting for Save, not for this. */}
        {p.retryablePhotos > 0 && (
          <button className="btn" disabled={p.retryDisabled} onClick={p.onRetryPhotos}>
            <Icon name="refresh" size={14} /> {t('linePhotoRetryAction', { n: p.retryablePhotos })}
          </button>
        )}
        <button className="btn primary" disabled={p.saving} title={p.saveTitle} onClick={p.onSave}>
          <Icon name="check2" size={14} />
          {' '}{p.saving ? '…' : p.stagePending ? t('eoSaveAndStage', { s: p.stagePending }) : t('save')}
        </button>
      </div>
    </div>
  );
}
