import { useMemo, useState } from 'react';
import { Modal } from '../../../components/Modal';
import { parsePoolImport, type PoolAccount, type PoolDraft } from '../../../lib/facebookPool';
import { useT } from '../../../lib/i18n';
import { CloseButton, usePoolDialogFocus } from './shared';
const EXAMPLES = [
  '13\t61560221947310\tDemoOnly!13\tJBSWY3DPEHPK3PXP\tnora.vance@outlook.example\tDemoMail!13\tnora.rec@mail.example\tc_user=61560221947310; xs=demo\tAged 2y, Marketplace on',
  '14----61560388120456----DemoOnly!14----KRSXG5CTMVRXEZLU----d.ferris@hotmail.example----DemoMail!14----dferris.rec@mail.example----c_user=61560388120456; xs=demo----Profile photo set',
  '15|61560410055872|DemoOnly!15|GEZDGNBVGY3TQOJQ|p.salgado@gmx.example|DemoMail!15|||',
  '16|61556203481174|DemoDuplicate!|JBSWY3DPEHPK3PXP|duplicate@outlook.example||||Duplicate of #1',
].join('\n');
export function AccountImport({
  accounts,
  onClose,
  onImport,
}: {
  accounts: PoolAccount[];
  onClose: () => void;
  onImport: (drafts: PoolDraft[], batch: string) => void;
}) {
  const { t } = useT();
  usePoolDialogFocus();
  const [text, setText] = useState('');
  const [batch, setBatch] = useState(`Batch ${new Date().toISOString().slice(0, 10)}`);
  const rows = useMemo(() => parsePoolImport(text, accounts), [text, accounts]);
  const ready = rows.filter((r) => !r.errors.length);
  return (
    <Modal
      onClose={onClose}
      shellClassName="fp-dialog fp-import"
      shellStyle={{ maxWidth: 960 }}
      ariaLabel={t('fpImportTitle')}
    >
      <div className="modal-head">
        <div>
          <h2 className="modal-title">{t('fpImportTitle')}</h2>
          <p className="modal-sub">{t('fpImportHelp')}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        <div className="fp-column-order">
          {[
            '#',
            'fpUid',
            'fpPassword',
            'fpKey',
            'fpEmail',
            'fpEmailPassword',
            'fpRecovery',
            'fpCookie',
            'fpNotes',
          ].map((k) => (
            <span key={k}>{k === '#' ? '#' : t(k)}</span>
          ))}
        </div>
        <div className="fp-field">
          <span className="fp-row fp-between">
            <label htmlFor="fp-import-rows">{t('fpRows')}</label>
            <button type="button" className="btn ghost sm" onClick={() => setText(EXAMPLES)}>
              {t('fpExamples')}
            </button>
          </span>
          <textarea
            id="fp-import-rows"
            className="input mono"
            rows={6}
            spellCheck={false}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <label className="fp-field">
          <span>{t('fpBatch')}</span>
          <input className="input" value={batch} onChange={(e) => setBatch(e.target.value)} />
        </label>
        <div className="fp-table-wrap">
          <table className="fp-table">
            <thead>
              <tr>
                {['fpLine', 'fpUid', 'fpEmail', 'fpKey', 'fpCookie', 'fpCheck'].map((k) => (
                  <th key={k}>{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.line}>
                  <td>{row.line}</td>
                  <td className="mono">{row.draft.uid || '—'}</td>
                  <td>{row.draft.email || '—'}</td>
                  <td>{row.draft.totp ? '✓' : '—'}</td>
                  <td>{row.draft.cookie ? '✓' : '—'}</td>
                  <td
                    className={
                      row.errors.length ? 'fp-bad' : row.warnings.length ? 'fp-warn' : 'fp-ok'
                    }
                  >
                    {t(row.errors.length ? 'fpSkip' : 'fpReady')}
                    {[...row.errors, ...row.warnings].map((key) => (
                      <div key={key}>{t(key)}</div>
                    ))}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="fp-empty">
                    {t('fpPastePreview')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="modal-foot">
        <span className="fp-import-summary" aria-live="polite">
          {t('fpImportSummary', { ready: ready.length, skipped: rows.length - ready.length })}
        </span>
        <button type="button" className="btn" onClick={onClose}>
          {t('fpCancel')}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!ready.length}
          onClick={() =>
            onImport(
              ready.map((r) => r.draft),
              batch.trim() || 'Imported',
            )
          }
        >
          {t('fpImportGo', { n: ready.length })}
        </button>
      </div>
    </Modal>
  );
}
