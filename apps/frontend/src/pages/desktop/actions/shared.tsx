import { REPORTING_TZ, actionIsOverdue, todayIn, type ActionItem, type ActionLink } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { LINK_TYPE_KEY, PRIORITY_KEY, linkPath } from '../../../lib/actions';
import { useT } from '../../../lib/i18n';
import { poStageName } from '../../../lib/orderPresentation';
import { hrefFor, onLinkClick } from '../../../lib/route';

export const actionToday = () => todayIn(REPORTING_TZ);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** A business day, read as the calendar date it names (never shifted by a time zone). */
export function fmtDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function Avatar({ name }: { name: string }) {
  return <span className="avatar sm act-avatar" title={name} aria-label={name}>{initials(name)}</span>;
}

export function PriorityChip({ item }: { item: Pick<ActionItem, 'priority'> }) {
  const { t } = useT();
  if (item.priority === 'normal') return null;
  return <span className={`chip act-pri-${item.priority}`}>{t(PRIORITY_KEY[item.priority])}</span>;
}

export function DueChip({ item, today }: { item: Pick<ActionItem, 'status' | 'dueDate'>; today: string }) {
  const { t, locale } = useT();
  if (!item.dueDate) return null;
  const overdue = actionIsOverdue(item, today);
  const isToday = item.status !== 'done' && item.dueDate === today;
  const tone = overdue ? 'neg' : isToday ? 'warn' : 'muted';
  const label = isToday ? t('actDueToday') : fmtDay(item.dueDate, locale);
  return (
    <span className={`chip ${tone} act-due`} title={overdue ? t('actOverdue') : t('actDue')}>
      <Icon name="calendar" size={11} />{label}
    </span>
  );
}

export function linkStatusText(link: ActionLink, t: (k: string) => string): string | null {
  if (link.status === undefined) return null;
  return link.type === 'po' ? poStageName(link.status, t) : link.status.replace(/_/g, ' ');
}

/**
 * The record a card points at. `asLink` makes it a link when the viewer may
 * open the record; on a card it stays plain text, since the card opens itself.
 */
export function LinkChip({ link, asLink = false }: { link: ActionLink; asLink?: boolean }) {
  const { t } = useT();
  const label = link.type === 'client' && !link.name ? t('actLink_client') : link.label;
  const status = linkStatusText(link, t);
  const body = (
    <>
      <span className="act-link-type">{t(LINK_TYPE_KEY[link.type])}</span>
      <b>{label}</b>
      {link.name && <span className="act-link-name">{link.name}</span>}
      {status && <span className="act-link-status">{status}</span>}
      {link.deleted && <span className="act-link-status">{t('actLinkDeleted')}</span>}
    </>
  );
  const path = asLink && link.canOpen ? linkPath(link) : null;
  if (path) {
    return <a className="act-link" href={hrefFor(path)} onClick={onLinkClick(path)}>{body}<Icon name="arrow" size={11} /></a>;
  }
  return <span className={`act-link${link.deleted ? ' act-link-gone' : ''}`}>{body}</span>;
}
