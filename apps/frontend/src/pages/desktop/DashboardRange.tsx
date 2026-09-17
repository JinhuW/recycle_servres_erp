import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  RANGE_PRESETS, addDays, addMonths, diffDays, startOfMonth, resolvePreset,
  type IsoDate, type RangePreset,
} from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useElementWidth } from '../../lib/useElementWidth';

// The dashboard's reporting window, chosen two ways that write the same value:
// a chip with presets and custom dates, and a strip of months you drag across.

export type RangeValue = { from: IsoDate; to: IsoDate; preset: RangePreset | 'custom' };

const PRESET_KEY: Record<RangePreset, string> = {
  '7d': 'rangeLast7d', '30d': 'rangeLast30d', '90d': 'rangeLast90d',
  'mtd': 'rangeMtd', 'ytd': 'rangeYtd', '12m': 'range12m', 'all': 'rangeAll',
};

const utc = (d: IsoDate) => new Date(d + 'T00:00:00Z');

/** "Feb 1 – Sep 17", with the year on whichever end is not this year. */
export function fmtRange(from: IsoDate, to: IsoDate, today: IsoDate, locale: string): string {
  const day = (d: IsoDate) => new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(d.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  }).format(utc(d));
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}

function fmtDay(d: IsoDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(utc(d));
}

// ── Chip + presets ──────────────────────────────────────────────────────────

export function RangeChip({ value, today, first, locale, onChange }: {
  value: RangeValue; today: IsoDate; first: IsoDate | null; locale: string;
  onChange: (v: RangeValue) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const wrap = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);

  useEffect(() => { setFrom(value.from); setTo(value.to); }, [value.from, value.to]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); chip.current?.focus(); }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (key: RangePreset) => {
    onChange({ ...resolvePreset(key, today, first), preset: key });
    setOpen(false);
    chip.current?.focus();
  };
  const customValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to && to <= today;
  const apply = () => {
    if (!customValid) return;
    onChange({ from, to, preset: 'custom' });
    setOpen(false);
    chip.current?.focus();
  };

  return (
    <div className="dash-range-wrap" ref={wrap}>
      <button
        ref={chip}
        type="button"
        className="dash-range-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('rangeChipAriaLabel')}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="calendar" size={14} />
        <span className="dash-range-chip-label">{fmtRange(value.from, value.to, today, locale)}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="dash-range-pop" role="menu">
          {RANGE_PRESETS.map(key => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={value.preset === key}
              className="dash-range-pop-row"
              onClick={() => pick(key)}
            >
              <span>{t(PRESET_KEY[key])}</span>
              {value.preset === key && <Icon name="check" size={14} className="dash-range-check" />}
            </button>
          ))}
          <div className="dash-range-pop-custom">
            <label>
              {t('rangeFrom')}
              <input type="date" className="input" value={from} max={to} onChange={e => setFrom(e.target.value)} />
            </label>
            <label>
              {t('rangeTo')}
              <input type="date" className="input" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} />
            </label>
            <button type="button" className="btn primary" disabled={!customValid} onClick={apply}>
              {t('rangeApply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Brush ───────────────────────────────────────────────────────────────────

// Rows, top to bottom: year, the band's label chip, month names, ticks. The
// band covers the last three so the chip sits inside it, above the months.
const H = 66;
const PAD_L = 4;
const PAD_R = 4;
const BAND_TOP = 18;
const BAND_BOTTOM = 66;
const MONTH_Y = 52;
const HANDLE_W = 5;
const HANDLE_H = 22;
const HANDLE_Y = 31;

type Drag =
  | { kind: 'new'; anchor: number }
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'move'; offset: number; len: number };

export function RangeBrush({ value, today, first, locale, onChange }: {
  value: RangeValue; today: IsoDate; first: IsoDate | null; locale: string;
  onChange: (v: RangeValue) => void;
}) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);

  // At least twelve months, further back when the data reaches further; the
  // right edge is the end of today.
  const domainStart = useMemo(() => {
    const yearBack = addMonths(startOfMonth(today), -11);
    return startOfMonth(first && first < yearBack ? first : yearBack);
  }, [today, first]);
  const domainEnd = addDays(today, 1);
  const totalDays = diffDays(domainStart, domainEnd);
  const innerW = Math.max(0, width - PAD_L - PAD_R);
  const xOf = (d: IsoDate) => PAD_L + (diffDays(domainStart, d) / totalDays) * innerW;
  const xOfIdx = (i: number) => PAD_L + (i / totalDays) * innerW;

  // The selection as day indexes into the domain, end exclusive.
  const committed = useMemo(() => ({
    a: Math.max(0, diffDays(domainStart, value.from)),
    b: Math.min(totalDays, diffDays(domainStart, value.to) + 1),
  }), [domainStart, totalDays, value.from, value.to]);
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const sel = draft ?? committed;

  const idxAt = (clientX: number, mode: 'floor' | 'round') => {
    const rect = wrap.current!.getBoundingClientRect();
    const raw = ((clientX - rect.left - PAD_L) / innerW) * totalDays;
    const i = mode === 'floor' ? Math.floor(raw) : Math.round(raw);
    return Math.max(0, Math.min(totalDays, i));
  };

  const onDown = (e: PointerEvent<SVGElement>) => {
    if (e.button !== 0 || innerW === 0) return;
    const target = e.target as SVGElement;
    const role = target.dataset.brush;
    let next: Drag;
    if (role === 'start') next = { kind: 'start' };
    else if (role === 'end') next = { kind: 'end' };
    else if (role === 'band') {
      next = { kind: 'move', offset: idxAt(e.clientX, 'floor') - sel.a, len: sel.b - sel.a };
    } else {
      const anchor = Math.min(totalDays - 1, idxAt(e.clientX, 'floor'));
      next = { kind: 'new', anchor };
      setDraft({ a: anchor, b: anchor + 1 });
    }
    setDrag(next);
    // A synthetic pointer (tests, automation) has no capture to take.
    try { (e.currentTarget as SVGElement).setPointerCapture(e.pointerId); } catch { /* fine */ }
    e.preventDefault();
  };

  const onMove = (e: PointerEvent<SVGElement>) => {
    if (!drag) return;
    const cur = sel;
    if (drag.kind === 'new') {
      const i = Math.min(totalDays - 1, idxAt(e.clientX, 'floor'));
      setDraft({ a: Math.min(drag.anchor, i), b: Math.max(drag.anchor, i) + 1 });
    } else if (drag.kind === 'start') {
      setDraft({ a: Math.min(idxAt(e.clientX, 'round'), cur.b - 1), b: cur.b });
    } else if (drag.kind === 'end') {
      setDraft({ a: cur.a, b: Math.max(idxAt(e.clientX, 'round'), cur.a + 1) });
    } else {
      const a = Math.max(0, Math.min(totalDays - drag.len, idxAt(e.clientX, 'floor') - drag.offset));
      setDraft({ a, b: a + drag.len });
    }
  };

  const onUp = () => {
    if (!drag) return;
    const d = draft;
    setDrag(null);
    setDraft(null);
    if (d && (d.a !== committed.a || d.b !== committed.b)) {
      onChange({ from: addDays(domainStart, d.a), to: addDays(domainStart, d.b - 1), preset: 'custom' });
    }
  };

  const nudge = (edge: 'start' | 'end') => (e: KeyboardEvent<SVGElement>) => {
    let { a, b } = committed;
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (edge === 'start') {
      if (e.key === 'Home') a = 0;
      else if (e.key === 'End') a = b - 1;
      else if (step) a = Math.max(0, Math.min(b - 1, a + step));
      else return;
    } else {
      if (e.key === 'Home') b = a + 1;
      else if (e.key === 'End') b = totalDays;
      else if (step) b = Math.max(a + 1, Math.min(totalDays, b + step));
      else return;
    }
    e.preventDefault();
    onChange({ from: addDays(domainStart, a), to: addDays(domainStart, b - 1), preset: 'custom' });
  };

  // Month cells across the domain.
  const months = useMemo(() => {
    const out: { start: IsoDate; end: IsoDate; label: string; year: string | null }[] = [];
    const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    let m = domainStart;
    while (m < domainEnd) {
      const next = addMonths(m, 1);
      const end = next < domainEnd ? next : domainEnd;
      const isJan = m.slice(5, 7) === '01';
      out.push({
        start: m, end, label: monthFmt.format(utc(m)),
        year: isJan || m === domainStart ? m.slice(0, 4) : null,
      });
      m = next;
    }
    return out;
  }, [domainStart, domainEnd, locale]);

  const pxPerDay = innerW / Math.max(1, totalDays);
  const dayTicks = pxPerDay >= 2.5
    ? Array.from({ length: totalDays + 1 }, (_, i) => i)
    : [];

  const from = addDays(domainStart, sel.a);
  const to = addDays(domainStart, sel.b - 1);
  const xA = xOfIdx(sel.a);
  const xB = xOfIdx(sel.b);
  const tip = drag?.kind === 'start' ? { x: xA, text: fmtDay(from, locale) }
    : drag?.kind === 'end' ? { x: xB, text: fmtDay(to, locale) }
    : drag ? { x: (xA + xB) / 2, text: fmtRange(from, to, today, locale) }
    : null;

  return (
    <div className="dash-brush" ref={wrap}>
      <svg
        viewBox={`0 0 ${Math.max(1, width)} ${H}`}
        width={Math.max(1, width)}
        height={H}
        role="group"
        aria-label={t('rangeBrushAriaLabel')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <rect className="dash-brush-track" x={0} y={0} width={Math.max(1, width)} height={H} />
        <line className="dash-brush-baseline" x1={PAD_L} x2={PAD_L + innerW} y1={H - 0.5} y2={H - 0.5} />
        {dayTicks.map(i => (
          <line key={i} className="dash-brush-tick" x1={xOfIdx(i)} x2={xOfIdx(i)} y1={H - 4} y2={H} />
        ))}
        {months.map(m => {
          const x0 = xOf(m.start), x1 = xOf(m.end);
          const selected = m.start < to && m.end > from;
          return (
            <g key={m.start}>
              <line className="dash-brush-tick is-month" x1={x0} x2={x0} y1={H - 12} y2={H} />
              {m.year && <text className="dash-brush-year" x={x0 + 3} y={12}>{m.year}</text>}
              {x1 - x0 > 26 && (
                <text className={'dash-brush-month' + (selected ? ' is-selected' : '')}
                      x={(x0 + x1) / 2} y={MONTH_Y} textAnchor="middle">{m.label}</text>
              )}
            </g>
          );
        })}
        <line className="dash-brush-today" x1={PAD_L + innerW} x2={PAD_L + innerW} y1={H - 14} y2={H}>
          <title>{t('rangeToday')}</title>
        </line>
        <rect
          className={'dash-brush-band' + (drag ? ' is-dragging' : '')}
          data-brush="band"
          x={xA} y={BAND_TOP} width={Math.max(0, xB - xA)} height={BAND_BOTTOM - BAND_TOP} rx={4}
        />
        <rect
          className="dash-brush-handle" data-brush="start" tabIndex={0}
          role="slider" aria-label={t('rangeStartAriaLabel')} aria-valuetext={from}
          aria-valuemin={0} aria-valuemax={totalDays} aria-valuenow={sel.a}
          x={xA - HANDLE_W / 2} y={HANDLE_Y} width={HANDLE_W} height={HANDLE_H} rx={2.5}
          onKeyDown={nudge('start')}
        />
        <rect
          className="dash-brush-handle" data-brush="end" tabIndex={0}
          role="slider" aria-label={t('rangeEndAriaLabel')} aria-valuetext={to}
          aria-valuemin={0} aria-valuemax={totalDays} aria-valuenow={sel.b}
          x={xB - HANDLE_W / 2} y={HANDLE_Y} width={HANDLE_W} height={HANDLE_H} rx={2.5}
          onKeyDown={nudge('end')}
        />
      </svg>
      {width > 0 && (
        <div
          className={'dash-brush-label' + (xA > width - 150 ? ' is-right' : '')}
          style={xA > width - 150 ? { right: width - xB } : { left: xA }}
        >
          {fmtRange(from, to, today, locale)}
        </div>
      )}
      {tip && <div className="dash-brush-tip" style={{ left: tip.x }}>{tip.text}</div>}
    </div>
  );
}
