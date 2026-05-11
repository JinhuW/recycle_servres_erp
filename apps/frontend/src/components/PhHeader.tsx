import type { ReactNode } from 'react';

type Props = {
  title?: string;
  sub?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  scrolled?: boolean;
};

export function PhHeader({ title, sub, leading, trailing, scrolled }: Props) {
  return (
    <div className={'ph-header' + (scrolled ? ' scrolled' : '')}>
      {leading || <div style={{ width: 36 }} />}
      <div style={{ flex: 1, textAlign: 'center' }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' }}>{title}</h1>
        {sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}>{sub}</div>}
      </div>
      {trailing || <div style={{ width: 36 }} />}
    </div>
  );
}
