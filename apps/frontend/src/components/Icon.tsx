// Inline SVG icon set lifted verbatim from data.jsx (lucide-style strokes).
// Single component so we can swap to a real lucide-react import later without
// touching every screen.

import type { CSSProperties } from 'react';

export type IconName =
  | 'dashboard' | 'submit' | 'history' | 'inventory' | 'camera'
  | 'chevronRight' | 'chevronDown' | 'chevronLeft' | 'chevronUp'
  | 'user' | 'shield' | 'logout' | 'check' | 'check2' | 'sparkles'
  | 'upload' | 'rotate' | 'trending' | 'dollar' | 'download'
  | 'filter' | 'search' | 'lock' | 'eye' | 'edit' | 'trash'
  | 'plus' | 'x' | 'arrow' | 'arrowUp' | 'arrowDown'
  | 'chip' | 'drive' | 'box' | 'warehouse' | 'medal' | 'flag'
  | 'clock' | 'info' | 'alert' | 'flash' | 'hash'
  | 'settings' | 'bell' | 'tag' | 'trendDown' | 'minus'
  | 'book' | 'star' | 'zap' | 'globe' | 'mail' | 'grip'
  | 'truck' | 'cash' | 'refresh'
  | 'paperclip' | 'file' | 'image' | 'invoice';

type Props = {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
  style?: CSSProperties;
};

const PATHS: Record<IconName, JSX.Element> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.2"/><rect x="14" y="3" width="7" height="5" rx="1.2"/><rect x="14" y="12" width="7" height="9" rx="1.2"/><rect x="3" y="16" width="7" height="5" rx="1.2"/></>,
  submit: <><path d="M12 5v14M5 12h14"/></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></>,
  inventory: <><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></>,
  camera: <><path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2z"/><circle cx="12" cy="13" r="3.5"/></>,
  chevronRight: <><path d="M9 6l6 6-6 6"/></>,
  chevronDown:  <><path d="M6 9l6 6 6-6"/></>,
  chevronLeft:  <><path d="M15 6l-6 6 6 6"/></>,
  chevronUp:    <><path d="M18 15l-6-6-6 6"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></>,
  check:  <><path d="M5 12l5 5 9-11"/></>,
  check2: <><path d="M20 6L9 17l-5-5"/></>,
  sparkles: <><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"/></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></>,
  rotate: <><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></>,
  trending: <><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></>,
  dollar: <><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6"/></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></>,
  filter: <><path d="M22 3H2l8 9v7l4 2v-9z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>,
  eye:  <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
  trash: <><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  x:    <><path d="M18 6L6 18M6 6l12 12"/></>,
  arrow:     <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  arrowUp:   <><path d="M7 17l10-10M7 7h10v10"/></>,
  arrowDown: <><path d="M7 7l10 10M17 7v10H7"/></>,
  chip:  <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 8v8M15 8v8M8 9h8M8 15h8"/><path d="M2 10h2M2 14h2M20 10h2M20 14h2M10 2v2M14 2v2M10 20v2M14 20v2"/></>,
  drive: <><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="7" cy="12" r="1.5"/><path d="M11 12h8"/></>,
  box:   <><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v9"/></>,
  warehouse: <><path d="M3 21V9l9-5 9 5v12"/><path d="M3 21h18"/><rect x="7" y="13" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/></>,
  medal: <><circle cx="12" cy="15" r="5"/><path d="M8 10L5 3h4l3 6M16 10l3-7h-4l-3 6"/></>,
  flag:  <><path d="M4 21V4l8 3 8-3v11l-8 3-8-3"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  info:  <><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></>,
  alert: <><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></>,
  flash: <><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></>,
  hash:  <><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.15.68.41.91.74"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></>,
  tag:  <><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.2"/></>,
  trendDown: <><path d="M3 7l6 6 4-4 8 8"/><path d="M14 17h7v-7"/></>,
  minus: <><path d="M5 12h14"/></>,
  book:  <><path d="M4 4a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2z"/><path d="M4 22h14"/></>,
  star:  <><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></>,
  zap:   <><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></>,
  mail:  <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></>,
  grip:  <><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></>,
  truck: <><path d="M2 17V6h11v11"/><path d="M13 9h5l3 4v4h-8"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>,
  cash:  <><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10v.01M18 14v.01"/></>,
  refresh: <><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 12a9 9 0 0 1 15.5-6.3"/><path d="M21 4v5h-5"/><path d="M3 20v-5h5"/></>,
  paperclip: <><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></>,
  file:  <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 15l-5-5L5 21"/></>,
  invoice: <><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></>,
};

export function Icon({ name, size = 16, stroke = 1.75, className = '', style }: Props) {
  const s = { width: size, height: size, ...style };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={s}
      className={'icon ' + className}
    >
      {PATHS[name]}
    </svg>
  );
}
