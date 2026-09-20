import { HandoffBlockers, HandoffFields } from './HandoffDialog';
import { useT } from '../lib/i18n';
import { useHandoffForm, type HandoffInit } from '../lib/useHandoffForm';

// The phone's Draft → In Transit hand-off: the same fields as the desktop
// dialog, on the shell's slide-up sheet.

type Props = {
  init: HandoffInit;
  onClose: () => void;
  onDone: (r: { packageId: string | null }) => void;
};

export function PhHandoffSheet({ init, onClose, onDone }: Props) {
  const { t } = useT();
  const f = useHandoffForm(init, onDone);
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={() => { if (!f.busy) onClose(); }} />
      <div className="ph-sheet ph-ho-sheet" role="dialog" aria-modal="true" aria-labelledby="ph-ho-title">
        <div className="ph-sheet-grabber" />
        <div className="ph-ho-head">
          <div>
            <div id="ph-ho-title" className="ph-ho-title">{t('hoTitle')}</div>
            <div className="ph-ho-sub">{t('hoSub')}</div>
          </div>
          <button type="button" className="ph-ho-close" onClick={onClose} disabled={f.busy}>{t('cancel')}</button>
        </div>
        <HandoffFields f={f} phone />
        <HandoffBlockers keys={f.blockerKeys} />
        <button
          type="button"
          className="ph-btn dark"
          style={{ width: '100%', marginTop: 14, height: 46 }}
          onClick={() => void f.submit()}
          disabled={!f.canSubmit}
        >
          {f.busy ? t('hoWorking') : t('hoConfirm')}
        </button>
      </div>
    </>
  );
}
