// Share a URL via the Web Share API, falling back to clipboard copy, with
// toast feedback. Extracted verbatim from the duplicated "share order id"
// blocks in DesktopOrders / DesktopSellOrders / Orders so behavior is
// byte-identical: AbortError from a dismissed share sheet is swallowed,
// any other share failure or a failed/absent clipboard reports the error.

type ToastKind = 'success' | 'error';

type ShareOrCopyArgs = {
  url: string;
  title: string;
  copiedMsg: string;
  failedMsg: string;
  onToast?: (msg: string, kind?: ToastKind) => void;
};

export function shareOrCopy({ url, title, copiedMsg, failedMsg, onToast }: ShareOrCopyArgs): void {
  const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
  if (typeof share === 'function') {
    share.call(navigator, { url, title }).catch((err: Error) => {
      if (err.name !== 'AbortError') onToast?.(failedMsg, 'error');
    });
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => onToast?.(copiedMsg))
      .catch(() => onToast?.(failedMsg, 'error'));
  } else {
    onToast?.(failedMsg, 'error');
  }
}
