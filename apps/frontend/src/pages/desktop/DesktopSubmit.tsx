import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { AttachmentChip } from '../../components/AttachmentChip';
import { useT } from '../../lib/i18n';
import { api, createDraftOrder, deleteOrder } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { Category, ScanResponse, Warehouse, OrderSummary } from '../../lib/types';
import { LineDrawer } from './submit/LineDrawer';
import { eligibleDraftTargets } from './submit/eligibleTargets';
import { useAuth } from '../../lib/auth';
import { synthesizePartNumber } from '@recycle-erp/shared';

// ─── Public component ────────────────────────────────────────────────────────
// Two-step submit flow lifted from design/submit.jsx + design/app.jsx#SubmitView:
//   1. Category picker (RAM / SSD / Other) — chunky cards, AI-capture tag on RAM
//   2. OrderForm — line-item table + right-side drawer for editing one line,
//      plus a sticky bottom card with order meta + totals + submit action.
//
// RAM lines get an AI label drop zone at the top of the right-side drawer
// (LineDrawer): drop or click a photo, the scan patches the current line.

type Props = {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
};

export function DesktopSubmit({ onDone }: Props) {
  const { t } = useT();
  const [cat, setCat] = useState<Category | null>(null);

  if (!cat) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('submitNewOrder')}</h1>
            <div className="page-sub">{t('submitNewOrderSub')}</div>
          </div>
        </div>

        <div style={{ maxWidth: 720, margin: '24px auto 0' }}>
          <div style={{
            fontSize: 11, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
          }}>
            {t('chooseItemType')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {([
              { id: 'RAM',   icon: 'chip',  sub: t('ramSub'),   tag: t('aiLabelCapture') },
              { id: 'SSD',   icon: 'drive', sub: t('ssdSub'),   tag: t('manualEntry') },
              { id: 'HDD',   icon: 'drive', sub: t('hddSub'),   tag: t('manualEntry') },
              { id: 'Other', icon: 'box',   sub: t('otherSub'), tag: t('manualEntry') },
            ] as const).map(c => (
              <button
                key={c.id}
                onClick={() => setCat(c.id as Category)}
                className="card"
                style={{
                  padding: 22, display: 'flex', flexDirection: 'column',
                  alignItems: 'flex-start', gap: 14,
                  background: 'var(--bg-elev)', cursor: 'pointer',
                  textAlign: 'left', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  transition: 'transform 0.12s, border-color 0.12s, box-shadow 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(15,23,42,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                  display: 'grid', placeItems: 'center',
                }}>
                  <Icon name={c.icon} size={22} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }}>{c.id}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{c.sub}</div>
                </div>
                <span className={'chip ' + (c.id === 'RAM' ? 'pos' : '')} style={{ fontSize: 10 }}>
                  {c.id === 'RAM' && <Icon name="sparkles" size={9} />} {c.tag}
                </span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 18, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'center' }}>
            {t('multipleLineItems')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('submitNewCatOrder', { cat })}</h1>
          <div className="page-sub">
            {t('submitNewCatOrderSub', { cat })}{' '}
            <button
              onClick={() => setCat(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--accent-strong)', padding: 0,
                fontSize: 'inherit', textDecoration: 'underline',
                fontFamily: 'inherit',
              }}
            >
              {t('changeItemType')}
            </button>
          </div>
        </div>
      </div>

      <OrderForm
        key={cat}
        category={cat}
        onCancel={() => setCat(null)}
        onDone={onDone}
      />
    </>
  );
}

// ─── OrderForm ───────────────────────────────────────────────────────────────
// Exported so DesktopEditOrder can reuse the same line-drawer pattern (table
// row → right-side drawer with full per-category fields) without duplicating
// the components.
export type Line = {
  category: Category;
  brand?: string;
  capacity?: string;
  generation?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
  interface?: string;
  formFactor?: string;
  description?: string;
  partNumber?: string;
  serialNumber?: string;
  condition: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string;
  health?: number | null;
  rpm?: number | null;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
  _confirmed?: boolean;
  _cid: string;                  // stable client id for React keys (never sent to the API)
};

type OrderMeta = {
  warehouseId: string;
  payment: 'Company' | 'Self';
  notes: string;
  totalCostOverride: string | null;
};


export function blankLine(cat: Category): Line {
  return {
    _cid: crypto.randomUUID(),
    category: cat, qty: '', unitCost: '',
    condition: '',
    scanImageUrl: null,
  };
}

export type DuplicatePartGroup = { partNumber: string; lineNums: number[] };

// Two lines sharing a part number on the same PO is almost always a paste-error
// or a forgotten-already-added — surface it so the user can merge or confirm.
// Comparison is case-insensitive and trims whitespace; blanks are ignored. The
// returned `partNumber` carries the first-seen casing for display.
export function findDuplicatePartNumbers(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
): DuplicatePartGroup[] {
  const groups = new Map<string, DuplicatePartGroup>();
  lines.forEach((l, i) => {
    const raw = (l.partNumber ?? '').trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    const g = groups.get(key);
    if (g) g.lineNums.push(i + 1);
    else groups.set(key, { partNumber: raw, lineNums: [i + 1] });
  });
  return [...groups.values()].filter(g => g.lineNums.length >= 2);
}

// Build a Line patch from an AI scan response — mirrors the mobile aiDefaults
// in SubmitForm.tsx so all flows share the same field-mapping. Returned as a
// Partial so callers can either spread it onto blankLine() (new line) or pass
// it through onChange() (live edit in the drawer).
// Low-confidence extractions are still prefilled (a rough draft beats an empty
// form); scanConfidence rides along so the drawer can flag it for review.
export function scanToLinePatch(scan: ScanResponse): Partial<Line> {
  const f = scan.extracted ?? {};
  return {
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
    scanImageUrl: scan.deliveryUrl ?? null,
    ...(f.brand        ? { brand: f.brand }               : {}),
    ...(f.capacity     ? { capacity: f.capacity }         : {}),
    ...(f.generation   ? { generation: f.generation }     : {}),
    ...(f.type         ? { type: f.type }                 : {}),
    ...(f.classification ? { classification: f.classification } : {}),
    ...(f.rank         ? { rank: f.rank }                 : {}),
    ...(f.speed        ? { speed: f.speed }               : {}),
    ...(f.interface    ? { interface: f.interface }       : {}),
    ...(f.formFactor   ? { formFactor: f.formFactor }     : {}),
    ...(f.description  ? { description: f.description }   : {}),
    ...(f.partNumber   ? { partNumber: f.partNumber }     : {}),
  };
}

function OrderForm({
  category,
  onCancel,
  onDone,
}: {
  category: Category;
  onCancel: () => void;
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
}) {
  const { t, lang } = useT();
  const { user } = useAuth();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => setWarehouses(r.items))
      .catch(handleFetchError);
  }, []);

  const [lines, setLines] = useState<Line[]>([blankLine(category)]);
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [meta, setMeta] = useState<OrderMeta>({
    warehouseId: '',
    payment: 'Company',
    notes: '',
    totalCostOverride: null,
  });

  // Order-level error banner — populated by submit/confirm failures and the
  // draft-creation guard below. AI scan failures live inside the LineDrawer,
  // alongside the dropzone that produces them.
  const [aiError, setAiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Submission evidence is buffered locally, not uploaded live: the merge path
  // deletes the throwaway draft, so the only stable target id is known after
  // submit succeeds. Upload runs against that final id (see uploadEvidence).
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [evidenceDragOver, setEvidenceDragOver] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement | null>(null);

  // One object URL per File, created lazily and revoked only on unmount — so
  // removing one file never revokes a URL still in use by another's preview.
  const evidenceUrlsRef = useRef<Map<File, string>>(new Map());
  const evidencePreviews = evidenceFiles.map(f => {
    let url = evidenceUrlsRef.current.get(f);
    if (!url) { url = URL.createObjectURL(f); evidenceUrlsRef.current.set(f, url); }
    return { file: f, url };
  });
  useEffect(() => () => {
    for (const url of evidenceUrlsRef.current.values()) URL.revokeObjectURL(url);
    evidenceUrlsRef.current.clear();
  }, []);

  const addEvidenceFiles = (fl: FileList | null) => {
    const picked = Array.from(fl || []).filter(f => {
      if (f.size > 10 * 1024 * 1024) { setAiError(t('fileTooLarge', { name: f.name })); return false; }
      return true;
    });
    if (picked.length) setEvidenceFiles(prev => [...prev, ...picked]);
  };

  // Upload buffered evidence to the FINAL order id (the new draft, or the merge
  // target). Returns true if every file uploaded. Non-fatal: a false result
  // surfaces a warning but the order is already submitted.
  const uploadEvidence = async (finalId: string): Promise<boolean> => {
    let ok = true;
    for (const f of evidenceFiles) {
      try {
        const form = new FormData();
        form.append('file', f);
        await api.upload(`/api/orders/${finalId}/status-meta/Submission/attachments`, form);
      } catch { ok = false; }
    }
    return ok;
  };

  // Create a server-side draft order as soon as the form mounts so that
  // per-line confirms have an order to attach to.
  const [draftId, setDraftId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    createDraftOrder(category)
      .then(r => { if (alive) setDraftId(r.id); })
      .catch(() => {
        if (alive) setAiError('Could not start a draft order — retry.');
      });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  // Existing same-category Draft POs the user can append to instead of creating
  // a fresh PO. Fetched once; re-filtered when draftId resolves so the throwaway
  // draft this form just created never appears as its own merge target.
  const [allDrafts, setAllDrafts] = useState<OrderSummary[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ orders: OrderSummary[] }>(`/api/orders?category=${category}&status=Draft`)
      .then(r => { if (alive) setAllDrafts(r.orders); })
      .catch(() => { /* non-fatal: just means no "add to existing" option */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const targets = useMemo(
    () => eligibleDraftTargets(allDrafts, { category, meId: user?.id, excludeId: draftId }),
    [allDrafts, category, user?.id, draftId],
  );

  // Default the warehouse to the first one once they load.
  useEffect(() => {
    if (warehouses.length && !meta.warehouseId) {
      setMeta(m => ({ ...m, warehouseId: warehouses[0].id }));
    }
  }, [warehouses, meta.warehouseId]);

  const totals = useMemo(() => {
    let units = 0, cost = 0;
    lines.forEach(l => {
      const qty = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      units += qty;
      cost += qty * c;
    });
    return { units, cost };
  }, [lines]);

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  const dupByIdx = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of dupGroups) {
      for (const ln of g.lineNums) {
        m.set(ln - 1, g.lineNums.filter(n => n !== ln));
      }
    }
    return m;
  }, [dupGroups]);
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // When the dup-part warning is reached via "add to existing", remember which
  // target to merge into so confirming the warning doesn't fall back to new-PO.
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ selectedId: string | null } | null>(null);
  // Lines submitted with a blank part number that can be auto-filled (e.g.
  // Mixed-brand SSDs). Holds the proposed value per line for the confirm modal.
  const [pnConfirm, setPnConfirm] = useState<{ idx: number; value: string }[] | null>(null);

  const updateLine = (i: number, patch: Partial<Line>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // Adding the next line first auto-saves the line the user was filling out,
  // so they don't lose work by forgetting to press Confirm. If the active line
  // isn't ready yet, surface the reason and don't append — otherwise the user
  // ends up with a silent half-saved row.
  const addLine = async () => {
    if (activeIdx != null) {
      const cur = lines[activeIdx];
      if (cur && !cur._confirmed) {
        if (!lineReady(cur)) {
          setAiError(t('subFillThisLine'));
          return;
        }
        try {
          await handleConfirmLine(activeIdx);
        } catch (e) {
          setAiError(e instanceof Error ? e.message : t('subSubmitFailed'));
          return;
        }
      }
    }
    setLines(ls => [...ls, blankLine(category)]);
    setActiveIdx(lines.length);
  };

  const removeLine = (i: number) => {
    setLines(ls => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));
    setActiveIdx(idx => {
      if (lines.length <= 1) return null;
      if (i === idx) return null;
      if (idx != null && i < idx) return idx - 1;
      return idx;
    });
  };

  const lineReady = (l: Line) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  };

  const canSubmit = lines.every(lineReady);

  // Maps a local Line to the wire shape expected by PATCH /api/orders/:id addLines.
  const toWireLine = (l: Line) => ({
    category: l.category,
    brand: l.brand ?? null,
    capacity: l.capacity ?? null,
    type: l.type ?? null,
    generation: l.generation ?? null,
    classification: l.classification ?? null,
    rank: l.rank ?? null,
    speed: l.speed ?? null,
    interface: l.interface ?? null,
    formFactor: l.formFactor ?? null,
    description: l.description ?? null,
    partNumber: l.partNumber ?? null,
    serialNumber: l.serialNumber ?? null,
    condition: l.condition,
    qty: Number(l.qty) || 1,
    unitCost: Number(l.unitCost) || 0,
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    status: 'In Transit' as const,
    scanImageId: l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  });

  // Confirms a single line AND auto-saves the current order metadata in the
  // same PATCH. The user doesn't need to click "Submit Order" to keep their
  // work safe — closing the tab after confirming a line leaves nothing
  // unsaved. (Submit Order remains as the navigate-away trigger.)
  const handleConfirmLine = async (idx: number): Promise<void> => {
    if (!draftId) {
      setAiError('Could not start a draft order — retry.');
      return;
    }
    const l = lines[idx];
    if (l._confirmed) return;
    if (!lineReady(l)) {
      setAiError('Fill in brand/description, quantity and unit cost before confirming this line.');
      return;
    }
    const totalCost = meta.totalCostOverride != null
      ? (Number(meta.totalCostOverride) || 0)
      : totals.cost;
    await api.patch('/api/orders/' + draftId, {
      addLines: [toWireLine(l)],
      ...(meta.warehouseId ? { warehouseId: meta.warehouseId } : {}),
      payment: meta.payment === 'Company' ? 'company' : 'self',
      notes: meta.notes || null,
      totalCost,
    });
    updateLine(idx, { _confirmed: true });
  };

  // Escape closes the drawer.
  useEscapeKey(useCallback(() => setActiveIdx(null), []), activeIdx !== null);

  // `submitLines` defaults to state, but the part-number confirm flow passes a
  // freshly-patched array: setLines() is async, so submitting from state right
  // after it would serialize the PRE-patch lines and drop accepted part numbers.
  const doSubmit = async (submitLines: Line[] = lines) => {
    if (!draftId) { setAiError(t('subNoDraftErr')); return; }
    const totalCost = meta.totalCostOverride != null
      ? (Number(meta.totalCostOverride) || 0)
      : totals.cost;
    const unconfirmedLines = submitLines.filter(l => !l._confirmed);
    setSubmitting(true);
    try {
      await api.patch('/api/orders/' + draftId, {
        warehouseId: meta.warehouseId,
        payment: meta.payment === 'Company' ? 'company' : 'self',
        notes: meta.notes || null,
        totalCost,
        ...(unconfirmedLines.length > 0 ? { addLines: unconfirmedLines.map(toWireLine) } : {}),
      });
      if (evidenceFiles.length > 0) {
        const ok = await uploadEvidence(draftId);
        onDone(ok
          ? { msg: t('orderSubmitted'), kind: 'success' }
          : { msg: t('poSubmitUploadWarning'), kind: 'error' });
        return;
      }
      onDone({ msg: t('orderSubmitted'), kind: 'success' });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Append all local lines to an existing Draft PO, then remove the throwaway
  // draft this session created. Target meta (warehouse/payment/notes) is
  // inherited — we send only lines + a refreshed total.
  const doSubmitToExisting = async (target: OrderSummary, submitLines: Line[] = lines) => {
    if (!draftId) { setAiError(t('subNoDraftErr')); return; }
    setSubmitting(true);
    try {
      await api.patch('/api/orders/' + target.id, {
        addLines: submitLines.map(toWireLine),
        totalCost: (target.totalCost ?? 0) + totals.cost,
      });
      const evidenceOk = evidenceFiles.length === 0 || await uploadEvidence(target.id);
      // Best-effort cleanup of the now-empty throwaway draft — the merge already
      // succeeded, so a failure here must not fail the submit.
      try { await deleteOrder(draftId); } catch { /* leaves an empty draft; harmless */ }
      onDone(evidenceOk
        ? { msg: t('subLinesAddedToPo', { id: target.id }), kind: 'success' }
        : { msg: t('poSubmitUploadWarning'), kind: 'error' });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Part # is required on every line. Clicking Submit first checks for blanks:
  // a line we can auto-fill (synthesizePartNumber returns a value, e.g. a
  // Mixed-brand SSD) is offered in a confirm modal; a blank we can't fill is a
  // hard stop. Only once all lines have (or accept) a part # do we proceed into
  // the existing target/duplicate flow.
  const proceedSubmit = (submitLines: Line[] = lines) => {
    if (targets.length > 0) { setChoice({ selectedId: null }); return; }
    // Recompute duplicates from the lines we're about to submit — dupGroups is
    // memoized on state, which lags a just-applied part-number patch.
    const dups = submitLines === lines ? dupGroups : findDuplicatePartNumbers(submitLines);
    if (dups.length > 0) { setDupConfirm(dups); return; }
    void doSubmit(submitLines);
  };

  const attemptSubmit = () => {
    const blanks = lines
      .map((l, idx) => ({ idx, l, gen: (l.partNumber ?? '').trim() ? null : synthesizePartNumber(l.category, l) }))
      .filter(x => !(x.l.partNumber ?? '').trim());
    const blocking = blanks.find(x => !x.gen);
    if (blocking) { setAiError(t('pnRequiredLine', { n: blocking.idx + 1 })); return; }
    if (blanks.length > 0) {
      setPnConfirm(blanks.map(x => ({ idx: x.idx, value: x.gen! })));
      return;
    }
    proceedSubmit();
  };

  // Reason the Submit button is disabled, surfaced inline so the user isn't
  // staring at a dead button wondering what's wrong. Checked in priority
  // order: still submitting → draft creation → warehouse pick → per-line completeness.
  const submitDisabledReason: string | null =
    submitting              ? null
  : !draftId                ? t('subStartingDraft')
  : warehouses.length === 0 ? t('subWarehousesNotLoaded')
  : !meta.warehouseId       ? t('reviewPickWarehouseHint')
  : !canSubmit              ? (() => {
      const bad = lines.findIndex(l => !lineReady(l));
      if (bad < 0) return null;
      return lines.length === 1
        ? t('subFillThisLine')
        : t('subFillLineN', { n: bad + 1 });
    })()
  : null;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">{t('subOrderContainsMultiple', { cat: category })}</div>
          </div>
          <span className="chip mono">
            {(draftId ?? t('subDrafting'))} · {t('lifecycleDraft')}
          </span>
        </div>

        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 18px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {t('subItemsInOrder')} <span style={{ fontWeight: 500, color: 'var(--fg-subtle)', marginLeft: 4 }}>({lines.length})</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('subItemsClickRow', { cat: category })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.units, cost: fmtUSD(totals.cost, locale) })}</span>
            <button className="btn" onClick={addLine}>
              <Icon name="plus" size={13} /> {t('subAddLine', { cat: category })}
            </button>
          </div>
        </div>
        {aiError && (
          <div style={{
            margin: '12px 18px 12px', padding: '10px 12px',
            background: 'rgba(220,40,40,0.08)', border: '1px solid rgba(220,40,40,0.25)',
            borderRadius: 8, fontSize: 12, color: 'var(--neg, #b22)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <span>{aiError}</span>
            <button
              className="btn icon sm"
              onClick={() => setAiError(null)}
              title={t('dismiss')}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>{t('item')}</th>
              <th>{t('partNumber')}</th>
              <th className="num">{t('qty')}</th>
              <th className="num">{t('unitCost')}</th>
              <th className="num">{t('totalCost')}</th>
              <th>{t('status')}</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lQty = Number(l.qty) || 0;
              const lCost = Number(l.unitCost) || 0;
              const filled = !!l.brand || !!l.description;
              const isActive = i === activeIdx;
              return (
                <tr
                  key={l._cid}
                  className="row-hover"
                  style={{ cursor: 'pointer', background: isActive ? 'var(--accent-soft)' : undefined }}
                  onClick={() => setActiveIdx(i)}
                >
                  <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                  <td>
                    {filled ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()}
                          {l.category === 'HDD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()}
                          {l.category === 'Other' && (l.description ?? '—')}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                          {l.category === 'RAM' && [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')}
                          {l.category === 'SSD' && [l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'HDD' && [l.interface, l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'Other' && l.condition}
                        </div>
                      </div>
                    ) : <span className="muted" style={{ fontStyle: 'italic' }}>{isActive ? t('subEditingFill') : t('subNotFilled')}</span>}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                  <td className="num mono">{lQty}</td>
                  <td className="num mono">{lCost ? fmtUSD(lCost, locale) : '—'}</td>
                  <td className="num mono">{lQty && lCost ? fmtUSD(lQty * lCost, locale) : '—'}</td>
                  <td>
                    {isActive && <span className="chip info"><Icon name="edit" size={10} /> {t('subStatusEditing')}</span>}
                    {!isActive && filled && <span className="chip pos">{t('subStatusReady')}</span>}
                    {!isActive && !filled && <span className="chip warn">{t('subStatusNeedsInfo')}</span>}
                  </td>
                  <td>
                    <button
                      className="btn icon sm"
                      onClick={e => { e.stopPropagation(); removeLine(i); }}
                      title={t('soRemoveLineTooltip')}
                      disabled={lines.length <= 1}
                      style={lines.length <= 1 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sticky bottom: meta + totals + submit */}
      <div className="card" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: '0 12px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('warehouse')} <span className="req">*</span></label>
              <select
                className="select"
                value={meta.warehouseId}
                onChange={e => setMeta(m => ({ ...m, warehouseId: e.target.value }))}
              >
                {warehouses.length === 0 && <option value="">{t('loadingApp')}</option>}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('payment')} <span className="req">*</span></label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  className={meta.payment === 'Company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Company' }))}
                >{t('payCompanyShort')}</button>
                <button
                  className={meta.payment === 'Self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Self' }))}
                >{t('paySelfShort')}</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>{t('totalCost')}</span>
                {meta.totalCostOverride !== null && (
                  <button
                    onClick={() => setMeta(m => ({ ...m, totalCostOverride: null }))}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-strong)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                    title={t('subAutoSumIs', { cost: fmtUSD(totals.cost, locale) })}
                  >{t('reset')}</button>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}>$</span>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={meta.totalCostOverride !== null ? meta.totalCostOverride : totals.cost.toFixed(2)}
                  onChange={e => setMeta(m => ({ ...m, totalCostOverride: e.target.value }))}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 24, fontWeight: 500 }}
                />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('orderNotes')}</label>
              <input
                className="input"
                value={meta.notes}
                onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
                placeholder={t('subOptional')}
              />
            </div>
          </div>
        </div>

        <div style={{ padding: '0 16px 16px' }}>
          <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('poSubmitAttachLabel')}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>{t('poSubmitAttachHint')}</span>
          </label>
          <div
            onDragOver={e => { e.preventDefault(); setEvidenceDragOver(true); }}
            onDragLeave={() => setEvidenceDragOver(false)}
            onDrop={e => { e.preventDefault(); setEvidenceDragOver(false); addEvidenceFiles(e.dataTransfer.files); }}
            onClick={() => evidenceInputRef.current?.click()}
            style={{
              border: '1.5px dashed ' + (evidenceDragOver ? 'var(--accent)' : 'var(--border-strong)'),
              background: evidenceDragOver ? 'var(--accent-soft)' : 'var(--bg-soft)',
              borderRadius: 10, padding: '16px', textAlign: 'center', cursor: 'pointer',
              transition: 'border-color 120ms, background 120ms',
            }}
          >
            <Icon name="upload" size={18} style={{ color: 'var(--fg-subtle)' }} />
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <strong style={{ color: 'var(--accent-strong)' }}>{t('clickToUpload')}</strong> {t('orDragDrop')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('uploadHint')}</div>
            <input
              ref={evidenceInputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={e => { addEvidenceFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
          {evidencePreviews.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {evidencePreviews.map(p => (
                <AttachmentChip
                  key={p.url}
                  a={{ id: p.url, filename: p.file.name, size: p.file.size, mime: p.file.type, url: p.url }}
                  onRemove={() => setEvidenceFiles(prev => prev.filter(x => x !== p.file))}
                />
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 18, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('lines')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('subTotalUnits')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.units}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              {t('totalCost')}
              {meta.totalCostOverride !== null && Math.abs((Number(meta.totalCostOverride) || 0) - totals.cost) > 0.01 && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(meta.totalCostOverride !== null ? (Number(meta.totalCostOverride) || 0) : totals.cost, locale)}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onCancel}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={!canSubmit || !meta.warehouseId || !draftId || submitting}
                title={submitDisabledReason ?? undefined}
                onClick={attemptSubmit}
              >
                {t('submitOrder')} <Icon name="check" size={14} />
              </button>
            </div>
            {submitDisabledReason && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', maxWidth: 320, textAlign: 'right' }}>
                {submitDisabledReason}
              </div>
            )}
          </div>
        </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          line={lines[activeIdx]}
          idx={activeIdx}
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          onConfirmLine={() => handleConfirmLine(activeIdx)}
          onConfirmError={setAiError}
          duplicateOnLines={dupByIdx.get(activeIdx)}
        />
      )}

      {choice && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setChoice(null); }}>
          <div className="modal-shell" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">{t('subSubmitChoiceTitle')}</div>
                <div className="modal-sub">{t('subSubmitChoiceSub')}</div>
              </div>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <button
                className="card"
                disabled={submitting}
                style={{
                  padding: 14, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-elev)',
                }}
                onClick={() => {
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(null); setDupConfirm(dupGroups); return; }
                  void doSubmit();
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceNewPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('subChoiceNewPoSub')}</div>
              </button>

              <div className="card" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceExistingPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2, marginBottom: 10 }}>
                  {t('subChoiceExistingPoSub', { cat: category })}
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {targets.map(o => {
                    const sel = choice.selectedId === o.id;
                    return (
                      <button
                        key={o.id}
                        disabled={submitting}
                        onClick={() => setChoice({ selectedId: o.id })}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                          borderRadius: 8, background: sel ? 'var(--accent-soft)' : 'transparent',
                          border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--border)'),
                        }}
                      >
                        <span className="mono" style={{ fontWeight: sel ? 600 : 500, color: sel ? 'var(--accent-strong)' : undefined }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                          {(o.warehouse?.short ?? '—') + ' · ' + t('subTargetMeta', { n: o.lineCount, cost: fmtUSD(o.totalCost ?? 0, locale) }) + ' · ' + fmtDateShort(o.createdAt, locale)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setChoice(null)} disabled={submitting}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={submitting || !choice.selectedId}
                onClick={() => {
                  const target = targets.find(o => o.id === choice.selectedId);
                  if (!target) return;
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(target.id); setDupConfirm(dupGroups); return; }
                  void doSubmitToExisting(target);
                }}
              >
                {submitting ? '…' : t('subChoicePickTarget')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dupConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setDupConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="alert" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('dupPartModalTitle')}</div>
                  <div className="modal-sub">{t('dupPartModalSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {dupConfirm.map(g => (
                  <li key={g.partNumber.toLowerCase()}>
                    {(g.lineNums.length === 1 ? t('dupPartModalRowOne') : t('dupPartModalRowMany'))
                      .replace('{pn}', g.partNumber)
                      .replace('{nums}', g.lineNums.join(', '))}
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDupConfirm(null)} disabled={submitting}>
                {t('dupPartReview')}
              </button>
              <button
                className="btn accent"
                disabled={submitting}
                onClick={async () => {
                  setDupConfirm(null);
                  const target = pendingTargetId ? targets.find(o => o.id === pendingTargetId) : null;
                  setPendingTargetId(null);
                  if (target) await doSubmitToExisting(target);
                  else await doSubmit();
                }}
              >
                {submitting ? '…' : t('dupPartSubmitAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pnConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setPnConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="hash" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('pnConfirmTitle')}</div>
                  <div className="modal-sub">{pnConfirm.length === 1 ? t('pnConfirmSubOne') : t('pnConfirmSubMany')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {pnConfirm.map(p => (
                  <li key={p.idx}>
                    {t('pnConfirmRow', { n: p.idx + 1 })} <span className="mono" style={{ fontWeight: 600 }}>{p.value}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPnConfirm(null)}>{t('pnConfirmEdit')}</button>
              <button
                className="btn accent"
                onClick={() => {
                  // Apply the accepted part numbers to a local array and submit
                  // from it directly. updateLine()/setLines is async, so calling
                  // proceedSubmit() against state here would drop these values.
                  const patched = lines.map((l, i) => {
                    const m = pnConfirm.find(p => p.idx === i);
                    return m ? { ...l, partNumber: m.value } : l;
                  });
                  setLines(patched);
                  setPnConfirm(null);
                  proceedSubmit(patched);
                }}
              >
                {t('pnConfirmUse')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// LineDrawer + the per-category field groups (RamFields/SsdFields/HddFields/
// OtherFields/CatSelect) were extracted verbatim into ./submit/* — re-exported
// here so external importers (DesktopEditOrder) keep their existing import path.
export { LineDrawer };
