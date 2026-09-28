import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageLightbox } from '../../../components/ImageLightbox';
import { Modal } from '../../../components/Modal';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { missingRamFields } from '../../../lib/ramRequired';
import { scanErrorMessage } from '../../../lib/scanError';
import { BridgeError, bridgeHealth, bridgeScan, type BridgeHealth } from '../../../lib/scannerBridge';
import { splitSheet } from '../../../lib/sheetImage';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from '../../../lib/status';
import type { ScanResponse } from '../../../lib/types';
import type { SheetBox } from '@recycle-erp/shared';
import type { Line } from './line';
import {
  buildRamLinePatches, runPool, samePartsAsEarlier, SHEET_STEPS, stepStates, withRateLimitRetry,
  type SheetStage, type SheetStep,
} from './ramSheet';

// "Scan RAM sheet" (RS-109): one flatbed page of several sticks → one crop per
// stick → the existing /api/scan/label RAM pipeline per crop → reviewed rows
// → RAM lines on the PO. The page comes from the local scanner bridge or an
// uploaded image; the split runs here in the browser.
//
// RS-114: every stage shows itself while it runs (step row, sweeping page,
// elapsed time, progress bars, per-stick pulses), a scan can be cancelled,
// and failures say what to do. The action buttons deliberately do NOT live in
// an .ai-dropzone: that class makes its children pointer-events: none, which
// is what left "Scan from printer" dead to the mouse in RS-109.
//
// RS-115: scans accumulate. Each scan or upload adds its sticks under their
// own "Scan N" group, numbered on from the last stick; a group can be removed
// (e.g. the same sheet scanned twice) and the whole table cleared.

// Three labels in flight keeps a 10-stick sheet to a few seconds without
// tripping the 20-a-minute scan limit on a normal sheet.
const READ_CONCURRENCY = 3;
// While the bridge is down the chip re-checks on its own, so starting it
// turns the dialog green without a click.
const BRIDGE_POLL_MS = 5000;
// Shown until the bridge reports the resolution it resolved from the scanner
// (it reads it on the first scan); the office MF460 II's maximum.
const TYPICAL_DPI = 300;

// How long the last scan took, for the estimate bar. Module-level on purpose:
// it is a property of this Mac and printer, not of the user, so it doesn't
// belong in the synced preferences. A fresh page starts from a typical pass.
let lastScanMs = 12_000;

type Row = {
  /** Never reused within the dialog; the stick number shown is id + 1. */
  id: number;
  sheetId: number;
  box: SheetBox;
  crop: Blob;
  cropUrl: string;
  status: 'reading' | 'done' | 'error';
  scan?: ScanResponse;
  error?: string;
  include: boolean;
  qty: string;
  unitCost: string;
};

type Sheet = { id: number; url: string; width: number; height: number };

type FailureKind = 'down' | 'printer' | 'busy' | 'cancelled' | 'none' | 'image';
type Failure = { step: SheetStep; kind: FailureKind; detail?: string };

export function RamSheetScanDialog({
  onClose,
  onAddLines,
}: {
  onClose: () => void;
  onAddLines: (patches: Partial<Line>[]) => void;
}) {
  const { t, lang } = useT();
  const [health, setHealth] = useState<BridgeHealth | null | 'checking'>('checking');
  const [stage, setStage] = useState<SheetStage>('idle');
  const [source, setSource] = useState<'printer' | 'upload'>('printer');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [scanStartedAt, setScanStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [costAll, setCostAll] = useState('');
  const [combine, setCombine] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  // Full-screen view of one stick's crop, or the whole scanned sheet.
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // One run = one scan or upload. A newer run or closing the dialog bumps the
  // id; the stage, failure and new-sheet updates check it, so an older run
  // can't move the dialog while a newer one is working. Label results don't
  // need it: every stick has its own never-reused id, so a late result can
  // only ever land on its own row (or on nothing, once removed).
  const runRef = useRef(0);
  const nextStickId = useRef(0);
  const nextSheetId = useRef(0);
  const removed = useRef(new Set<number>());
  const mounted = useRef(true);
  const scanCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    // Set on every mount, not just initialised: StrictMode (dev) mounts,
    // cleans up and mounts again, and a guard left false after that first
    // cleanup silently skipped every label read.
    mounted.current = true;
    return () => {
      mounted.current = false;
      runRef.current++;
      scanCtrl.current?.abort();
    };
  }, []);

  // Object URLs made for this dialog: revoked when their scan is removed or
  // cleared, and whatever is left on unmount.
  const urls = useRef(new Set<string>());
  useEffect(() => () => urls.current.forEach(u => URL.revokeObjectURL(u)), []);
  const objectUrl = (b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.current.add(u);
    return u;
  };
  const revoke = (u: string) => {
    URL.revokeObjectURL(u);
    urls.current.delete(u);
  };

  const checkBridge = useCallback(async (): Promise<BridgeHealth | null> => {
    const h = await bridgeHealth();
    setHealth(h);
    return h;
  }, []);
  useEffect(() => { void checkBridge(); }, [checkBridge]);

  // Poll only while the bridge is known to be down; the interval dies the
  // moment it answers, and a focus back on the window checks right away.
  useEffect(() => {
    if (health !== null) return;
    const id = window.setInterval(() => { void checkBridge(); }, BRIDGE_POLL_MS);
    const onFocus = () => { void checkBridge(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [health, checkBridge]);

  // The elapsed-seconds tick runs only while the printer is scanning.
  useEffect(() => {
    if (stage !== 'scan') return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [stage]);

  const patchRow = (id: number, patch: Partial<Row>) => {
    if (!mounted.current) return;
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };

  const fail = (run: number, step: SheetStep, kind: FailureKind, detail?: string) => {
    if (run !== runRef.current) return;
    setFailure({ step, kind, detail });
    // A cancel is the user's choice, not a failure: reset the steps rather
    // than paint the scan step red.
    setStage(kind === 'cancelled' ? 'idle' : step);
  };

  const readLabel = async (row: Pick<Row, 'id' | 'crop' | 'box'>) => {
    // A removed scan's queued sticks never reach the model: each read is a
    // billed call and counts against the 20-a-minute scan limit.
    if (removed.current.has(row.id) || !mounted.current) return;
    patchRow(row.id, { status: 'reading', error: undefined });
    try {
      const scan = await withRateLimitRetry(() => {
        const form = new FormData();
        form.append('file', row.crop, `ram-sheet-stick-${row.id + 1}.jpg`);
        form.append('category', 'RAM');
        return api.upload<ScanResponse>('/api/scan/label', form);
      });
      patchRow(row.id, { status: 'done', scan, include: !row.box.maybeMerged });
    } catch (e) {
      patchRow(row.id, { status: 'error', error: scanErrorMessage(e, t), include: false });
    }
  };

  const processSheet = async (run: number, page: Blob) => {
    setStage('split');
    try {
      const split = await splitSheet(page);
      if (run !== runRef.current) return;
      if (!split.crops.length) {
        fail(run, 'split', 'none');
        return;
      }
      const sheetId = nextSheetId.current++;
      setSheets(ss => [...ss, { id: sheetId, url: objectUrl(page), width: split.width, height: split.height }]);
      const fresh: Row[] = split.crops.map(c => ({
        id: nextStickId.current++,
        sheetId,
        box: c.box,
        crop: c.blob,
        cropUrl: objectUrl(c.blob),
        status: 'reading',
        include: !c.box.maybeMerged,
        qty: '1',
        unitCost: costAll,
      }));
      setRows(rs => [...rs, ...fresh]);
      setStage('read');
      await runPool(fresh.map(r => () => readLabel(r)), READ_CONCURRENCY);
      if (run === runRef.current) setStage('review');
    } catch (e) {
      console.error('[ram-sheet] split failed', e);
      fail(run, 'split', 'image');
    }
  };

  const startRun = (from: 'printer' | 'upload'): number => {
    scanCtrl.current?.abort();
    const run = ++runRef.current;
    setSource(from);
    setFailure(null);
    return run;
  };

  // Never disabled because an earlier check said the bridge was down: the
  // click itself re-checks, so starting the bridge and clicking just works.
  const scanFromPrinter = async () => {
    const run = startRun('printer');
    setStage('connect');
    const h = await checkBridge();
    if (run !== runRef.current) return;
    if (!h) {
      fail(run, 'connect', 'down');
      return;
    }
    const ctrl = new AbortController();
    scanCtrl.current = ctrl;
    const started = Date.now();
    setScanStartedAt(started);
    setNow(started);
    setStage('scan');
    try {
      const page = await bridgeScan(ctrl.signal);
      if (run !== runRef.current) return;
      lastScanMs = Date.now() - started;
      await processSheet(run, page);
    } catch (e) {
      const kind: FailureKind = e instanceof BridgeError ? e.kind : 'printer';
      if (kind === 'down') setHealth(null);
      fail(run, 'scan', kind, e instanceof Error ? e.message : String(e));
    }
  };

  // Cancel keeps the run id, so the aborted fetch's "cancelled" failure is
  // the one that shows.
  const cancelScan = () => scanCtrl.current?.abort();

  const takeFiles = (files: File[]) => {
    const f = files.find(x => x.type.startsWith('image/'));
    if (!f) {
      if (files.length) {
        const run = startRun('upload');
        fail(run, 'split', 'image');
      }
      return;
    }
    const run = startRun('upload');
    void processSheet(run, f);
  };

  const retryRow = (r: Row) => void readLabel(r);

  const dropRows = (gone: Row[]) => {
    gone.forEach(r => {
      removed.current.add(r.id);
      revoke(r.cropUrl);
    });
  };
  const removeSheet = (sheetId: number) => {
    dropRows(rows.filter(r => r.sheetId === sheetId));
    const s = sheets.find(x => x.id === sheetId);
    if (s) revoke(s.url);
    setRows(rs => rs.filter(r => r.sheetId !== sheetId));
    setSheets(ss => ss.filter(x => x.id !== sheetId));
  };
  const clearAll = () => {
    dropRows(rows);
    sheets.forEach(s => revoke(s.url));
    setRows([]);
    setSheets([]);
    setFailure(null);
    setStage('idle');
  };
  const applyCostAll = () => setRows(rs => rs.map(r => ({ ...r, unitCost: costAll })));

  const included = rows.filter(r => r.include && r.status === 'done' && r.scan);
  const reading = rows.filter(r => r.status === 'reading').length;
  const incomplete = included.some(r => !(Number(r.qty) > 0) || !(Number(r.unitCost) > 0));
  const patches = buildRamLinePatches(
    included.map(r => ({ scan: r.scan!, qty: Number(r.qty), unitCost: r.unitCost })),
    { combineByPn: combine },
  );
  const canAdd = included.length > 0 && !incomplete && reading === 0;
  const working = !failure && (stage === 'connect' || stage === 'scan' || stage === 'split');
  // The preview shows the newest scan that still has sticks in the table.
  const previewSheet = [...sheets].reverse().find(s => rows.some(r => r.sheetId === s.id)) ?? null;
  const steps = stepStates(stage, source, failure?.kind === 'cancelled' ? undefined : failure?.step);
  const showSteps = stage !== 'idle' || !!failure;

  return (
    <Modal
      onClose={onClose}
      shellStyle={{ maxWidth: 980, width: 'calc(100vw - 80px)' }}
      ariaLabel={t('rsheetTitle')}
      // Esc belongs to the lightbox while it is open (as in BrandConfirmDialog).
      closeOnEscape={!zoom}
    >
      <div className="modal-head" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="modal-title">{t('rsheetTitle')}</div>
        <BridgeChip health={health} onRecheck={() => { setHealth('checking'); void checkBridge(); }} />
      </div>

      <div
        className={`modal-body rsheet-body${dragOver ? ' is-dragover' : ''}`}
        style={{ padding: 20, maxHeight: '68vh', overflowY: 'auto' }}
        onDragOver={e => { e.preventDefault(); if (!working) setDragOver(true); }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          if (!working) takeFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {showSteps && <StepRow steps={steps} />}

        <div className="rsheet-actions">
          {stage === 'scan' && !failure ? (
            <button type="button" className="btn" onClick={cancelScan}>{t('rsheetCancelScan')}</button>
          ) : (
            <button
              type="button"
              className="btn accent"
              disabled={working}
              onClick={() => void scanFromPrinter()}
            >
              {rows.length ? t('rsheetScanNext') : failure ? t('rsheetRescan') : t('rsheetScanPrinter')}
            </button>
          )}
          <button type="button" className="btn" disabled={working} onClick={() => fileRef.current?.click()}>
            {t('rsheetUpload')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={e => {
              // Copy before clearing: the FileList is live and empties with the value.
              const picked = Array.from(e.target.files ?? []);
              e.target.value = '';
              takeFiles(picked);
            }}
          />
          <span className="rsheet-hint">{t('rsheetHint')}</span>
        </div>

        {failure && (
          <FailureCard
            failure={failure}
            onRetry={() => (source === 'upload' ? fileRef.current?.click() : void scanFromPrinter())}
          />
        )}

        {working && (
          <div className="rsheet-stage">
            <div className={`rsheet-page${stage === 'connect' ? ' is-connecting' : ''}`}>
              {stage === 'scan' && <div className="scan-line" />}
              {stage === 'connect' && <span className="ai-dot" />}
            </div>
            <WorkingStatus
              stage={stage}
              elapsedMs={now - scanStartedAt}
              dpi={(health && health !== 'checking' ? health.dpi : null) ?? TYPICAL_DPI}
            />
          </div>
        )}

        {previewSheet && rows.length > 0 && (
          <div className="rsheet-stage">
            <SheetPreview
              sheet={previewSheet}
              rows={rows.filter(r => r.sheetId === previewSheet.id)}
              onZoomSheet={() => setZoom({ url: previewSheet.url, alt: t('rsheetSheetAlt') })}
              onZoomStick={r => setZoom({ url: r.cropUrl, alt: t('rsheetStick', { n: r.id + 1 }) })}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              {reading > 0 ? (
                <ProgressLine
                  title={t('rsheetReading', { done: rows.length - reading, total: rows.length })}
                  sub={t('rsheetReadingSub')}
                  pct={(100 * (rows.length - reading)) / rows.length}
                />
              ) : (
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  {t('rsheetFound', { n: rows.length })}
                </div>
              )}
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>{t('item')}</th>
                    <th className="num" style={{ width: 70 }}>{t('qty')}</th>
                    <th className="num" style={{ width: 100 }}>{t('unitCost')}</th>
                  </tr>
                </thead>
                {sheets.map((s, i) => {
                  const group = rows.filter(r => r.sheetId === s.id);
                  if (!group.length) return null;
                  const pns = (rs: Row[]) => rs.map(r => r.scan?.extracted?.partNumber ?? '');
                  const earlier = rows.filter(r => sheets.findIndex(x => x.id === r.sheetId) < i);
                  const repeat = group.every(r => r.status !== 'reading')
                    && samePartsAsEarlier(pns(group), pns(earlier));
                  return (
                    <tbody key={s.id}>
                      <tr className="rsheet-group">
                        <td colSpan={4}>
                          <span className="rsheet-group-title">
                            {t('rsheetGroup', { n: s.id + 1, k: group.length })}
                          </span>
                          {repeat && <span className="chip warn">{t('rsheetSameSheet')}</span>}
                          {sheets.length > 1 && (
                            <button
                              type="button"
                              className="btn sm ghost"
                              onClick={() => removeSheet(s.id)}
                              title={t('rsheetRemoveScanTitle')}
                            >
                              {t('rsheetRemoveScan')}
                            </button>
                          )}
                        </td>
                      </tr>
                      {group.map(r => (
                        <StickRow
                          key={r.id}
                          row={r}
                          lang={lang}
                          onToggle={() => patchRow(r.id, { include: !r.include })}
                          onQty={v => patchRow(r.id, { qty: v })}
                          onCost={v => patchRow(r.id, { unitCost: v })}
                          onRetry={() => retryRow(r)}
                          onZoom={() => setZoom({ url: r.cropUrl, alt: t('rsheetStick', { n: r.id + 1 }) })}
                        />
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="modal-foot" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {rows.length > 0 && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              {t('rsheetCostAll')}
              <input
                className="input mono"
                style={{ width: 90 }}
                inputMode="decimal"
                value={costAll}
                onChange={e => setCostAll(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applyCostAll(); }}
              />
            </label>
            <button type="button" className="btn sm" onClick={applyCostAll} disabled={!costAll}>
              {t('rsheetApply')}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={combine} onChange={() => setCombine(c => !c)} />
              {t('rsheetCombine')}
            </label>
            <button type="button" className="btn sm ghost" onClick={clearAll} disabled={working}>
              {t('rsheetClearAll')}
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
        {rows.length > 0 && (
          <button
            type="button"
            className="btn accent"
            disabled={!canAdd}
            title={incomplete ? t('rsheetNeedQtyCost') : undefined}
            onClick={() => { onAddLines(patches); onClose(); }}
          >
            {t('rsheetAddLines', { n: patches.length })}
          </button>
        )}
      </div>
      {zoom && <ImageLightbox url={zoom.url} alt={zoom.alt} zIndex={200} onClose={() => setZoom(null)} />}
    </Modal>
  );
}

const STEP_LABEL: Record<SheetStep, string> = {
  connect: 'rsheetStepConnect',
  scan: 'rsheetStepScan',
  split: 'rsheetStepFind',
  read: 'rsheetStepRead',
};

function StepRow({ steps }: { steps: ReturnType<typeof stepStates> }) {
  const { t } = useT();
  return (
    <ol className="rsheet-steps" aria-label={t('rsheetProgress')}>
      {SHEET_STEPS.map((s, i) => (
        <li key={s} className={`rsheet-step is-${steps[s]}`} aria-current={steps[s] === 'active' ? 'step' : undefined}>
          <span className="rsheet-step-icon" aria-hidden>
            {steps[s] === 'done' ? '✓' : steps[s] === 'error' ? '!' : steps[s] === 'active' ? <span className="ai-dot" /> : i + 1}
          </span>
          {t(STEP_LABEL[s])}
        </li>
      ))}
    </ol>
  );
}

function WorkingStatus({ stage, elapsedMs, dpi }: { stage: SheetStage; elapsedMs: number; dpi: number }) {
  const { t } = useT();
  if (stage === 'connect') return <ProgressLine title={t('rsheetConnecting')} />;
  if (stage === 'split') return <ProgressLine title={t('rsheetSplitting')} />;
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  // An estimate, never a promise: capped short of full until the page lands.
  const pct = Math.min(95, (100 * elapsedMs) / lastScanMs);
  return (
    <ProgressLine
      title={t('rsheetScanningAt', { dpi })}
      sub={t('rsheetScanElapsed', { s, est: Math.round(lastScanMs / 1000) })}
      note={t('rsheetKeepLid')}
      pct={pct}
    />
  );
}

function ProgressLine({ title, sub, note, pct }: { title: string; sub?: string; note?: string; pct?: number }) {
  return (
    <div className="rsheet-status" role="status" aria-live="polite">
      <div className="rsheet-status-title">{title}</div>
      {pct != null && (
        <div className="rsheet-bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {sub && <div className="rsheet-status-sub">{sub}</div>}
      {note && <div className="rsheet-status-sub">{note}</div>}
    </div>
  );
}

const FAILURE_TEXT: Record<FailureKind, { title: string; body: string }> = {
  down: { title: 'rsheetErrDownTitle', body: 'rsheetBridgeHowTo' },
  printer: { title: 'rsheetErrPrinterTitle', body: 'rsheetErrPrinterBody' },
  busy: { title: 'rsheetErrBusyTitle', body: 'rsheetErrBusyBody' },
  cancelled: { title: 'rsheetErrCancelledTitle', body: 'rsheetErrCancelledBody' },
  none: { title: 'rsheetErrNoneTitle', body: 'rsheetNoneFound' },
  image: { title: 'rsheetErrImageTitle', body: 'rsheetImageFailed' },
};

function FailureCard({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const { t } = useT();
  const text = FAILURE_TEXT[failure.kind];
  const quiet = failure.kind === 'cancelled';
  return (
    <div className={`rsheet-error${quiet ? ' is-quiet' : ''}`} role="alert">
      <span className="rsheet-error-icon" aria-hidden>{quiet ? '■' : '!'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="rsheet-error-title">{t(text.title)}</div>
        <div className="rsheet-error-body">{t(text.body)}</div>
        {failure.detail && failure.kind === 'printer' && (
          <div className="rsheet-error-body mono">{t('rsheetErrDetail', { msg: failure.detail })}</div>
        )}
      </div>
      <button type="button" className="btn sm" onClick={onRetry}>
        {quiet ? t('rsheetRescan') : t('rsheetRetry')}
      </button>
    </div>
  );
}

function BridgeChip({ health, onRecheck }: { health: BridgeHealth | null | 'checking'; onRecheck: () => void }) {
  const { t } = useT();
  if (health === 'checking') return <span className="chip muted">{t('rsheetBridgeChecking')}</span>;
  if (health === null) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="chip warn">{t('rsheetBridgeDown')}</span>
        <button type="button" className="btn sm ghost" onClick={onRecheck}>{t('rsheetRecheck')}</button>
      </span>
    );
  }
  if (health.scanner.error) {
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="chip warn" title={health.scanner.error}>{t('rsheetPrinterDown')}</span>
        <button type="button" className="btn sm ghost" onClick={onRecheck}>{t('rsheetRecheck')}</button>
      </span>
    );
  }
  return <span className="chip pos">{t('rsheetBridgeReady', { state: health.scanner.state ?? '' })}</span>;
}

// The page with a numbered outline per detected stick, so a wrong split
// (two sticks as one, a stick missed) is visible at a glance. Each outline
// pulses while its label is read and settles to ✓ or ! with the result.
function SheetPreview({
  sheet, rows, onZoomSheet, onZoomStick,
}: {
  sheet: Sheet;
  rows: Row[];
  onZoomSheet: () => void;
  onZoomStick: (r: Row) => void;
}) {
  const { t } = useT();
  const w = 180;
  const h = Math.round((w * sheet.height) / sheet.width);
  return (
    <div className="rsheet-page" style={{ width: w, height: h, aspectRatio: 'auto' }}>
      <button type="button" className="rsheet-zoom" onClick={onZoomSheet} aria-label={t('rsheetZoomSheet')} title={t('rsheetZoomSheet')}>
        <img src={sheet.url} alt="" style={{ width: w, height: h, display: 'block' }} />
      </button>
      {rows.map(r => {
        const state = r.status === 'reading' ? 'is-reading'
          : r.status === 'error' ? 'is-error'
          : r.box.maybeMerged ? 'is-warn'
          : 'is-done';
        return (
          <button
            type="button"
            key={r.id}
            className={`rsheet-box ${state}`}
            onClick={() => onZoomStick(r)}
            aria-label={t('rsheetZoomStick', { n: r.id + 1 })}
            title={t('rsheetZoomStick', { n: r.id + 1 })}
            style={{
              left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%`,
              width: `${r.box.w * 100}%`, height: `${r.box.h * 100}%`,
            }}
          >
            <span className="rsheet-box-tag">{r.id + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function StickRow({
  row: r, lang, onToggle, onQty, onCost, onRetry, onZoom,
}: {
  row: Row;
  lang: string;
  onToggle: () => void;
  onQty: (v: string) => void;
  onCost: (v: string) => void;
  onRetry: () => void;
  onZoom: () => void;
}) {
  const { t } = useT();
  const f = r.scan?.extracted ?? {};
  const conf = r.scan?.confidence ?? 0;
  const missing = r.scan ? missingRamFields(f) : [];
  const specs = [f.brand, f.capacity, f.generation, f.classification, f.rank, f.speed && `${f.speed}`]
    .filter(Boolean).join(' · ');
  return (
    <tr style={{ opacity: r.include || r.status === 'reading' ? 1 : 0.5, verticalAlign: 'top' }}>
      <td>
        <input type="checkbox" checked={r.include} disabled={r.status !== 'done'} onChange={onToggle} aria-label={t('rsheetStick', { n: r.id + 1 })} />
      </td>
      <td>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span className="chip mono" style={{ flexShrink: 0 }}>{r.id + 1}</span>
          <button
            type="button"
            className="rsheet-zoom rsheet-thumb"
            onClick={onZoom}
            aria-label={t('rsheetZoomStick', { n: r.id + 1 })}
            title={t('rsheetZoomStick', { n: r.id + 1 })}
          >
            <img src={r.cropUrl} alt={t('rsheetStick', { n: r.id + 1 })} />
          </button>
          <div style={{ minWidth: 0, flex: 1, fontSize: 12, display: 'grid', gap: 3 }}>
            {r.status === 'reading' && (
              <div className="rsheet-skel" aria-label={t('rsheetReadingOne')}>
                <span className="skeleton" style={{ width: '80%' }} />
                <span className="skeleton" style={{ width: '55%' }} />
                <span className="skeleton" style={{ width: '30%' }} />
              </div>
            )}
            {r.status === 'error' && (
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="chip neg" style={{ whiteSpace: 'normal', height: 'auto' }}>{r.error}</span>
                <button type="button" className="btn sm" onClick={onRetry}>{t('rsheetRetry')}</button>
              </span>
            )}
            {r.status === 'done' && (
              <>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{specs || '—'}</div>
                <div className="mono">{f.partNumber ?? '—'}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <ConfidenceChip scan={r.scan!} conf={conf} />
                  {missing.length > 0 && (
                    <span className="chip warn">
                      {t('rsheetStillNeeds', { fields: missing.map(k => t(k)).join(lang === 'zh' ? '、' : ', ') })}
                    </span>
                  )}
                </div>
              </>
            )}
            {r.box.maybeMerged && <span className="chip warn" style={{ whiteSpace: 'normal', height: 'auto' }}>{t('rsheetMaybeMerged')}</span>}
          </div>
        </div>
      </td>
      <td className="num">
        <input className="input mono" style={{ width: 56, textAlign: 'right' }} inputMode="numeric" value={r.qty} onChange={e => onQty(e.target.value)} disabled={!r.include} />
      </td>
      <td className="num">
        <input className="input mono" style={{ width: 86, textAlign: 'right' }} inputMode="decimal" value={r.unitCost} onChange={e => onCost(e.target.value)} disabled={!r.include} placeholder="0.00" />
      </td>
    </tr>
  );
}

function ConfidenceChip({ scan, conf }: { scan: ScanResponse; conf: number }) {
  const { t } = useT();
  if (scan.provider === 'stub') return <span className="chip warn">{t('rsheetStub')}</span>;
  const pct = Math.round(conf * 100);
  const cls = conf < AI_UNREADABLE_FLOOR ? 'neg' : conf < AI_CONFIDENCE_FLOOR ? 'warn' : 'pos';
  return <span className={`chip ${cls}`}>{t('rsheetConfidence', { pct })}</span>;
}
