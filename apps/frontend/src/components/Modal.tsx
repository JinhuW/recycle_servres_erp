import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
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
  // Off only while the dialog should ignore Escape entirely. A busy dialog
  // keeps it on and guards inside onClose instead, so the press is swallowed
  // rather than falling through to the layer underneath.
  closeOnEscape?: boolean;
};

// Accessible modal wrapper: backdrop + panel using the existing
// .modal-backdrop / .modal-shell classes so visual output is unchanged.
// Adds role="dialog" aria-modal, moves initial focus to the panel unless a
// child already took it, returns focus to the opener on unmount, closes on
// Escape (via the shared useEscapeKey stack) and on backdrop click.
export function Modal({ onClose, children, shellStyle, shellClassName, ariaLabel, closeOnEscape = true }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where the press began. A drag that starts inside the panel (selecting text
  // in a field) and is released over the backdrop fires its click on the
  // backdrop, and closed the dialog with whatever was typed in it.
  const pressedBackdrop = useRef(false);

  useEscapeKey(onClose, closeOnEscape);

  // Read during the first render, not in the effect: by the time effects run,
  // a child's `autoFocus` has already moved focus, and the opener is lost.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const panel = panelRef.current;
    // Taking focus back from an autofocused input would leave the user unable
    // to type into the field the dialog opened for.
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      // A dialog opened from a row that has since re-rendered away must not
      // send focus to a detached node, which drops it to <body> anyway.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
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
