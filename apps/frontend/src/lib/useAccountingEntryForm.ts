import { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_TARGET, type AccountingDirection, type AccountingKind } from '@recycle-erp/shared';
import { useAuth } from './auth';
import { MAX_UPLOAD_BYTES } from './api';
import { handleFetchError, showWarnToast } from './errorToast';
import { useT } from './i18n';
import { fetchRateToUsd } from './fxRate';
import { useDebouncedValue } from './useDebouncedValue';
import { useMembers } from './useManagers';
import { payerChoices } from './poFacets';
import {
  acctCreate, acctPatch, acctTargets, acctUploadAttachment, acctReadReceipt, localToday,
  type AcctEntryDetail, type AcctTarget, type ReceiptAmount,
} from './accounting';
import {
  applyKind, convertAmount, initialForm, orderAmount, payerLock, pickTarget, previewCny, toRequestBody,
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
  const { t } = useT();
  const { user } = useAuth();
  const members = useMembers();
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
  // Screenshots picked before the entry exists: they go up once it does.
  // An edit has none — the entry's own page manages its screenshots live.
  const [files, setFiles] = useState<File[]>([]);
  const liveFiles = useRef(new Set<File>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [readings, setReadings] = useState<{ file: File; receipt: ReceiptAmount }[]>([]);
  const [reading, setReading] = useState(0);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const receiptFile = useRef<File | null>(null);

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
    if (rate !== null) return;
    let alive = true;
    fetchRateToUsd('CNY').then(i => { if (alive) setRate(i.oneUsdInQuote); }).catch(() => {});
    return () => { alive = false; };
  }, [rate]);

  const suggested = orderAmount(form, rate);
  useEffect(() => {
    if (entry || form.amountSource !== 'order') return;
    const amount = suggested != null && suggested > 0 ? suggested.toFixed(2) : '';
    setForm(f => f.amountSource !== 'order' || f.amount === amount ? f : { ...f, amount });
  }, [entry, suggested, form.amountSource]);

  // The people Paid by may name, the PO pages' own list: the active
  // managers; on a cost, the PO's purchaser, who may have paid it out of
  // pocket; and whoever the entry is booked to, though no longer listed.
  const owner = form.kind === 'purchase' ? form.target?.owner ?? null : null;
  const managers = useMemo(() => payerChoices(members, owner, entry?.manager ?? null), [members, owner, entry]);

  // A preset can name a manager who is no longer active (one still holding a
  // balance, a sale's receiver since deactivated). The select can't show them
  // and the save would be refused, so a new entry falls back to whoever is
  // recording it.
  const meId = user?.id ?? '';
  useEffect(() => {
    if (entry || members.length === 0 || form.managerId === meId) return;
    if (!managers.some(m => m.id === form.managerId)) setForm(f => ({ ...f, managerId: meId }));
  }, [entry, members, managers, form.managerId, meId]);

  const edit = (next: (f: EntryForm) => EntryForm) => { setForm(next); setError(null); };
  // An entry whose record was deleted keeps its kind with no link.
  const orphan = !!entry && !entry.target && form.kind === entry.kind;

  const submit = async () => {
    if (busy || reading > 0) return;
    const r = toRequestBody(form, { orphan, entry });
    if ('error' in r) { setError(r.error); return; }
    setBusy(true);
    try {
      if (entry) {
        const res = await acctPatch(entry.id, r.body);
        onSaved({ id: entry.id, created: false, commissionPaidBy: res.commissionPaidBy });
      } else {
        const res = await acctCreate(r.body);
        // One at a time, in the order picked. The entry stands either way: a
        // screenshot that didn't go up is added again from the entry.
        let failed = 0;
        for (const file of files) await acctUploadAttachment(res.id, file).catch(() => { failed++; });
        if (failed) showWarnToast(t('acctScreenshotsFailed', { id: res.id, n: failed }));
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
    reading: reading > 0, scanNotice, readings, suggested,
    selectedReceiptFile: form.amountSource === 'receipt' ? receiptFile.current : null,
    useOrderAmount: () => edit(f => {
      const amount = orderAmount(f, rate);
      return { ...f, amountSource: 'order', amount: amount != null && amount > 0 ? amount.toFixed(2) : '' };
    }),
    useReceipt: (file: File, receipt: ReceiptAmount) => {
      if (!receipt.currency) return;
      receiptFile.current = file;
      edit(f => ({ ...f, amount: receipt.amount, currency: receipt.currency!, fxRate: '', amountSource: 'receipt' }));
    },
    setCurrency: (currency: EntryForm['currency']) => {
      const converted = form.amount ? convertAmount(Number(form.amount), form.currency, currency, form.fxRate ? Number(form.fxRate) : rate) : null;
      if (form.amount && converted === null) { setError('acctErrRate'); return; }
      edit(f => ({ ...f, currency, amount: converted === null ? '' : converted.toFixed(2) }));
    },
    preview: previewCny(form, rate),
    editing: !!entry,
    // A PO the Business Account paid takes no paid-out RMB entry: the form says so.
    payerLocked: payerLock(form, entry),
    // The payer select stays open while putting the entry's own payer back
    // would lift the lock, so a changed payer can be changed back.
    payerPickLocked: payerLock({ ...form, managerId: entry?.manager.id ?? form.managerId }, entry),
    // A manager picked by hand stays put when the record changes.
    set: (patch: Partial<EntryForm>) => edit(f => ({ ...f, ...patch, ...(patch.managerId !== undefined ? { managerTouched: true } : {}), ...(patch.amount !== undefined ? { amountSource: 'manual' as const } : {}) })),
    setKind: (k: AccountingKind) => edit(f => applyKind(f, k)),
    setDirection: (d: AccountingDirection) => edit(f => ({ ...f, direction: d, directionTouched: true })),
    setCounterparty: (v: string) => edit(f => ({ ...f, counterparty: v, counterpartyTouched: true })),
    choose: (t: FormTarget | null) => { edit(f => pickTarget(f, t)); setQuery(''); },
    setQuery,
    files,
    addFiles: (list: FileList | File[] | null) => {
      const picked = [...(list ?? [])].filter(f => f.type.startsWith('image/') || f.type === 'application/pdf');
      const accepted = picked.filter(f => f.size <= MAX_UPLOAD_BYTES);
      if (accepted.length < picked.length) showWarnToast(t('fileTooLarge', { name: picked.find(f => f.size > MAX_UPLOAD_BYTES)!.name }));
      if (!accepted.length) return;
      accepted.forEach(file => liveFiles.current.add(file));
      setFiles(fs => [...fs, ...accepted]);
      const images = accepted.filter(file => file.type.startsWith('image/'));
      setReading(n => n + images.length);
      setScanNotice(null);
      void (async () => {
        for (const file of images) {
          try {
            const { receipt } = await acctReadReceipt(file);
            if (!mounted.current || !liveFiles.current.has(file)) continue;
            if (!receipt) { setScanNotice(t('acctReceiptUnreadable')); continue; }
            setReadings(rs => [...rs, { file, receipt }]);
            if (receipt.currency) {
              setForm(f => {
                if (f.amountSource !== 'order') return f;
                receiptFile.current = file;
                return { ...f, amount: receipt.amount, currency: receipt.currency!, fxRate: '', amountSource: 'receipt' };
              });
            } else setScanNotice(t('acctReceiptCurrencyUnknown'));
          } catch {
            if (mounted.current && liveFiles.current.has(file)) setScanNotice(t('acctReceiptUnreadable'));
          } finally {
            if (mounted.current) setReading(n => n - 1);
          }
        }
      })();
    },
    removeFile: (i: number) => {
      const file = files[i];
      liveFiles.current.delete(file);
      setFiles(fs => fs.filter(f => f !== file));
      setReadings(rs => rs.filter(r => r.file !== file));
      if (receiptFile.current === file) {
        receiptFile.current = null;
        edit(f => {
          if (f.amountSource !== 'receipt') return f;
          const amount = orderAmount(f, rate);
          return { ...f, amountSource: 'order', amount: amount != null && amount > 0 ? amount.toFixed(2) : '' };
        });
      }
    },
    submit,
  };
}

export type AccountingEntryForm = ReturnType<typeof useAccountingEntryForm>;
