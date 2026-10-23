import { useEffect, useMemo, useState } from 'react';
import { KIND_TARGET, type AccountingDirection, type AccountingKind } from '@recycle-erp/shared';
import { useAuth } from './auth';
import { handleFetchError } from './errorToast';
import { fetchRateToUsd } from './fxRate';
import { useDebouncedValue } from './useDebouncedValue';
import { useManagerOptions } from './useManagers';
import {
  acctCreate, acctPatch, acctTargets, localToday,
  type AcctEntryDetail, type AcctTarget,
} from './accounting';
import {
  applyKind, initialForm, payerLock, pickTarget, previewCny, toRequestBody,
  type EntryForm, type EntryPreset, type FormError, type FormTarget,
} from './accountingForm';
import type { PaidBy } from './useCommissionPaidBy';

export type SavedEntry = { id: string; created: boolean; commissionPaidBy?: PaidBy };

// Everything the record form does, for the desktop dialog and the phone sheet
// alike; each shell only lays it out.
export function useAccountingEntryForm(opts: {
  preset?: EntryPreset; entry?: AcctEntryDetail; onSaved: (r: SavedEntry) => void;
}) {
  const { preset, entry, onSaved } = opts;
  const { user } = useAuth();
  const managerOptions = useManagerOptions();
  const today = useMemo(() => localToday(), []);
  const [form, setForm] = useState<EntryForm>(() => {
    const f = initialForm({ meId: user?.id ?? '', today, preset, entry });
    return entry?.targetFacts ? { ...f, target: entry.targetFacts } : f;
  });
  const [error, setError] = useState<FormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const settledQuery = useDebouncedValue(query, 200);
  const [candidates, setCandidates] = useState<AcctTarget[] | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  const targetType = KIND_TARGET[form.kind];
  const searching = !!targetType && !form.targetLocked;
  useEffect(() => {
    if (!searching) { setCandidates(null); return; }
    let alive = true;
    acctTargets(form.kind, settledQuery.trim())
      .then(r => { if (alive) setCandidates(r.candidates); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [searching, form.kind, settledQuery]);

  // The rate is only a hint until the entry is saved, so a miss stays quiet.
  useEffect(() => {
    if (form.currency !== 'USD' || rate !== null) return;
    let alive = true;
    fetchRateToUsd('CNY').then(i => { if (alive) setRate(i.oneUsdInQuote); }).catch(() => {});
    return () => { alive = false; };
  }, [form.currency, rate]);

  // The people Paid by may name: the active managers; a manager no longer
  // active still has to show on an entry booked to them; and a cost may
  // name the PO's own purchaser, who paid it out of pocket.
  const owner = form.kind === 'purchase' ? form.target?.owner ?? null : null;
  const managers = useMemo(() => {
    const extra = [entry?.manager ?? null, owner].filter((m): m is { id: string; name: string } =>
      !!m && !managerOptions.some(o => o.id === m.id));
    return extra.length ? [...managerOptions, ...extra] : managerOptions;
  }, [managerOptions, entry, owner]);

  // A preset can name a manager who is no longer active (one still holding a
  // balance, a sale's receiver since deactivated). The select can't show them
  // and the save would be refused, so a new entry falls back to whoever is
  // recording it.
  const meId = user?.id ?? '';
  useEffect(() => {
    if (entry || managerOptions.length === 0 || form.managerId === meId) return;
    if (!managers.some(m => m.id === form.managerId)) setForm(f => ({ ...f, managerId: meId }));
  }, [entry, managerOptions, managers, form.managerId, meId]);

  const edit = (next: (f: EntryForm) => EntryForm) => { setForm(next); setError(null); };
  // An entry whose record was deleted keeps its kind with no link.
  const orphan = !!entry && !entry.target && form.kind === entry.kind;

  const submit = async () => {
    if (busy) return;
    const r = toRequestBody(form, { orphan, entry });
    if ('error' in r) { setError(r.error); return; }
    setBusy(true);
    try {
      if (entry) {
        const res = await acctPatch(entry.id, r.body);
        onSaved({ id: entry.id, created: false, commissionPaidBy: res.commissionPaidBy });
      } else {
        const res = await acctCreate(r.body);
        onSaved({ id: res.id, created: true, commissionPaidBy: res.commissionPaidBy });
      }
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  return {
    form, error, busy, managers, rate, targetType, query, candidates, orphan,
    preview: previewCny(form, rate),
    editing: !!entry,
    // A PO the Business Account paid takes no paid-out RMB entry: the form says so.
    payerLocked: payerLock(form, entry),
    // A manager picked by hand stays put when the record changes.
    set: (patch: Partial<EntryForm>) => edit(f => ({ ...f, ...patch, ...(patch.managerId !== undefined ? { managerTouched: true } : {}) })),
    setKind: (k: AccountingKind) => edit(f => applyKind(f, k)),
    setDirection: (d: AccountingDirection) => edit(f => ({ ...f, direction: d, directionTouched: true })),
    setCounterparty: (v: string) => edit(f => ({ ...f, counterparty: v, counterpartyTouched: true })),
    choose: (t: FormTarget | null) => { edit(f => pickTarget(f, t)); setQuery(''); },
    setQuery,
    submit,
  };
}

export type AccountingEntryForm = ReturnType<typeof useAccountingEntryForm>;
