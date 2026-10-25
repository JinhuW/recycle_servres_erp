import { ramShortCode, type RamShortCodeInput } from '@recycle-erp/shared';
import { useT } from '../lib/i18n';

export function RamShortCode({ line }: { line: RamShortCodeInput }) {
  const { t } = useT();
  const code = ramShortCode(line);
  const micron = String(line.brand ?? '').trim().toLowerCase() === 'micron';
  return (
    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>
      {t('ramShortCode')}: <output className="mono" aria-label={t('ramShortCode')}>{code ?? t('ramShortCodeUnknown')}</output>
      {micron && !code && <div style={{ marginTop: 4 }}>{t('ramShortCodeMicronHint')}</div>}
    </div>
  );
}
