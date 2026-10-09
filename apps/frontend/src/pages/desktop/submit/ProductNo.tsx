import { useT } from '../../../lib/i18n';

// A PO product's # in a table cell: the one the server gave it, or *new* until
// the line is saved and gets one.
export function ProductNo({ no }: { no?: number | null }) {
  const { t } = useT();
  if (no != null) return <>{no}</>;
  return (
    <span className="chip muted" style={{ fontSize: 10, padding: '1px 6px' }} title={t('lineNoNewTitle')}>
      {t('lineNoNew')}
    </span>
  );
}
