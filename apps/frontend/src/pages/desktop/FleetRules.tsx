import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import type { FlowStage, ItemField } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import {
  MIN_TITLE_WORDS, checkListing, duplicateTerms, formatRule, formatTerm, ruleLines, ruleShape, splitEntry,
  termKey, type ListingVerdict, type RuleHit,
} from '../../lib/keywordRules';

// ─── An item's phrases and keyword rules, as chips ────────────────────────────
// The lists the search, title-gate and keyword-gate stages read. Each list is
// held as the draft holds it — entries one per line — and an edit rewrites
// only the entry it touched, so a save leaves every other rule byte-for-byte
// as it was. lib/keywordRules.ts reads the entries the way the monitor does.

export type ItemRules = Record<ItemField, string> & { name: string };
export type Probe = { title: string; description: string };

export const STAGE_LISTS: Partial<Record<FlowStage, readonly ItemField[]>> = {
  search: ['search_phrases'],
  title: ['antikeywords'],
  keywords: ['keywords', 'antikeywords'],
};

/** What the probe listing would do on this stage, per item; null when nothing is typed. */
export function probeVerdicts(
  stage: FlowStage, items: readonly ItemRules[], probe: Probe, prefilter: boolean,
): Map<string, ListingVerdict> | null {
  if (!probe.title.trim() || (stage !== 'title' && stage !== 'keywords')) return null;
  return new Map(items.map(i => [i.name, checkListing(
    { keywords: ruleLines(i.keywords), antikeywords: ruleLines(i.antikeywords) },
    probe.title, probe.description, { titleOnly: stage === 'title', prefilter },
  )]));
}

const verdictHit = (v: ListingVerdict | undefined, field: ItemField): RuleHit | null => {
  if (!v) return null;
  if (v.kind === 'anti' && field === 'antikeywords') return v.hit;
  if (v.kind === 'pass' && field === 'keywords') return v.hit;
  return null;
};

export function RulesPanel({ stage, items, active, onActive, editing, onChange, verdicts }: {
  stage: FlowStage;
  items: readonly ItemRules[];
  active: string;
  onActive: (name: string) => void;
  editing: boolean;
  onChange: (name: string, field: ItemField, value: string) => void;
  verdicts: Map<string, ListingVerdict> | null;
}) {
  const { t } = useT();
  const fields = STAGE_LISTS[stage] ?? [];
  const item = items.find(i => i.name === active) ?? items[0];
  if (!item) return <span className="fp-muted">{t('fbcNone')}</span>;
  return (
    <div className="ff-rules">
      {items.length > 1 && (
        <div className="seg ff-rules-items" role="tablist" aria-label={t('fbcRulesItems')}>
          {items.map(i => (
            <button key={i.name} type="button" role="tab" aria-selected={i.name === item.name}
              className={i.name === item.name ? 'active' : ''} onClick={() => onActive(i.name)}>
              {i.name}
              <span className="ff-rules-count">{fields.map(f => ruleLines(i[f]).length).join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`ff-rules-cols${fields.length > 1 ? ' two' : ''}`}>
        {fields.map(f => (
          <RuleList key={`${item.name}:${f}`} field={f} stage={stage} value={item[f]} editing={editing}
            hit={verdictHit(verdicts?.get(item.name), f)} onChange={v => onChange(item.name, f, v)} />
        ))}
      </div>
    </div>
  );
}

const LIST_TITLE: Record<ItemField, string> = {
  search_phrases: 'fbcRulesPhrases', keywords: 'fbcRulesMustMatch', antikeywords: 'fbcRulesDrops',
};

function RuleList({ field, stage, value, editing, hit, onChange }: {
  field: ItemField;
  stage: FlowStage;
  value: string;
  editing: boolean;
  hit: RuleHit | null;
  onChange: (value: string) => void;
}) {
  const { t } = useT();
  const [asText, setAsText] = useState(false);
  const [pending, setPending] = useState('');
  // Which entry has an inline input open: a group taking one more term, or an
  // expression being rewritten.
  const [open, setOpen] = useState<{ rule: number; mode: 'add' | 'expr' } | null>(null);
  // Search phrases are queries, not expressions: every line is one chip.
  const plain = field === 'search_phrases';
  const rules = ruleLines(value);
  const dups = plain ? new Set<string>() : duplicateTerms(rules);
  const hint = field === 'antikeywords' && stage === 'title' ? 'fbcRulesDropsTitleHint' : `fbcRulesHint_${field}`;

  const write = (next: string[]) => onChange(next.join('\n'));
  const replace = (i: number, entry: string | null) =>
    write(entry ? rules.map((r, j) => (j === i ? entry : r)) : rules.filter((_, j) => j !== i));
  const removeTerm = (i: number, k: number) => {
    const shape = ruleShape(rules[i]);
    replace(i, shape.kind === 'terms' ? formatRule(shape.raw.filter((_, j) => j !== k)) || null : null);
  };
  const addTo = (i: number, raw: string) => {
    const shape = ruleShape(rules[i]);
    const terms = splitEntry(raw.replace(/\n/g, ','));
    if (shape.kind === 'terms' && terms.length) replace(i, formatRule([...shape.raw, ...terms.map(formatTerm)]));
  };
  const commit = (raw: string) => {
    const added = plain ? raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean) : splitEntry(raw);
    if (added.length) write([...rules, ...added]);
    setPending('');
  };
  const onAddKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(pending); }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text.includes('\n')) return;
    e.preventDefault();
    commit(`${pending}${text}`);
  };

  const chip = (term: string, i: number, k: number, isHit: boolean) => (
    <span key={`${i}:${k}`} className={`ff-chip${!plain && dups.has(termKey(term)) ? ' dup' : ''}${isHit ? ' hit' : ''}`}
      title={!plain && dups.has(termKey(term)) ? t('fbcRulesDup') : undefined}>
      {term}
      {editing && (
        <button type="button" className="ff-chip-x" aria-label={t('fbcRulesRemove', { term })}
          onClick={() => removeTerm(i, k)}>
          <Icon name="x" size={9} />
        </button>
      )}
    </span>
  );

  const inline = (i: number, mode: 'add' | 'expr') => (
    <input className="input ff-chip-input" autoFocus spellCheck={false}
      defaultValue={mode === 'expr' ? rules[i] : ''}
      placeholder={mode === 'add' ? t('fbcRulesAddTo') : undefined}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); }
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
      }}
      onBlur={e => {
        const v = e.currentTarget.value.trim();
        if (mode === 'add') { if (v) addTo(i, v); } else if (v !== rules[i]) replace(i, v || null);
        setOpen(null);
      }} />
  );

  const singles: number[] = [];
  const groups: number[] = [];
  const exprs: number[] = [];
  rules.forEach((r, i) => {
    if (plain) { singles.push(i); return; }
    const s = ruleShape(r);
    (s.kind === 'expr' ? exprs : s.terms.length > 1 ? groups : singles).push(i);
  });
  const termsOf = (i: number) => {
    if (plain) return [rules[i]];
    const s = ruleShape(rules[i]);
    return s.kind === 'terms' ? s.terms : [rules[i]];
  };
  const isHit = (i: number, term: string | null) =>
    !!hit && hit.rule === i && (hit.term === null || term === null || termKey(hit.term) === termKey(term));

  return (
    <div className="ff-rule-list">
      <div className="ff-rule-list-head">
        <span className="fp-section-label">{t(LIST_TITLE[field])}</span>
        <span className="ff-rules-count">{rules.length}</span>
        {editing && (
          <button type="button" className="ff-rule-mode" onClick={() => setAsText(v => !v)}>
            {t(asText ? 'fbcRulesAsChips' : 'fbcRulesAsText')}
          </button>
        )}
      </div>
      <span className="ff-rule-hint">{t(hint)}</span>
      {editing && asText ? (
        <>
          <textarea className="input ff-edit-list" value={value} spellCheck={false}
            rows={Math.min(14, Math.max(4, value.split('\n').length + 1))}
            onChange={e => onChange(e.target.value)} />
          <span className="fp-muted ff-edit-hint">{t(plain ? 'fbcEditOnePerLine' : 'fbcRulesTextHint')}</span>
        </>
      ) : (
        <>
          {rules.length === 0 && !editing && <span className="fp-muted">{t('fbcNone')}</span>}
          {singles.length > 0 && (
            <div className="ff-chips">{singles.map(i => chip(termsOf(i)[0], i, 0, isHit(i, null)))}</div>
          )}
          {groups.map(i => (
            <div key={i} className={`ff-rule-group${isHit(i, null) ? ' hit' : ''}`}>
              {termsOf(i).map((term, k) => (
                <span key={k} className="ff-rule-or">
                  {k > 0 && <span className="ff-or">{t('fbcRulesOr')}</span>}
                  {chip(term, i, k, isHit(i, term))}
                </span>
              ))}
              {editing && (open?.rule === i && open.mode === 'add' ? inline(i, 'add') : (
                <button type="button" className="ff-chip-add" aria-label={t('fbcRulesAddTo')} title={t('fbcRulesAddTo')}
                  onClick={() => setOpen({ rule: i, mode: 'add' })}>
                  <Icon name="plus" size={10} />
                </button>
              ))}
            </div>
          ))}
          {exprs.map(i => (
            <div key={i} className={`ff-rule-expr${isHit(i, null) ? ' hit' : ''}`}>
              <span className="ff-expr-tag">{t('fbcRulesExpr')}</span>
              {editing && open?.rule === i && open.mode === 'expr' ? inline(i, 'expr') : editing ? (
                <>
                  <button type="button" className="ff-expr-text" onClick={() => setOpen({ rule: i, mode: 'expr' })}>
                    {rules[i]}
                  </button>
                  <button type="button" className="ff-chip-x" aria-label={t('fbcRulesRemove', { term: rules[i] })}
                    onClick={() => replace(i, null)}>
                    <Icon name="x" size={9} />
                  </button>
                </>
              ) : <span className="ff-expr-text">{rules[i]}</span>}
            </div>
          ))}
          {editing && (
            <input className="input ff-rule-add" value={pending} spellCheck={false}
              placeholder={t(plain ? 'fbcRulesAddPhrase' : 'fbcRulesAdd')}
              onChange={e => setPending(e.target.value)} onKeyDown={onAddKey} onPaste={onPaste}
              onBlur={() => pending.trim() && commit(pending)} />
          )}
        </>
      )}
    </div>
  );
}

/** A listing title (and description) checked against every item, live. */
export function ListingTester({ stage, probe, onProbe, verdicts, onPick, editing }: {
  stage: FlowStage;
  probe: Probe;
  onProbe: (p: Probe) => void;
  verdicts: Map<string, ListingVerdict> | null;
  onPick: (name: string) => void;
  editing: boolean;
}) {
  const { t } = useT();
  const say = (v: ListingVerdict) => {
    switch (v.kind) {
      case 'anti': return t('fbcTryAnti', { term: v.hit.term ?? '…' });
      case 'missing': return t('fbcTryMissing');
      case 'deferred': return v.reason === 'short' ? t('fbcTryShort', { n: String(MIN_TITLE_WORDS) }) : t('fbcTryNoPrefilter');
      case 'pass': return v.hit?.term ? t('fbcTryPassOn', { term: v.hit.term }) : t('fbcTryPass');
    }
  };
  return (
    <div className={`ff-try${stage === 'title' ? ' title-only' : ''}`}>
      <span className="fp-section-label">
        {t('fbcTryTitle')}
        {editing && <span className="ff-try-draft"> · {t('fbcTryDraft')}</span>}
      </span>
      <input className="input" value={probe.title} spellCheck={false} placeholder={t('fbcTryTitlePh')}
        aria-label={t('fbcTryTitlePh')} onChange={e => onProbe({ ...probe, title: e.target.value })} />
      {stage === 'keywords' && (
        <input className="input" value={probe.description} spellCheck={false} placeholder={t('fbcTryDescPh')}
          aria-label={t('fbcTryDescPh')} onChange={e => onProbe({ ...probe, description: e.target.value })} />
      )}
      {verdicts && (
        <ul className="ff-try-out">
          {[...verdicts].map(([name, v]) => (
            <li key={name}>
              <button type="button" className={`ff-try-row ${v.kind}`} onClick={() => onPick(name)}>
                <span className="mono">{name}</span>
                <span>{say(v)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
