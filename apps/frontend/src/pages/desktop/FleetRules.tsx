import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import type { FlowStage, ItemField } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import {
  MIN_TITLE_WORDS, checkListing, duplicateTerms, formatRule, keywordCount, listTermKeys, ruleLines, ruleShape,
  splitEntry, termKey, type ListingVerdict, type RuleHit,
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

const LIST_TITLE: Record<ItemField, string> = {
  search_phrases: 'fbcRulesPhrases', keywords: 'fbcRulesInclude', antikeywords: 'fbcRulesExclude',
};

// The two keyword lists pull in opposite directions, so each carries its sign
// and colour everywhere it shows. Search phrases are neither.
const POLARITY: Partial<Record<ItemField, { cls: string; sign: string }>> = {
  keywords: { cls: 'inc', sign: '+' },
  antikeywords: { cls: 'exc', sign: '−' },
};

/** What a list's count means to a reader: phrases by line, keywords by chip. */
const listCount = (field: ItemField, value: string) =>
  field === 'search_phrases' ? ruleLines(value).length : keywordCount(ruleLines(value));

export function RulesPanel({ stage, items, active, onActive, editing, onChange, verdicts, onAdd, focus }: {
  stage: FlowStage;
  items: readonly ItemRules[];
  active: string;
  onActive: (name: string) => void;
  editing: boolean;
  onChange: (name: string, field: ItemField, value: string) => void;
  verdicts: Map<string, ListingVerdict> | null;
  /** Opens the stage's Edit form on this list; absent when it cannot be edited. */
  onAdd?: (field: ItemField) => void;
  /** The list whose input takes focus when Edit opens. */
  focus: ItemField | null;
}) {
  const { t } = useT();
  const fields = STAGE_LISTS[stage] ?? [];
  const item = items.find(i => i.name === active) ?? items[0];
  if (!item) return <span className="fp-muted">{t('fbcNone')}</span>;
  // The exclude list is checked first, so an include keyword it also holds can never pass a listing.
  const excluded = fields.includes('keywords') && fields.includes('antikeywords')
    ? listTermKeys(ruleLines(item.antikeywords)) : null;
  return (
    <div className="ff-rules">
      {items.length > 1 && (
        <div className="seg ff-rules-items" role="tablist" aria-label={t('fbcRulesItems')}>
          {items.map(i => (
            <button key={i.name} type="button" role="tab" aria-selected={i.name === item.name}
              className={i.name === item.name ? 'active' : ''} onClick={() => onActive(i.name)}>
              {i.name}
              <span className="ff-rules-count">
                {fields.map(f => (
                  <span key={f} className={`ff-n ${POLARITY[f]?.cls ?? ''}`} title={t(LIST_TITLE[f])}>
                    {POLARITY[f]?.sign}{listCount(f, i[f])}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className={`ff-rules-cols${fields.length > 1 ? ' two' : ''}`}>
        {fields.map(f => (
          <RuleList key={`${item.name}:${f}`} field={f} stage={stage} value={item[f]} editing={editing}
            hit={verdictHit(verdicts?.get(item.name), f)} onChange={v => onChange(item.name, f, v)}
            blocked={f === 'keywords' ? excluded : null} focus={focus === f}
            onAdd={onAdd && (() => onAdd(f))} />
        ))}
      </div>
    </div>
  );
}

function RuleList({ field, stage, value, editing, hit, onChange, blocked, focus, onAdd }: {
  field: ItemField;
  stage: FlowStage;
  value: string;
  editing: boolean;
  hit: RuleHit | null;
  onChange: (value: string) => void;
  blocked: Set<string> | null;
  focus: boolean;
  onAdd?: () => void;
}) {
  const { t } = useT();
  const [asText, setAsText] = useState(false);
  const [pending, setPending] = useState('');
  // The expression being rewritten in place, by entry.
  const [openExpr, setOpenExpr] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Search phrases are queries, not expressions: every line is one chip.
  const plain = field === 'search_phrases';
  const pol = POLARITY[field];
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
  const isHit = (i: number, term: string | null) =>
    !!hit && hit.rule === i && (hit.term === null || term === null || termKey(hit.term) === termKey(term));

  const chip = (term: string, i: number, k: number) => {
    const key = termKey(term);
    const dup = !plain && dups.has(key);
    const dead = !!blocked?.has(key);
    return (
      <span key={`${i}:${k}`} className={`ff-chip${dup ? ' dup' : ''}${dead ? ' blocked' : ''}${isHit(i, term) ? ' hit' : ''}`}
        title={dead ? t('fbcRulesBlocked') : dup ? t('fbcRulesDup') : undefined}>
        {term}
        {editing && (
          <button type="button" className="ff-chip-x" aria-label={t('fbcRulesRemove', { term })}
            onClick={() => removeTerm(i, k)}>
            <Icon name="x" size={9} />
          </button>
        )}
      </span>
    );
  };

  const expr = (i: number) => (
    <span key={i} className={`ff-chip ff-chip-expr${isHit(i, null) ? ' hit' : ''}`}>
      <span className="ff-expr-tag">{t('fbcRulesExpr')}</span>
      {editing && openExpr === i ? (
        <input className="input ff-chip-input" autoFocus spellCheck={false} defaultValue={rules[i]}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpenExpr(null); }
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          }}
          onBlur={e => {
            const v = e.currentTarget.value.trim();
            if (v !== rules[i]) replace(i, v || null);
            setOpenExpr(null);
          }} />
      ) : editing ? (
        <>
          <button type="button" className="ff-expr-text" onClick={() => setOpenExpr(i)}>{rules[i]}</button>
          <button type="button" className="ff-chip-x" aria-label={t('fbcRulesRemove', { term: rules[i] })}
            onClick={() => replace(i, null)}>
            <Icon name="x" size={9} />
          </button>
        </>
      ) : <span className="ff-expr-text">{rules[i]}</span>}
    </span>
  );

  // Every list is "any one of these", so a group of OR'd terms needs no box or
  // "or" of its own: its terms sit among the rest, and only an AND/NOT entry
  // keeps its shape.
  const chips = rules.flatMap((r, i) => {
    if (plain) return [chip(r, i, 0)];
    const shape = ruleShape(r);
    return shape.kind === 'terms' ? shape.terms.map((term, k) => chip(term, i, k)) : [expr(i)];
  });

  return (
    <div className={`ff-rule-list${pol ? ` ${pol.cls}` : ''}`}>
      <div className="ff-rule-list-head">
        {pol && <span className="ff-pol-badge" aria-hidden="true">{pol.sign}</span>}
        <span className="ff-rule-title">{t(LIST_TITLE[field])}</span>
        <span className="ff-rules-count">{listCount(field, value)}</span>
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
        // A click on the field's empty space lands in its input, as in any tag field.
        <div className={`ff-rule-well${editing ? ' editing' : ''}`}
          onClick={e => { if (e.target === e.currentTarget) input.current?.focus(); }}>
          {chips}
          {editing ? (
            <input ref={input} className="ff-well-input" value={pending} spellCheck={false} autoFocus={focus}
              placeholder={t(plain ? 'fbcRulesAddPhrase' : 'fbcRulesAddPh')}
              aria-label={t(plain ? 'fbcRulesAddPhrase' : 'fbcRulesAddPh')}
              title={plain ? undefined : t('fbcRulesAddTip')}
              onChange={e => setPending(e.target.value)} onKeyDown={onAddKey} onPaste={onPaste}
              onBlur={() => pending.trim() && commit(pending)} />
          ) : onAdd ? (
            <button type="button" className="ff-chip-new" onClick={onAdd}>
              <Icon name="plus" size={10} />
              {t(plain ? 'fbcRulesAddPhraseBtn' : 'fbcRulesAdd')}
            </button>
          ) : rules.length === 0 && <span className="fp-muted">{t('fbcNone')}</span>}
        </div>
      )}
    </div>
  );
}

/** A listing title (and description) checked against every item, live. */
// The tester sits inside the stage's settings form: Enter in it must not
// submit, which would save the draft to every worker and start a sweep.
const keepForm = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.preventDefault();
};

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
        aria-label={t('fbcTryTitlePh')} onKeyDown={keepForm} onChange={e => onProbe({ ...probe, title: e.target.value })} />
      {stage === 'keywords' && (
        <input className="input" value={probe.description} spellCheck={false} placeholder={t('fbcTryDescPh')}
          aria-label={t('fbcTryDescPh')} onKeyDown={keepForm} onChange={e => onProbe({ ...probe, description: e.target.value })} />
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
