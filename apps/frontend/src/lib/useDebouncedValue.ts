import { useEffect, useState } from 'react';

// The value as it stood once it stopped changing for `delayMs`. The first
// render returns the initial value at once, so a persisted search term still
// loads its list without waiting.
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
