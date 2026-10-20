import { useMemo, useState } from 'react';
import { Modal } from '../../../components/Modal';
import { parsePoolImport, type PoolAccount, type PoolDraft } from '../../../lib/facebookPool';
import { useT } from '../../../lib/i18n';
import { CloseButton } from './shared';
const EXAMPLES = [
  '13\t61560221947310\tDemoOnly!13\tJBSWY3DPEHPK3PXP\tnora.vance@outlook.example\tDemoMail!13\tnora.rec@mail.example\tc_user=61560221947310; xs=demo\tEAADemoToken13\tAged 2y, Marketplace on',
  '14----61560388120456----DemoOnly!14----KRSXG5CTMVRXEZLU----d.ferris@hotmail.example----DemoMail!14----dferris.rec@mail.example----c_user=61560388120456; xs=demo----EAADemoToken14----Profile photo set',
  '15|61560410055872|DemoOnly!15|GEZDGNBVGY3TQOJQ|p.salgado@gmx.example|DemoMail!15|||',
  '16|61556203481174|DemoDuplicate!|JBSWY3DPEHPK3PXP|duplicate@outlook.example|||||Duplicate of #1',
].join('\n');
// A supplier order sheet, pasted with its header row: comma-separated, any
// column order, cookie and token before the e-mail.
const CSV_EXAMPLE = [
  '序号,账号（UID）,密码,2FA/验证码,Cookie,令牌,邮箱,邮箱密码',
  '1,61560221947310,DemoOnly!13,JBSWY3DPEHPK3PXP,"c_user=61560221947310; xs=demo",EAADemoToken13,nora.vance@outlook.example,DemoMail!13',
  '2,61560388120456,DemoOnly!14,KRSXG5CTMVRXEZLU,"c_user=61560388120456; xs=demo",EAADemoToken14,d.ferris@hotmail.example,DemoMail!14',
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
            'fpToken',
            'fpNotes',
          ].map((k) => (
            <span key={k}>{k === '#' ? '#' : t(k)}</span>
          ))}
        </div>
        <div className="fp-field">
          <span className="fp-row fp-between">
            <label htmlFor="fp-import-rows">{t('fpRows')}</label>
            <span className="fp-row">
              <button type="button" className="btn ghost sm" onClick={() => setText(EXAMPLES)}>
                {t('fpExamples')}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setText(CSV_EXAMPLE)}>
                {t('fpExamplesCsv')}
              </button>
            </span>
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
