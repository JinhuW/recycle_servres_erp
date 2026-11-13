import type { FbChatMessageSource } from '@recycle-erp/shared';

// The three places a reply can be typed, and the send arrow. The shared icon
// set has none of them and nothing else in the app needs them.

const box = { viewBox: '0 0 24 24', 'aria-hidden': true } as const;

export function ChatTelegramIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...box} width={size} height={size} fill="currentColor">
      <path d="M21.9 4.3 18.7 19.6c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.4l-4.7-1.5c-1-.3-1-1 .2-1.5L20.4 3.3c.9-.3 1.6.2 1.5 1z" />
    </svg>
  );
}

export function ChatErpIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...box} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.4}>
      <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function ChatMessengerIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...box} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M12 3C6.8 3 3 6.7 3 11.3c0 2.5 1.1 4.6 3 6.1V21l3-1.7c.9.3 1.9.4 3 .4 5.2 0 9-3.7 9-8.3S17.2 3 12 3z" />
    </svg>
  );
}

export function ChatSendIcon() {
  return (
    <svg {...box} width={16} height={16} fill="currentColor">
      <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
    </svg>
  );
}

export function ChatSourceIcon({ source }: { source: FbChatMessageSource }) {
  if (source === 'telegram') return <ChatTelegramIcon />;
  if (source === 'erp') return <ChatErpIcon />;
  return <ChatMessengerIcon />;
}
