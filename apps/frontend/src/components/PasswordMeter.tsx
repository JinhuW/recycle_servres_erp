// Lightweight strength heuristic shared between the desktop Account panel,
// the desktop Members add-user form, and the mobile password sheet. Renders
// four segments + a label that lights up as the password grows stronger.
// Styles are inlined so neither shell's stylesheet has to ship a `.pw-meter`
// rule for it to look right.

type Tone = { color: string; labelKey: PwStrengthKey };
export type PwStrengthKey = 'tooShort' | 'weak' | 'fair' | 'strong' | 'excellent';

const TONES: Tone[] = [
  { color: 'var(--neg)',  labelKey: 'tooShort'  },
  { color: 'var(--neg)',  labelKey: 'weak'      },
  { color: 'var(--warn)', labelKey: 'fair'      },
  { color: 'var(--accent)', labelKey: 'strong'  },
  { color: 'var(--pos)',  labelKey: 'excellent' },
];

export function scorePassword(password: string): { score: number; tone: Tone } {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = checks.filter(Boolean).length;
  const tone = password.length < 6 ? TONES[0] : TONES[score];
  return { score, tone };
}

type Props = {
  password: string;
  labels: Record<PwStrengthKey, string>;  // i18n labels supplied by the caller
};

export function PasswordMeter({ password, labels }: Props) {
  if (!password) return null;
  const { score, tone } = scorePassword(password);

  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', gap: 4, flex: 1 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              background: i < score ? tone.color : 'var(--border)',
              transition: 'background 0.15s ease',
            }}
          />
        ))}
      </div>
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: tone.color,
        letterSpacing: '0.01em',
        minWidth: 64,
        textAlign: 'right',
      }}>
        {labels[tone.labelKey]}
      </span>
    </div>
  );
}
