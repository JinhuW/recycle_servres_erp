import { Icon } from './Icon';

// Serial numbers are stored as a single free-text blob (the entry UI is a
// multi-line textarea — one SN per line). Split on newlines / commas /
// semicolons, trim, and drop blanks so the display never shows empty pills.
export function parseSerials(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Props = {
  raw: string | null | undefined;
  /** Cap the rendered pills; the rest collapse into a "+N" chip. */
  max?: number;
  size?: number;
  /** Hide the leading hash glyph (e.g. when the row already labels the cell). */
  bare?: boolean;
};

// Compact, monospace serial-number pills. Renders nothing when no SNs are
// present so callers can drop it inline without guarding.
export function SerialNumbers({ raw, max = 8, size = 11, bare = false }: Props) {
  const sns = parseSerials(raw);
  if (sns.length === 0) return null;
  const shown = sns.slice(0, max);
  const extra = sns.length - shown.length;
  const title = sns.join('\n');
  return (
    <span className="sn-list" title={title}>
      {!bare && <Icon name="hash" size={size + 1} className="sn-glyph" />}
      {shown.map((sn, i) => (
        <span key={i} className="sn-chip" style={{ fontSize: size }}>{sn}</span>
      ))}
      {extra > 0 && <span className="sn-chip sn-more" style={{ fontSize: size }}>+{extra}</span>}
    </span>
  );
}
