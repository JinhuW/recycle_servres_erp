// What a purchaser changed after submitting their PO, shown to the manager who
// opens it next. Acknowledging clears it for every manager — the point is that
// somebody looked, not that everybody did — and the next edit arms it again.

import { useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { fmtUSD, relTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { changeLine, LIFECYCLE_LABEL } from '../lib/orderPresentation';
import type { PendingRevert, RevertLineSnapshot } from '../lib/types';

type Props = {
  orderId: string;
  changes: PendingRevert[];
  onAcknowledged: () => void;
  // Dismissing without acknowledging leaves the changes pending, so the dialog
  // is back on the next visit.
  onDismiss: () => void;
};

export function RevertNoticeDialog({ orderId, changes, onAcknowledged, onDismiss }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [busy, setBusy] = useState(false);

  const acknowledge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/orders/${orderId}/revert-ack`, {});
      onAcknowledged();
    } catch {
      // The dialog is a courtesy, not a gate: a failed ack just means the next
      // manager still sees it.
      setBusy(false);
      onDismiss();
    }
  };

  const lineLabel = (l: RevertLineSnapshot) =>
    [l.partNumber || '—', t('revertLineQty', { qty: l.qty, cost: fmtUSD(l.unitCost, locale) })].join(' · ');

  const section = (title: string, items: string[]) => items.length > 0 && (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-subtle)', marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2 }}>
        {items.map((s, i) => <li key={i} style={{ fontSize: 13 }}>{s}</li>)}
      </ul>
    </div>
  );

  return (
    <Modal onClose={onDismiss} shellStyle={{ maxWidth: 560, width: 'calc(100vw - 80px)' }} ariaLabel={t('revertNoticeTitle')}>
      <div style={{
        padding: '18px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'flex-start', gap: 14,
      }}>
        <span className="chip warn" style={{
          width: 38, height: 38, padding: 0, borderRadius: 10,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon name="rotate" size={18} />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>{t('revertNoticeTitle')}</div>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 2 }}>
            {t('revertNoticeSub', { name: changes[0]?.actor?.name ?? '—' })}
          </div>
        </div>
        <button className="btn icon sm" onClick={onDismiss} title={t('cancel')}>
          <Icon name="x" size={13} />
        </button>
      </div>

      <div style={{ padding: 24, display: 'grid', gap: 20, maxHeight: '60vh', overflowY: 'auto' }}>
        {changes.map(ch => {
          const d = ch.detail;
          const fields = (d.fields ?? []).map(c => changeLine(c, locale));
          const added = (d.lines?.added ?? []).map(lineLabel);
          const removed = (d.lines?.removed ?? []).map(lineLabel);
          const edited = (d.lines?.edited ?? []).flatMap(l =>
            l.changes.map(c => `${l.partNumber || '—'} · ${changeLine(c, locale)}`));
          const empty = !fields.length && !added.length && !removed.length && !edited.length;
          return (
            <div key={ch.id} style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', gap: 8 }}>
                <span>{relTime(ch.createdAt)}</span>
                {d.from && <span className="chip" style={{ fontSize: 11 }}>
                  {LIFECYCLE_LABEL[d.from] ?? d.from} → {LIFECYCLE_LABEL.draft}
                </span>}
              </div>
              {section(t('revertFieldsChanged'), fields)}
              {section(t('revertLinesEdited'), edited)}
              {section(t('revertLinesAdded'), added)}
              {section(t('revertLinesRemoved'), removed)}
              {empty && <div style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>{t('revertNoDetail')}</div>}
            </div>
          );
        })}
      </div>

      <div style={{
        padding: '14px 24px', borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <button className="btn primary" onClick={acknowledge} disabled={busy}>
          {t('revertNoticeAck')}
        </button>
      </div>
    </Modal>
  );
}
