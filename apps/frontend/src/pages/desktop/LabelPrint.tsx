import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { showWarnToast } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import {
  labelJob, labelPrinter, PRINTER_DPI, toRaster, useLabelPrinter, type PrinterLanguage, type PrinterStatus, type TsplStock,
} from '../../lib/labelPrinter';
import { usePreference, type PrefMap } from '../../lib/preferences';
import { useEscapeKey } from '../../lib/useEscapeKey';

// The labels the bench pages print: Pack mode one per product of a sell
// order, Review mode one per PO box. A label is drawn once, as a picture. The
// Bluetooth printer gets that picture in dots, and the print dialog, the
// fallback, prints it as an image, so the two can't drift apart.

export type LabelSize = PrefMap['pack.labelSize'];
export type LabelLanguage = PrefMap['pack.labelLanguage'];

// Each stock: width × height in inches as it feeds, its name, and how TSPL
// sizes it, in the stock's own unit with the gap between its labels. 50 × 25
// mm is what the office's 2-inch CLABEL CT221D takes.
export const LABEL_SIZES: Record<LabelSize, { inches: readonly [number, number]; name: string; tspl: TsplStock }> = {
  '50x25mm': { inches: [50 / 25.4, 25 / 25.4], name: '50×25 mm', tspl: { size: '50 mm,25 mm', gap: '2 mm,0 mm' } },
  '4x6': { inches: [4, 6], name: '4×6 in', tspl: { size: '4,6', gap: '0.12,0' } },
  '4x3': { inches: [4, 3], name: '4×3 in', tspl: { size: '4,3', gap: '0.12,0' } },
  '2.25x1.25': { inches: [2.25, 1.25], name: '2.25×1.25 in', tspl: { size: '2.25,1.25', gap: '0.12,0' } },
};

// The label's words, already in the reader's language.
export type LabelText = {
  // What the toast and the dialog call it: "SO-4001 #3", "PO-1520".
  name: string;
  // The top row: the order a product is on, or what the box is.
  top: string;
  date: string;
  // The big line, ruled off: the product's #, or the PO number.
  title: string;
  // Under it: a part number (`mono`, on one line), or the purchaser under
  // its caption.
  caption: string | null;
  body: string;
  mono: boolean;
  counts: readonly { n: number; word: string }[];
};

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const SANS = 'Inter, system-ui, sans-serif';

// Lines of `text` at the context's font that fit `width`, at most `max`; the
// last one ends in … when the rest doesn't fit.
function wrap(g: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= width || !line) { line = next; continue; }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1]!;
  while (last && g.measureText(last + '…').width > width) last = last.slice(0, -1);
  kept[max - 1] = last.trimEnd() + '…';
  return kept;
}

// Black on white: thermal stock dithers anything grey. Sized off the label,
// so one layout reads on every stock. Under 1.6 in tall the date and the
// caption go, and the top row is drawn larger: on a product's label it is
// the order the product is on.
export async function drawLabel(text: LabelText, widthIn: number, heightIn: number, dpi: number): Promise<HTMLCanvasElement> {
  await Promise.all(['800', '700', '600', '500'].flatMap(w => [
    document.fonts.load(`${w} 40px Inter`), document.fonts.load(`${w} 40px "JetBrains Mono"`),
  ])).catch(() => {});
  const W = Math.round(widthIn * dpi);
  const H = Math.round(heightIn * dpi);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#000';
  const m = Math.min(W, H);
  // A 2-inch head is a little narrower than its 50 mm stock.
  const pad = Math.max(0.06 * m, 0.045 * W);
  const inner = W - 2 * pad;
  const small = heightIn < 1.6;
  const size = {
    top: small ? 0.1 * H : Math.min(0.04 * W, 0.05 * H),
    title: Math.min(0.17 * W, 0.22 * H),
    cap: Math.min(0.036 * W, 0.046 * H),
    // Small stock has no caption or date, so its body and counts take the room.
    body: Math.min(0.09 * W, (small ? 0.14 : 0.1) * H),
    count: Math.min(0.06 * W, (small ? 0.1 : 0.07) * H),
  };
  const caps = (px: number) => { g.font = `600 ${px}px ${SANS}`; g.letterSpacing = `${(0.07 * px).toFixed(1)}px`; };
  const plain = () => { g.letterSpacing = '0px'; };
  // A font size at which one line of `s` fits the label's width.
  const fit = (s: string, px: number) => (g.measureText(s).width > inner ? px * inner / g.measureText(s).width : px);

  type Block = { h: number; draw: (top: number) => void };
  const blocks: Block[] = [];

  blocks.push({
    h: size.top * 1.2,
    draw: top => {
      caps(size.top);
      const y = top + size.top;
      const date = small ? '' : text.date.toUpperCase();
      const dateW = g.measureText(date).width;
      g.fillText(date, W - pad - dateW, y);
      g.fillText(wrap(g, text.top.toUpperCase(), date ? inner - dateW - 0.04 * W : inner, 1)[0] ?? '', pad, y);
      plain();
    },
  });

  g.font = `700 ${size.title}px ${MONO}`;
  const titlePx = fit(text.title, size.title);
  const rule = Math.max(2, 0.008 * m);
  blocks.push({
    h: titlePx + 0.025 * m + rule,
    draw: top => {
      g.font = `700 ${titlePx}px ${MONO}`;
      g.fillText(text.title, pad, top + titlePx * 0.86);
      g.fillRect(pad, top + titlePx + 0.025 * m, inner, rule);
    },
  });

  if (text.body) {
    const font = (px: number) => `700 ${px}px ${text.mono ? MONO : SANS}`;
    g.font = font(size.body);
    const bodyPx = text.mono ? fit(text.body, size.body) : size.body;
    const lines = text.mono ? [text.body] : wrap(g, text.body, inner, small ? 1 : 2);
    const capH = small || !text.caption ? 0 : size.cap * 1.2 + 0.01 * m;
    blocks.push({
      h: capH + lines.length * bodyPx * 1.12,
      draw: top => {
        if (capH) {
          caps(size.cap);
          g.fillText(text.caption!.toUpperCase(), pad, top + size.cap);
          plain();
        }
        g.font = font(bodyPx);
        lines.forEach((l, i) => g.fillText(l, pad, top + capH + bodyPx * (0.9 + i * 1.12)));
      },
    });
  }

  if (text.counts.length) {
    const num = size.count * 1.5;
    blocks.push({
      h: num * 1.05,
      draw: top => {
        const y = top + num * 0.85;
        let x = pad;
        for (const { n, word } of text.counts) {
          g.font = `800 ${num}px ${SANS}`;
          g.fillText(String(n), x, y);
          x += g.measureText(String(n)).width + 0.35 * size.count;
          g.font = `500 ${size.count}px ${SANS}`;
          g.fillText(word, x, y);
          x += g.measureText(word).width + 0.05 * W;
        }
      },
    });
  }

  // Spread top to bottom, as the stock is tall or wide.
  const used = blocks.reduce((a, b) => a + b.h, 0);
  const gap = Math.max(0.03 * m, (H - 2 * pad - used) / Math.max(1, blocks.length - 1));
  let y = pad;
  for (const b of blocks) {
    b.draw(y);
    y += b.h + gap;
  }
  return c;
}

// The fallback: the print dialog, for a browser or printer the page can't
// reach. Mounted only to print, and then the only thing printed: the app goes
// out of the flow (`body.printing-label`) and each page is the stock's own
// size, one label to a page, so a label printer feeds no blank one after
// them. Each mount prints the labels it was given once; a later render
// doesn't redraw them.
export function LabelDialog({ texts, size, onDone }: { texts: readonly LabelText[]; size: LabelSize; onDone: () => void }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  const asked = useRef({ texts, size });
  const loaded = useRef(0);
  const [w, h] = LABEL_SIZES[size].inches;

  useEffect(() => {
    let live = true;
    document.body.classList.add('printing-label');
    const after = () => done.current();
    window.addEventListener('afterprint', after);
    const [aw, ah] = LABEL_SIZES[asked.current.size].inches;
    // A laser or inkjet in the dialog is sharper than thermal's 203 dpi.
    void Promise.all(asked.current.texts.map(x => drawLabel(x, aw, ah, 300)))
      .then(cs => { if (live) setUrls(cs.map(c => c.toDataURL('image/png'))); });
    return () => {
      live = false;
      window.removeEventListener('afterprint', after);
      document.body.classList.remove('printing-label');
    };
  }, []);

  // A frame for the last image to lay out before the dialog takes its picture.
  const onLoad = () => {
    if (++loaded.current === urls?.length) requestAnimationFrame(() => window.print());
  };

  return createPortal(
    <div className="pk-label-sheet">
      <style>{`@page { size: ${w}in ${h}in; margin: 0; }`}</style>
      {urls?.map((url, i) => (
        <img
          key={i}
          className="pk-label"
          src={url}
          alt={texts[i]!.name}
          style={{ width: `${w}in`, height: `${h}in` }}
          onLoad={onLoad}
        />
      ))}
    </div>,
    document.body,
  );
}

// A page's label printing: the printer, the saved settings, and a print that
// goes over Bluetooth while a printer is on, else through the dialog. Labels
// asked for while others print wait their turn, so a quick run of scans
// prints every one. The page renders `element`, the dialog's labels while
// they print. Only *Print when …* is the page's own setting; the stock and
// the language belong to the one printer.
export function useLabelPrint(autoKey: 'pack.labelAuto' | 'review.labelAuto', onPrinted: (name: string) => void) {
  const { t } = useT();
  const [auto, setAuto] = usePreference(autoKey, true);
  const [size, setSize] = usePreference('pack.labelSize', '50x25mm');
  const [language, setLanguage] = usePreference('pack.labelLanguage', 'auto');
  const printer = useLabelPrinter();
  // Each request mounts a fresh dialog, which prints once.
  const [dialog, setDialog] = useState<{ n: number; texts: readonly LabelText[]; done: () => void } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Settles once the dialog closes.
  const viaDialog = (texts: readonly LabelText[]) =>
    new Promise<void>(done => setDialog(d => ({ n: (d?.n ?? 0) + 1, texts, done })));

  const send = async (texts: readonly LabelText[]): Promise<void> => {
    const now = labelPrinter.status();
    if (now.state === 'connecting') return;
    if (now.state !== 'on') return viaDialog(texts);
    const lang = language === 'auto' ? now.language : language;
    try {
      // A label sent to a printer out of paper or open is lost.
      const paper = await labelPrinter.check(lang);
      if (paper === 'paper' || paper === 'open' || paper === 'fault') {
        showWarnToast(t('pkLabelNotReady', { state: t('pkPrinterPaper_' + paper) }));
        return;
      }
      const stock = LABEL_SIZES[size];
      for (const text of texts) {
        const canvas = await drawLabel(text, stock.inches[0], stock.inches[1], PRINTER_DPI);
        const dots = toRaster(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height));
        await labelPrinter.print(labelJob(lang, dots, stock.tspl));
        onPrinted(text.name);
      }
    } catch (e) {
      showWarnToast(t('pkLabelPrintFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  // Settles once these labels are out, or refused.
  const print = (texts: readonly LabelText[]): Promise<void> => {
    if (!texts.length) return queue.current;
    queue.current = queue.current.then(() => send(texts));
    return queue.current;
  };

  const element = dialog && (
    <LabelDialog key={dialog.n} texts={dialog.texts} size={size} onDone={() => { dialog.done(); setDialog(null); }} />
  );
  const settings: Settings = { auto, size, language, onAuto: setAuto, onSize: setSize, onLanguage: setLanguage };
  return { printer, auto, print, viaDialog, element, settings };
}

type Settings = {
  auto: boolean;
  size: LabelSize;
  language: LabelLanguage;
  onAuto: (on: boolean) => void;
  onSize: (s: LabelSize) => void;
  onLanguage: (l: LabelLanguage) => void;
};

type BarProps = {
  printer: PrinterStatus;
  settings: Settings;
  // When the page prints by itself: packing a product, or approving.
  autoTitle: string;
  autoHint: string;
  // Which label Print label prints, for its title.
  summary: string;
  canPrint: boolean;
  onPrint: () => void;
  onPrintDialog: () => void;
};

const LANGUAGES: readonly LabelLanguage[] = ['auto', 'tspl', 'zpl', 'escpos'];
const LANGUAGE_NAME: Record<PrinterLanguage, string> = { tspl: 'TSPL', zpl: 'ZPL', escpos: 'ESC/POS' };

// The page head's printer: whether it is on and how it is (paper, cover),
// Connect while it isn't, Print label, and the label's settings, which show
// whether the page prints by itself.
export function LabelPrinterBar({ printer, settings, autoTitle, autoHint, summary, canPrint, onPrint, onPrintDialog }: BarProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lang: PrinterLanguage = settings.language === 'auto' ? printer.language : settings.language;

  useEffect(() => { void labelPrinter.resume(); }, []);
  // How the printer is, on connecting and every 15 s after.
  useEffect(() => {
    if (printer.state !== 'on') return;
    void labelPrinter.check(lang);
    const id = window.setInterval(() => void labelPrinter.check(lang), 15_000);
    return () => window.clearInterval(id);
  }, [printer.state, lang]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  const on = printer.state === 'on' || printer.state === 'printing';
  const paperBad = printer.paper !== null && printer.paper !== 'ready' && printer.paper !== 'busy';
  const chipText = printer.state === 'unsupported' ? t('pkPrinterUnsupported')
    : printer.state === 'connecting' ? t('pkPrinterConnecting')
    : printer.state === 'printing' ? t('pkPrinterPrinting')
    : printer.state === 'on'
      ? [t('pkPrinterOn'), printer.name, printer.paper && t('pkPrinterPaper_' + printer.paper)].filter(Boolean).join(' · ')
      : t('pkPrinterOff');
  const tone = !on ? 'muted' : paperBad ? 'warn' : 'pos';

  return (
    <div className="pk-printer" ref={wrapRef}>
      <span className={'chip dot pk-printer-chip ' + tone} role="status" aria-live="polite">{chipText}</span>
      {(printer.state === 'off' || printer.state === 'connecting') && (
        <button
          type="button"
          className="btn pk-printer-btn"
          disabled={printer.state === 'connecting'}
          onClick={() => {
            labelPrinter.connect().catch(e =>
              showWarnToast(t(e instanceof Error && e.message === 'no-port' ? 'pkPrinterNoPort' : 'pkPrinterConnectFailed')));
          }}
        >
          <Icon name="zap" size={15} /> {t('pkPrinterConnect')}
        </button>
      )}
      <button
        type="button"
        className="btn accent pk-printer-btn"
        disabled={!canPrint || printer.state === 'connecting'}
        title={summary}
        onClick={onPrint}
      >
        <Icon name="printer" size={15} /> {t('pkLabelPrint')}
      </button>
      <div className="so-download">
        <button
          ref={trigger}
          type="button"
          className="btn pk-printer-btn pk-printer-more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('pkLabelMore')}
          title={t('pkLabelMore')}
          onClick={() => setOpen(o => !o)}
        >
          <Icon name="settings" size={15} />
          <span className={'pk-label-state' + (settings.auto ? ' on' : '')}>{t(settings.auto ? 'pkLabelAutoOn' : 'pkLabelAutoOff')}</span>
          <Icon name="chevronDown" size={13} />
        </button>
        {open && (
          <PrinterPop
            {...settings}
            autoTitle={autoTitle}
            autoHint={autoHint}
            detected={printer.state === 'unsupported' ? null : printer.language}
            canPrint={canPrint}
            close={() => { setOpen(false); trigger.current?.focus(); }}
            onPrintDialog={() => { setOpen(false); onPrintDialog(); }}
            onDisconnect={on ? () => { setOpen(false); labelPrinter.disconnect(); } : null}
          />
        )}
      </div>
    </div>
  );
}

// Its own component so its Escape sits above the page's, which leaves the mode.
function PrinterPop({ auto, size, language, onAuto, onSize, onLanguage, autoTitle, autoHint, detected, canPrint, close, onPrintDialog, onDisconnect }: Settings & {
  autoTitle: string;
  autoHint: string;
  // The language the printer's service implies; null without Bluetooth.
  detected: PrinterLanguage | null;
  canPrint: boolean;
  close: () => void;
  onPrintDialog: () => void;
  onDisconnect: (() => void) | null;
}) {
  const { t } = useT();
  useEscapeKey(close);
  return (
    <div className="so-download-pop pk-label-pop" role="menu">
      <label className="so-download-row pk-label-auto">
        <input type="checkbox" checked={auto} onChange={e => onAuto(e.target.checked)} />
        <span>
          <span className="so-download-label">{autoTitle}</span>
          <span className="so-download-hint">{autoHint}</span>
        </span>
      </label>
      <div className="so-download-warehouse pk-label-row">
        <span>{t('pkLabelStock')}</span>
        <div className="seg" role="group" aria-label={t('pkLabelStock')}>
          {(Object.keys(LABEL_SIZES) as LabelSize[]).map(s => (
            <button key={s} type="button" className={s === size ? 'active' : ''} aria-pressed={s === size} onClick={() => onSize(s)}>
              {LABEL_SIZES[s].name}
            </button>
          ))}
        </div>
      </div>
      {detected && (
        <div className="so-download-warehouse pk-label-row">
          <span>{t('pkLabelLanguage')}</span>
          <div className="seg" role="group" aria-label={t('pkLabelLanguage')}>
            {LANGUAGES.map(l => (
              <button key={l} type="button" className={l === language ? 'active' : ''} aria-pressed={l === language} onClick={() => onLanguage(l)}>
                {l === 'auto' ? t('pkLabelLanguageAuto') : LANGUAGE_NAME[l]}
              </button>
            ))}
          </div>
        </div>
      )}
      <button type="button" role="menuitem" className="so-download-row" disabled={!canPrint} onClick={onPrintDialog}>
        <Icon name="file" size={15} />
        <span>
          <span className="so-download-label">{t('pkLabelDialog')}</span>
          <span className="so-download-hint">{t('pkLabelDialogHint')}</span>
        </span>
      </button>
      {onDisconnect && (
        <button type="button" role="menuitem" className="so-download-row" onClick={onDisconnect}>
          <Icon name="x" size={15} />
          <span><span className="so-download-label">{t('pkPrinterDisconnect')}</span></span>
        </button>
      )}
    </div>
  );
}
