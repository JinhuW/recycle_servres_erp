export type Currency = 'USD' | 'CNY';

// Segmented USD/CNY control, shared by the new-order builder, the sell-order
// edit modal and the Market price import.
export function CurrencyPicker({
  value, onChange, t, disabled,
}: {
  value: Currency;
  onChange: (c: Currency) => void;
  t: (k: string) => string;
  disabled?: boolean;
}) {
  const opts: { id: Currency; labelKey: string }[] = [
    { id: 'USD', labelKey: 'currency.usd' },
    { id: 'CNY', labelKey: 'currency.cny' },
  ];
  return (
    <div className="seg" style={{ display: 'inline-flex', gap: 4 }}>
      {opts.map(o => (
        <button
          key={o.id}
          type="button"
          className={'btn sm' + (value === o.id ? ' accent' : '')}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}
