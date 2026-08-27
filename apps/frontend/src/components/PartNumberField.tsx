import { Combobox } from './Combobox';
import { usePartSuggest } from '../lib/usePartSuggest';
import { useT } from '../lib/i18n';

/**
 * Part # input that offers the part numbers already on record as you type.
 *
 * The suggestions are the server's answer, not a preset list, so the menu is
 * unfiltered locally (`filterOptions={false}`) — the server matched on the
 * canonical form, and a raw substring filter here would drop a stored
 * "PN: ABC 123" returned for a typed "abc1".
 *
 * Nothing is validated against the list: Combobox's "Use …" row already carries
 * a typed value through verbatim, which is exactly right for a part we have
 * genuinely never bought.
 */
export function PartNumberField({
  value, onChange, placeholder, className = 'input mono', invalid,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  invalid?: boolean;
}) {
  const { t } = useT();
  const { options, meta, loading } = usePartSuggest(value);
  return (
    <Combobox
      value={value}
      options={options}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      invalid={invalid}
      filterOptions={false}
      meta={o => meta.get(o)}
      loading={loading}
      emptyText={t('pnSuggestHint')}
    />
  );
}
