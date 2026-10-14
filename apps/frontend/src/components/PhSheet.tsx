import { useEffect, useRef, useState, type AriaAttributes, type CSSProperties, type ReactNode } from 'react';
import { useFocusTrap } from '../lib/useFocusTrap';

type Props = AriaAttributes & {
  /** Tapping outside the sheet. A sheet mid-save passes a no-op-while-busy. */
  onBackdrop: () => void;
  /** Extra classes after `ph-sheet`. */
  className?: string;
  style?: CSSProperties;
  role?: string;
  children?: ReactNode;
};

/** The phone shell's bottom sheet: backdrop, sheet and grabber. A dialog to
 *  the keyboard too: focus moves in on open, stays in (Tab wraps), and goes
 *  back to the opener on close. */
export function PhSheet({ onBackdrop, className, style, children, role = 'dialog', ...aria }: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useFocusTrap(sheetRef);
  useEffect(() => {
    const el = sheetRef.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onBackdrop} />
      <div
        ref={sheetRef}
        className={'ph-sheet' + (className ? ' ' + className : '')}
        style={style}
        role={role}
        aria-modal="true"
        tabIndex={-1}
        {...aria}
      >
        <div className="ph-sheet-grabber" />
        {children}
      </div>
    </>
  );
}
