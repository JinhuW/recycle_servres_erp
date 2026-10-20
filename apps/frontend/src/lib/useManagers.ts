import { useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';

// Minimal slice of GET /api/members — a picker only needs id + name.
export type MemberOption = {
  id: string;
  name: string;
};

// The managers, for the pickers that may only name one: a sell order's
// receiver, an after-sales assignee, a commission's payer. The backend refuses
// anyone else. `enabled` is off for a page a purchaser shares, since the
// members list is a manager's to read.
export function useManagerOptions(enabled = true): MemberOption[] {
  const [managers, setManagers] = useState<MemberOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.get<{ items: (MemberOption & { role: string })[] }>('/api/members')
      .then(r => { if (alive) setManagers(r.items.filter(m => m.role === 'manager').map(m => ({ id: m.id, name: m.name }))); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [enabled]);
  return managers;
}
