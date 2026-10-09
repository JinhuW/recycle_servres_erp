import { useT } from '../../../lib/i18n';

// A PO product's # in a table cell: the one the server gave it, or *new n*
// until the line is saved and gets one — the name messages use for it.
export function ProductNo({ no, newNo }: { no?: number | null; newNo?: number | null }) {
  const { t } = useT();
  if (no != null) return <>{no}</>;
  return (
    <span className="chip muted" style={{ fontSize: 10, padding: '1px 6px', whiteSpace: 'nowrap' }} title={t('lineNoNewTitle')}>
      {newNo != null ? t('lineNoNewN', { n: newNo }) : t('lineNoNew')}
    </span>
  );
}
