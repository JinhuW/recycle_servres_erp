import { useEffect, useState } from 'react';

// The text Review and Pack mode filter their list by: the scan box once typing
// pauses for `delayMs`. A scanner's burst ends in Enter well inside the wait,
// so a scan never flashes a filter. The settled text is dropped the moment
// the box empties, and ignored once the box holds something it isn't a prefix
// or extension of — so a scan started right after a search, or one that
// replaces leftover text, doesn't flash the old filter either.
export function useScanFilterText(scan: string, delayMs = 150): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (!scan) {
      setSettled('');
      return;
    }
    const timer = setTimeout(() => setSettled(scan), delayMs);
    return () => clearTimeout(timer);
  }, [scan, delayMs]);
  const related = scan.startsWith(settled) || settled.startsWith(scan);
  return scan && related ? settled.trim() : '';
}
