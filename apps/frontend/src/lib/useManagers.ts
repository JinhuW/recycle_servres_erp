import { useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';

// Minimal slice of GET /api/members — a picker only needs id + name.
export type MemberOption = {
  id: string;
  name: string;
};

// The managers, for the pickers that may only name one: a sell order's
// receiver, an after-sales assignee. The backend refuses anyone else.
export function useManagerOptions(): MemberOption[] {
  const [managers, setManagers] = useState<MemberOption[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ items: (MemberOption & { role: string })[] }>('/api/members')
      .then(r => { if (alive) setManagers(r.items.filter(m => m.role === 'manager').map(m => ({ id: m.id, name: m.name }))); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);
  return managers;
}

// Everyone who has been a member, deactivated ones included, for reading back
// a name a record already holds: a payer may be a purchaser, or a manager who
// has since left. Manager-only, as /api/members is.
export function useMemberNames(): MemberOption[] {
  const [members, setMembers] = useState<MemberOption[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ items: MemberOption[] }>('/api/members?includeInactive=true')
      .then(r => { if (alive) setMembers(r.items.map(m => ({ id: m.id, name: m.name }))); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);
  return members;
}
