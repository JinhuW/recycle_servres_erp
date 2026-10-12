import { useEffect, useMemo, useRef } from 'react';
import {
  canonicalPartNumber, decodeRamPart, ramPartDecodesAsWritten, ramPartFill, ramPartMismatches, ramPartReadingsMatching,
  splitRamPartFamily, RAM_PART_FIELDS,
  type RamPartDecode, type RamPartField, type RamPartMismatch, type RamPartSpec, type RamScanCheck,
} from '@recycle-erp/shared';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useT } from '../lib/i18n';

// What the part number says about a RAM line, shown under the Part # field
// in both shells, and the confirm-time question when it disagrees with the
// form. Decoding is local (shared/ramPartDecode.ts), so nothing here waits on
// the network.

export type RamPartLine = Partial<Record<RamPartField | 'partNumber' | 'category', string | null | undefined>>;

export const RAM_PART_LABEL_KEY: Readonly<Record<RamPartField, string>> = {
  brand: 'brand', capacity: 'capacity', generation: 'generation', type: 'type',
  classification: 'klass', rank: 'rank', speed: 'speedMhz',
};

/** The decode, its disagreements with the line, and readings that would agree. */
export function ramPartCheck(line: RamPartLine): {
  decode: RamPartDecode | null;
  mismatches: RamPartMismatch[];
  readings: string[];
} {
  if (line.category !== 'RAM') return { decode: null, mismatches: [], readings: [] };
  const decode = decodeRamPart(line.partNumber);
  const mismatches = ramPartMismatches(decode, line);
  const readings = mismatches.length ? ramPartReadingsMatching(line.partNumber, line) : [];
  return { decode, mismatches, readings };
}

/** One-line summary in the order a label prints it: `Samsung 16GB DDR4 · Server · RDIMM · 1Rx4 · 2400`. */
export function ramPartSummary(spec: RamPartSpec): string {
  const head = [spec.brand, spec.capacity, spec.generation].filter(Boolean).join(' ');
  const tail = [spec.type, spec.classification, spec.rank, spec.speed].filter(Boolean);
  return [head, ...tail].filter(Boolean).join(' · ');
}

/** Signature of a set of mismatches, so "keep mine" covers exactly what was shown. */
export function mismatchKey(line: RamPartLine, mismatches: RamPartMismatch[]): string {
  return canonicalPartNumber(line.partNumber) + '|' + mismatches.map(m => `${m.field}=${m.lineSays}`).join(',');
}

/** The patch that makes the line agree with its part number. */
export function ramPartPatch(mismatches: RamPartMismatch[]): RamPartSpec {
  return Object.fromEntries(mismatches.map(m => [m.field, m.partSays]));
}

const DEBOUNCE_MS = 300;

/**
 * Fills a RAM line's blank specs from its part number as it is typed or
 * scanned. Same rules as useChipFill: the part # the line opened with never
 * fills (an untouched submitted line must not turn dirty), and only blanks —
 * or values this hook itself wrote — are ever written, so a value the user
 * picked or the scan read is left for the mismatch check to question.
 */
export function useRamPartFill(
  line: RamPartLine,
  { enabled, onFill, savedPartNumber = line.partNumber }: {
    enabled: boolean;
    onFill: (patch: RamPartSpec) => void;
    savedPartNumber?: string | null;
  },
): { forgetFills: () => void } {
  const mem = useRef({
    mountPart: canonicalPartNumber(savedPartNumber ?? ''),
    filled: {} as RamPartSpec,
  });
  const lineRef = useRef(line);
  lineRef.current = line;
  const onFillRef = useRef(onFill);
  onFillRef.current = onFill;
  const canon = canonicalPartNumber(line.partNumber ?? '');
  const active = enabled && line.category === 'RAM' && canon !== '' && canon !== mem.current.mountPart;

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const cur = lineRef.current;
      const own = mem.current.filled;
      // A field still holding this hook's earlier fill counts as blank, so a
      // pause on a half-typed part # corrects itself as typing goes on.
      const asBlank: RamPartLine = { ...cur };
      for (const f of RAM_PART_FIELDS) {
        if (own[f] && (cur[f] ?? '') === own[f]) asBlank[f] = '';
      }
      // Read only through a look-alike, the part # may be a scheme the decoder
      // doesn't know: the readout offers the reading, but nothing fills from it.
      const decode = ramPartDecodesAsWritten(cur.partNumber) ? decodeRamPart(cur.partNumber) : null;
      const fill = ramPartFill(decode, asBlank);
      const patch: RamPartSpec = { ...fill };
      for (const f of RAM_PART_FIELDS) {
        if (own[f] && (cur[f] ?? '') === own[f] && !fill[f]) patch[f] = '';
      }
      mem.current.filled = fill;
      const changed = RAM_PART_FIELDS.some(f => f in patch && (cur[f] ?? '') !== patch[f]);
      if (changed) onFillRef.current(patch);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, canon]);

  // A scan that lands on the line owns every value it wrote, even one equal
  // to an earlier fill: the next part # must not take it back.
  return { forgetFills: () => { mem.current.filled = {}; } };
}

/**
 * The part number with its decoded family marked, what it decodes to, and —
 * when the form disagrees — the fields in question with a one-click fix.
 */
export function RamPartReadout({
  line, onUse, onUsePart, disabled,
}: {
  line: RamPartLine;
  onUse: (patch: RamPartSpec) => void;
  onUsePart: (partNumber: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const { decode, mismatches, readings } = useMemo(() => ramPartCheck(line), [
    line.category, line.partNumber, line.brand, line.capacity, line.generation,
    line.type, line.classification, line.rank, line.speed,
  ]);
  if (!decode) return null;
  const raw = decode.readAs ?? (line.partNumber ?? '').trim();
  const [family, rest] = splitRamPartFamily(raw, decode.familyLength);
  return (
    <div className={'rp-readout' + (mismatches.length ? ' is-mismatch' : '')} role="status">
      <div className="rp-head">
        <Icon name={mismatches.length ? 'alert' : 'check'} size={12} />
        <span className="rp-pn mono"><mark>{family}</mark>{rest}</span>
        <span className="rp-sum">{ramPartSummary(decode.spec)}</span>
      </div>
      {decode.readAs && (
        <div className="rp-reading">
          <span className="rp-note">{t('rpReadAs', { pn: decode.readAs })}</span>
          <button type="button" className="btn sm" disabled={disabled} onClick={() => onUsePart(decode.readAs!)}>
            {t('rpUsePart')}
          </button>
        </div>
      )}
      {mismatches.length > 0 && (
        <MismatchList mismatches={mismatches} onUse={onUse} disabled={disabled} />
      )}
      {readings.length > 0 && (
        <ReadingList readings={readings} onUsePart={onUsePart} disabled={disabled} />
      )}
    </div>
  );
}

function MismatchList({ mismatches, onUse, disabled, useAll = true }: {
  mismatches: RamPartMismatch[];
  onUse: (patch: RamPartSpec) => void;
  disabled?: boolean;
  /** Off where a footer already carries the same action. */
  useAll?: boolean;
}) {
  const { t } = useT();
  return (
    <>
      <div className="rp-note">{t('rpMismatchLead')}</div>
      <table className="rp-table">
        <thead>
          <tr><th />{/* field */}<th>{t('rpFormSays')}</th><th>{t('rpPartSays')}</th><th /></tr>
        </thead>
        <tbody>
          {mismatches.map(m => (
            <tr key={m.field}>
              <td>{t(RAM_PART_LABEL_KEY[m.field])}</td>
              <td className="mono rp-bad">{m.lineSays}</td>
              <td className="mono">{m.partSays}</td>
              <td>
                <button type="button" className="btn sm" disabled={disabled} onClick={() => onUse({ [m.field]: m.partSays })}>
                  {t('rpUse')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {useAll && mismatches.length > 1 && (
        <button type="button" className="btn sm" disabled={disabled} onClick={() => onUse(ramPartPatch(mismatches))}>
          {t('rpUseAll')}
        </button>
      )}
    </>
  );
}

function ReadingList({ readings, onUsePart, disabled }: {
  readings: string[];
  onUsePart: (pn: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="rp-readings">
      <div className="rp-note">{t('rpMaybeMisread')}</div>
      {readings.map(r => (
        <div key={r} className="rp-reading">
          <span className="mono">{r}</span>
          <button type="button" className="btn sm" disabled={disabled} onClick={() => onUsePart(r)}>
            {t('rpUsePart')}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Asked on Confirm when the part number contradicts the form. Either side may
 * be the misread one, so both stay possible: take the part #'s values, take
 * a corrected part #, or keep the form as entered.
 */
export function RamPartMismatchDialog({
  line, onUse, onUsePart, onKeep, onCancel,
}: {
  line: RamPartLine;
  onUse: (patch: RamPartSpec) => void;
  onUsePart: (partNumber: string) => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const { decode, mismatches, readings } = ramPartCheck(line);
  return (
    <Modal onClose={onCancel} shellStyle={{ maxWidth: 460 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('rpDialogTitle')}</div>
          <div className="modal-sub">{t('rpDialogSub')}</div>
        </div>
        <button className="btn ghost sm" onClick={onCancel} aria-label={t('cancel')} title={t('cancel')}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="modal-body rp-dialog">
        {decode && (
          <div className="rp-head">
            <span className="rp-pn mono">{(line.partNumber ?? '').trim()}</span>
            <span className="rp-sum">{ramPartSummary(decode.spec)}</span>
          </div>
        )}
        <MismatchList mismatches={mismatches} onUse={onUse} useAll={false} />
        {readings.length > 0 && <ReadingList readings={readings} onUsePart={onUsePart} />}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onKeep}>{t('rpKeepMine')}</button>
        <button className="btn accent" onClick={() => onUse(ramPartPatch(mismatches))}>{t('rpUseAll')}</button>
      </div>
    </Modal>
  );
}

/**
 * What the label-scan cross-check did (shared/reconcileRamScan): a part #
 * corrected to the reading the printed specs agree with, blanks filled from
 * it, or a contradiction neither side can settle — which asks for a second
 * photo, since the next read usually lands differently on the misread glyph.
 */
export function ScanPartNotice({ check, onRetake }: {
  check: RamScanCheck | null | undefined;
  onRetake?: () => void;
}) {
  const { t } = useT();
  if (!check) return null;
  const names = (fs: RamPartField[]) => fs.map(f => t(RAM_PART_LABEL_KEY[f])).join(', ');
  const conflict = check.conflicts.length > 0;
  const lines: string[] = [];
  if (conflict) lines.push(t('rpScanConflict', { fields: names(check.conflicts.map(m => m.field)) }));
  if (check.partCorrected) lines.push(t('rpScanCorrected', check.partCorrected));
  if (check.filled.length) lines.push(t('rpScanFilled', { fields: names(check.filled) }));
  if (!lines.length) return null;
  return (
    <div className={'rp-scan' + (conflict ? ' is-conflict' : '')} role={conflict ? 'alert' : 'status'}>
      <Icon name={conflict ? 'alert' : 'sparkles'} size={13} />
      <div className="rp-scan-body">
        {lines.map(l => <div key={l}>{l}</div>)}
        {conflict && onRetake && (
          <button type="button" className="btn sm" onClick={onRetake}>
            <Icon name="camera" size={12} /> {t('retakePhoto')}
          </button>
        )}
      </div>
    </div>
  );
}
