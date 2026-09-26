import type { AriaAttributes, CSSProperties, ReactNode } from 'react';

type Props = AriaAttributes & {
  /** Tapping outside the sheet. A sheet mid-save passes a no-op-while-busy. */
  onBackdrop: () => void;
  /** Extra classes after `ph-sheet`. */
  className?: string;
  style?: CSSProperties;
  role?: string;
  children?: ReactNode;
};

/** The phone shell's bottom sheet: backdrop, sheet and grabber. */
export function PhSheet({ onBackdrop, className, style, children, ...aria }: Props) {
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onBackdrop} />
      <div className={'ph-sheet' + (className ? ' ' + className : '')} style={style} {...aria}>
        <div className="ph-sheet-grabber" />
        {children}
      </div>
    </>
  );
}
