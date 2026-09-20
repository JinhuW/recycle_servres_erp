import type { ReactNode } from 'react';
import { useT } from '../../../lib/i18n';

// The PO page's five sections, one fact each: everything about a thing lives
// under its tab and nowhere else. Every panel stays mounted (hidden, not
// unmounted) so an input keeps its DOM node — and its focus — while readiness
// recomputes around it.

export type TabId = 'delivery' | 'payment' | 'commission' | 'notes' | 'activity';
export const TAB_IDS: TabId[] = ['delivery', 'payment', 'commission', 'notes', 'activity'];

const LABEL_KEY: Record<TabId, string> = {
  delivery: 'eoTabDelivery',
  payment: 'eoTabPayment',
  commission: 'eoTabCommission',
  notes: 'eoTabNotes',
  activity: 'eoTabActivity',
};

type Props = {
  tab: TabId;
  onTab: (t: TabId) => void;
  counts?: Partial<Record<TabId, number>>;
  /** Amber: the Draft still needs something under this tab. */
  need: Partial<Record<TabId, boolean>>;
  /** Blue: this tab has unsaved edits. Wins over amber. */
  dirty: Partial<Record<TabId, boolean>>;
  children: Record<TabId, ReactNode>;
};

export function OrderTabs({ tab, onTab, counts, need, dirty, children }: Props) {
  const { t } = useT();
  return (
    <>
      <div className="oe-tabs" role="tablist">
        {TAB_IDS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            id={'oe-tab-' + id}
            aria-selected={tab === id}
            aria-controls={'oe-tabpanel-' + id}
            className={'oe-tab' + (tab === id ? ' active' : '')}
            onClick={() => onTab(id)}
          >
            {t(LABEL_KEY[id])}
            {counts?.[id] != null && <span className="oe-tab-count mono">{counts[id]}</span>}
            {dirty[id]
              ? <span className="oe-tab-dot blue" title={t('eoTabDirty')} />
              : need[id] ? <span className="oe-tab-dot amber" title={t('eoTabNeeded')} /> : null}
          </button>
        ))}
      </div>
      <div className="card oe-tabbody">
        {TAB_IDS.map(id => (
          <div
            key={id}
            role="tabpanel"
            id={'oe-tabpanel-' + id}
            aria-labelledby={'oe-tab-' + id}
            className="oe-tabpanel"
            hidden={tab !== id}
          >
            {children[id]}
          </div>
        ))}
      </div>
    </>
  );
}
