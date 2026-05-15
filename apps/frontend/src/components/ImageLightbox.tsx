import { useEffect } from 'react';
import { Icon } from './Icon';

type Props = {
  url: string;
  alt?: string;
  onClose: () => void;
};

// Full-screen read-only image viewer. Sits above the desktop LineDrawer
// (z-index 80) and the mobile shell. Close via X button, backdrop click, or Esc.
export function ImageLightbox({ url, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <button
        onClick={onClose}
        title="Close"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: 'none',
          background: 'rgba(255,255,255,0.16)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size={18} />
      </button>
      <img
        src={url}
        alt={alt ?? 'AI scan'}
        onClick={(e) => e.stopPropagation()}
        onError={onClose}
        style={{
          maxWidth: '92vw',
          maxHeight: '92vh',
          objectFit: 'contain',
          borderRadius: 8,
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
}
