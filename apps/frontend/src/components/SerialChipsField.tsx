import { useEffect, useRef, useState } from 'react';
import { parseSerials } from '@recycle-erp/shared';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { addSerials, readPending, removeSerialAt, stripPending } from '../lib/serialField';

type Props = {
  value: string | null | undefined;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Renders the scanner trigger docked in the corner (phone shell only). */
  onScan?: () => void;
  scanLabel?: string;
};

/**
 * Serial numbers as labels you can delete whole.
 *
 * The field's value is still one newline-joined blob — what changes is that a
 * committed serial is a chip, not characters you have to select. Text that is
 * still being typed is mirrored into that value rather than held back until
 * blur: iOS Safari doesn't blur an input when a <button> is tapped, so a
 * commit-on-blur field would drop the last serial the moment someone typed it
 * and hit Save, then report a count mismatch about a serial plainly on screen.
 */
export function SerialChipsField({ value, onChange, placeholder, onScan, scanLabel }: Props) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState('');
  // Backspace on an empty input arms the last chip before it removes it. A
  // 32-stick lot is expensive to re-scan and there is no undo.
  const [armed, setArmed] = useState(false);
  // Index of the chip a just-rejected duplicate already lives in, flashed so
  // the rejection points somewhere instead of the text merely vanishing.
  const [dupAt, setDupAt] = useState(-1);
  const dupTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(dupTimer.current), []);
  // The last value this field handed out. Everything below turns on whether the
  // value we were given back is still that one.
  const lastEmitted = useRef<string | null>(null);

  const raw = value ?? '';
  // A write from outside (the scanner appending a serial) rebuilds the value
  // without our tail, which promotes the half-typed text to a chip — so the
  // pending text is honoured only against the value we ourselves emitted, never
  // against a value that merely ends with those characters.
  const ours = raw === lastEmitted.current;
  const pendingText = readPending(raw, pending, lastEmitted.current);
  const chips = parseSerials(stripPending(raw, pendingText));
  const committed = chips.join('\n');
  // An external write lands without a blur (iOS doesn't blur on a button tap),
  // so an arming from before it would point at whatever chip is last now — the
  // scanned one.
  const armedNow = armed && ours;

  // `pending` rides along in the value so the DDR5 / count-vs-qty rules and the
  // count badge read what the user can see.
  const write = (nextChips: string, nextPending: string) => {
    const next = nextPending ? (nextChips ? `${nextChips}\n${nextPending}` : nextPending) : nextChips;
    lastEmitted.current = next;
    setPending(nextPending);
    setArmed(false);
    setDupAt(-1);
    onChange(next);
  };

  const commit = (text: string) => {
    const next = addSerials(committed, text);
    const parsed = parseSerials(text);
    // Nothing new: the value is already a chip. Clearing the input and flashing
    // that chip is the feedback — keeping the text would leave it counted by
    // the count-vs-qty rule as a serial that can never become one.
    if (next === committed && parsed.length > 0) {
      write(committed, '');
      window.clearTimeout(dupTimer.current);
      setDupAt(chips.indexOf(parsed[parsed.length - 1]));
      dupTimer.current = window.setTimeout(() => setDupAt(-1), 1400);
    } else {
      write(next, '');
    }
    inputRef.current?.focus();
  };

  // Separators are read out of the *value*, not keydown: Android soft keyboards
  // report `key: 'Unidentified'`, and this path also covers paste and the HID
  // barcode scanners that type a code and press Enter.
  const onInput = (next: string) => {
    if (/[\n,;]/.test(next)) { commit(next); return; }
    write(committed, next);
  };

  const removeAt = (i: number) => {
    write(removeSerialAt(committed, i), pendingText);
    // The × unmounts on click; without this, focus lands on <body> and the
    // mobile keyboard drops.
    inputRef.current?.focus();
  };

  return (
    <div className="sn-field-wrap">
      <div
        className="sn-field"
        style={onScan ? { paddingRight: 50 } : undefined}
        onClick={e => { if (e.target === e.currentTarget) inputRef.current?.focus(); }}
      >
        {chips.map((sn, i) => (
          <span
            key={`${sn}-${i}`}
            className={
              armedNow && i === chips.length - 1 ? 'sn-token armed'
              : i === dupAt ? 'sn-token dup'
              : 'sn-token'
            }
          >
            {sn}
            <button
              type="button"
              className="sn-token-x"
              aria-label={t('snRemove', { sn })}
              onClick={() => removeAt(i)}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="sn-field-input mono"
          value={pendingText}
          aria-label={t('serialNumbers')}
          placeholder={chips.length === 0 ? placeholder : undefined}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          onChange={e => onInput(e.target.value)}
          // Arming is a two-step gesture, and a step the user has walked away
          // from is not one they still mean.
          onBlur={() => setArmed(false)}
          onKeyDown={e => {
            // An IME's Enter arrives mid-composition and would chip half-typed text.
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') { e.preventDefault(); if (pendingText.trim()) commit(pendingText); return; }
            if (e.key === 'Backspace' && pendingText === '' && chips.length > 0) {
              e.preventDefault();
              if (armedNow) removeAt(chips.length - 1);
              else setArmed(true);
            }
          }}
        />
      </div>
      {/* Outside the field, which scrolls: an absolute child of a scroll
          container travels with the content, so a 32-stick lot carried the
          trigger off the top of the box. */}
      {onScan && (
        <button type="button" className="ph-sn-scan" aria-label={scanLabel ?? t('snScan')} onClick={onScan}>
          <Icon name="scan" size={17} />
        </button>
      )}
    </div>
  );
}
