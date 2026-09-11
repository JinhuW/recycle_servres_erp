// The sell orders an archive would pull lines off, as both shells' archive
// dialogs show them once POST /archive answers with a committedLines 409. The
// dialog shell, buttons and state stay per shell; only this body is shared.

import { useT } from '../lib/i18n';
import { statusTone } from '../lib/status';
import type { ArchiveConflict } from '../lib/archiveConflict';

export function ArchiveConflictList({ conflict }: { conflict: ArchiveConflict }) {
  const { t } = useT();
  return (
    <>
      {conflict.sellOrders.map(so => (
        <div key={so.id} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontWeight: 600 }}>{so.id}</span>
            <span className={'chip ' + statusTone(so.status)} style={{ fontSize: 10.5 }}>{so.status}</span>
            {so.emptied && (
              <span style={{ color: 'var(--neg)' }}>{t('archiveConflictEmptied')}</span>
            )}
          </div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 18, color: 'var(--fg-muted)' }}>
            {so.lines.map(l => (
              <li key={l.solId}>{l.label || l.inventoryId.slice(0, 8)} · {t('qtyShort', { n: String(l.qty) })}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
