import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { useEscapeKey } from '../lib/useEscapeKey';

type ModalProps = {
  onClose: () => void;
  children: ReactNode;
  // Inline style passed through to the .modal-shell panel (e.g. maxWidth) so
  // callers keep their existing sizing without new CSS.
  shellStyle?: CSSProperties;
  shellClassName?: string;
  // Optional aria-label for the dialog when there is no visible labelled title.
  ariaLabel?: string;
  // Off while something is stacked above this dialog (an image lightbox), which
  // registers its own window-level Escape handler. Both would otherwise fire on
  // one press and close the dialog along with the layer on top of it.
  closeOnEscape?: boolean;
};

// Accessible modal wrapper: backdrop + panel using the existing
// .modal-backdrop / .modal-shell classes so visual output is unchanged.
// Adds role="dialog" aria-modal, moves initial focus to the panel, returns
// focus to the previously-focused element on unmount, closes on Escape
// (via the shared useEscapeKey hook) and on backdrop click.
export function Modal({ onClose, children, shellStyle, shellClassName, ariaLabel, closeOnEscape = true }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEscapeKey(onClose, closeOnEscape);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className={shellClassName ? `modal-shell ${shellClassName}` : 'modal-shell'}
        style={shellStyle}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
