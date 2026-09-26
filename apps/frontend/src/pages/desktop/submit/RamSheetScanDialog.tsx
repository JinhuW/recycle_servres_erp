import { useCallback, useEffect, useRef, useState } from 'react';
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
import { buildRamLinePatches, runPool, withRateLimitRetry } from './ramSheet';

// "Scan RAM sheet" (RS-109): one flatbed page of several sticks → one crop per
// stick → the existing /api/scan/label RAM pipeline per crop → reviewed rows
// → RAM lines on the PO. The page comes from the local scanner bridge or an
// uploaded image; the split runs here in the browser.

// Three labels in flight keeps a 10-stick sheet to a few seconds without
// tripping the 20-a-minute scan limit on a normal sheet.
const READ_CONCURRENCY = 3;

type Phase = 'idle' | 'scanning' | 'splitting' | 'review';

type Row = {
  id: number;
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

export function RamSheetScanDialog({
  onClose,
  onAddLines,
}: {
  onClose: () => void;
  onAddLines: (patches: Partial<Line>[]) => void;
}) {
  const { t, lang } = useT();
  const [health, setHealth] = useState<BridgeHealth | null | 'checking'>('checking');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ url: string; width: number; height: number } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [costAll, setCostAll] = useState('');
  const [combine, setCombine] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Object URLs made for this dialog, revoked on unmount — a rescan replaces
  // the rows but the old thumbnails may still be painting.
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(u => URL.revokeObjectURL(u)), []);
  const objectUrl = (b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.current.push(u);
    return u;
  };

  const checkBridge = useCallback(() => {
    setHealth('checking');
    void bridgeHealth().then(setHealth);
  }, []);
  useEffect(checkBridge, [checkBridge]);

  const patchRow = (id: number, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const readLabel = async (row: Pick<Row, 'id' | 'crop' | 'box'>) => {
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

  const processSheet = async (page: Blob) => {
    setError(null);
    setPhase('splitting');
    try {
      const split = await splitSheet(page);
      setSheet({ url: objectUrl(page), width: split.width, height: split.height });
      if (!split.crops.length) {
        setRows([]);
        setError(t('rsheetNoneFound'));
        setPhase('idle');
        return;
      }
      const fresh: Row[] = split.crops.map((c, i) => ({
        id: i,
        box: c.box,
        crop: c.blob,
        cropUrl: objectUrl(c.blob),
        status: 'reading',
        include: !c.box.maybeMerged,
        qty: '1',
        unitCost: costAll,
      }));
      setRows(fresh);
      setPhase('review');
      await runPool(fresh.map(r => () => readLabel(r)), READ_CONCURRENCY);
    } catch (e) {
      console.error('[ram-sheet] split failed', e);
      setError(t('rsheetImageFailed'));
      setPhase('idle');
    }
  };

  const scanFromPrinter = async () => {
    setError(null);
    setPhase('scanning');
    try {
      const page = await bridgeScan();
      await processSheet(page);
    } catch (e) {
      setPhase('idle');
      if (e instanceof BridgeError && e.status === 0) {
        setHealth(null);
        setError(t('rsheetBridgeDown'));
      } else {
        setError(t('rsheetScanFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    }
  };

  const takeFiles = (files: File[]) => {
    const f = files.find(x => x.type.startsWith('image/'));
    if (f) void processSheet(f);
    else if (files.length) setError(t('aiOnlyImages'));
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

  const busy = phase === 'scanning' || phase === 'splitting';
  const bridgeUp = health !== 'checking' && health !== null;

  return (
    <Modal onClose={onClose} shellStyle={{ maxWidth: 980, width: 'calc(100vw - 80px)' }} ariaLabel={t('rsheetTitle')}>
      <div className="modal-head" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="modal-title">{t('rsheetTitle')}</div>
        <BridgeChip health={health} onRecheck={checkBridge} />
      </div>

      <div className="modal-body" style={{ padding: 20, maxHeight: '68vh', overflowY: 'auto' }}>
        {health === null && (
          <div className="field-hint" style={{ marginBottom: 12 }}>{t('rsheetBridgeHowTo')}</div>
        )}

        <div
          className={`ai-dropzone${dragOver ? ' drag' : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 14 }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (!busy) takeFiles(Array.from(e.dataTransfer.files)); }}
        >
          <button
            type="button"
            className="btn accent"
            disabled={busy || !bridgeUp}
            onClick={() => void scanFromPrinter()}
          >
            {rows.length ? t('rsheetRescan') : t('rsheetScanPrinter')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
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
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {phase === 'scanning' ? t('rsheetScanning')
              : phase === 'splitting' ? t('rsheetSplitting')
              : reading ? t('rsheetReading', { done: rows.length - reading, total: rows.length })
              : t('rsheetHint')}
          </span>
        </div>

        {error && (
          <div className="chip neg" style={{ marginTop: 12, whiteSpace: 'normal', height: 'auto', padding: '6px 10px' }}>
            {error}
          </div>
        )}

        {sheet && rows.length > 0 && (
          <div style={{ display: 'flex', gap: 16, marginTop: 16, alignItems: 'flex-start' }}>
            <SheetPreview sheet={sheet} rows={rows} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {t('rsheetFound', { n: rows.length })}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>{t('item')}</th>
                    <th className="num" style={{ width: 70 }}>{t('qty')}</th>
                    <th className="num" style={{ width: 100 }}>{t('unitCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <StickRow
                      key={r.id}
                      row={r}
                      lang={lang}
                      onToggle={() => patchRow(r.id, { include: !r.include })}
                      onQty={v => patchRow(r.id, { qty: v })}
                      onCost={v => patchRow(r.id, { unitCost: v })}
                      onRetry={() => void readLabel(r)}
                    />
                  ))}
                </tbody>
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
    </Modal>
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
// (two sticks as one, a stick missed) is visible at a glance.
function SheetPreview({ sheet, rows }: { sheet: { url: string; width: number; height: number }; rows: Row[] }) {
  const w = 180;
  const h = Math.round((w * sheet.height) / sheet.width);
  return (
    <div style={{ position: 'relative', width: w, height: h, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <img src={sheet.url} alt="" style={{ width: w, height: h, display: 'block' }} />
      {rows.map(r => (
        <div
          key={r.id}
          style={{
            position: 'absolute',
            left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%`,
            width: `${r.box.w * 100}%`, height: `${r.box.h * 100}%`,
            border: `2px solid ${r.box.maybeMerged ? 'var(--warn, #d97706)' : 'var(--accent, #2563eb)'}`,
            borderRadius: 2,
          }}
        >
          <span style={{
            position: 'absolute', top: -1, left: -1, fontSize: 10, fontWeight: 700, lineHeight: '14px',
            padding: '0 4px', color: '#fff', background: r.box.maybeMerged ? 'var(--warn, #d97706)' : 'var(--accent, #2563eb)',
          }}>{r.id + 1}</span>
        </div>
      ))}
    </div>
  );
}

function StickRow({
  row: r, lang, onToggle, onQty, onCost, onRetry,
}: {
  row: Row;
  lang: string;
  onToggle: () => void;
  onQty: (v: string) => void;
  onCost: (v: string) => void;
  onRetry: () => void;
}) {
  const { t } = useT();
  const f = r.scan?.extracted ?? {};
  const conf = r.scan?.confidence ?? 0;
  const missing = r.scan ? missingRamFields(f) : [];
  const specs = [f.brand, f.capacity, f.generation, f.classification, f.rank, f.speed && `${f.speed}`]
    .filter(Boolean).join(' · ');
  return (
    <tr style={{ opacity: r.include ? 1 : 0.5, verticalAlign: 'top' }}>
      <td>
        <input type="checkbox" checked={r.include} disabled={r.status !== 'done'} onChange={onToggle} aria-label={t('rsheetStick', { n: r.id + 1 })} />
      </td>
      <td>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span className="chip mono" style={{ flexShrink: 0 }}>{r.id + 1}</span>
          <img src={r.cropUrl} alt={t('rsheetStick', { n: r.id + 1 })} style={{ width: 200, maxHeight: 70, objectFit: 'contain', borderRadius: 3, background: 'var(--bg-sunken, #f4f4f5)', flexShrink: 0 }} />
          <div style={{ minWidth: 0, fontSize: 12, display: 'grid', gap: 3 }}>
            {r.status === 'reading' && <span className="ai-dot" style={{ color: 'var(--fg-subtle)' }}>{t('rsheetReadingOne')}</span>}
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
