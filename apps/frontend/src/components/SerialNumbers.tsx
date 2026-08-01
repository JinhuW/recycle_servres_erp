import { Icon } from './Icon';
import { parseSerials } from '@recycle-erp/shared';

// Parsing lives in @recycle-erp/shared so the backend validates the same
// serial format the UI displays; re-exported here for existing importers.
export { parseSerials };

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
