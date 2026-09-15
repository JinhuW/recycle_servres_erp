import type { CSSProperties, ReactNode } from 'react';
import { hrefFor, onLinkClick } from '../lib/route';

type Props = {
  to: string;
  // Runs on a plain click only — a ⌘-click opens elsewhere and must leave
  // this page untouched.
  onNavigate?: () => void;
  className?: string;
  title?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  children: ReactNode;
};

// The in-app link: a real anchor, so the browser's own affordances (new tab,
// copy address, middle-click) work, with a plain click still routed through
// navigate(). No `onClick` prop on purpose — nothing may replace the handler.
export function RouteLink({ to, onNavigate, ...rest }: Props) {
  return <a href={hrefFor(to)} onClick={onLinkClick(to, onNavigate)} {...rest} />;
}

// A translated sentence with the record id linked. `template` is the raw
// i18n string, still holding its `{id}` placeholder (call t() without vars),
// so both languages keep one key and the parity test keeps its placeholder
// check.
export function linkedSentence(template: string, id: string, to: string, className = 'mono rec-link') {
  const [before, after] = template.split('{id}');
  return (
    <>
      {before}
      <RouteLink to={to} className={className}>{id}</RouteLink>
      {after}
    </>
  );
}
