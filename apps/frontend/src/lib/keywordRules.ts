// ─── A worker's keyword rules, read the way the monitor reads them ────────────
// A port of ai_marketplace_monitor/utils.py is_substring() and the grammar in
// front of it, so the flow card can show a rule's shape and say what a listing
// would do before a save starts a sweep on every worker. A list is an OR over
// its entries; an entry may be an expression (NOT > AND > OR, parentheses,
// "quoted" or 'quoted' phrases); an entry that does not parse is matched as
// one literal string, which is how `hard drive` works with no quotes.

// pyparsing's alphanums plus the monitor's special_chars: what an unquoted
// operand may be made of. Parentheses are not in it — they group.
const WORD = /^[A-Za-z0-9!@#$%^&*\-_=+[\]{}|;:'",.<>?/\\`~]+$/;
const OPS = new Set(['AND', 'OR', 'NOT']);

type Token = { op: 'AND' | 'OR' | 'NOT' | '(' | ')' } | { term: string; raw: string };
export type Expr = string | { not: Expr } | { and: [Expr, Expr] } | { or: [Expr, Expr] };

function tokenize(src: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { out.push({ op: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      // pyparsing's CharsNotIn wants at least one character between the quotes.
      if (end > i + 1) { out.push({ term: src.slice(i + 1, end), raw: src.slice(i, end + 1) }); i = end + 1; continue; }
    }
    let j = i;
    while (j < src.length && !/[\s()]/.test(src[j])) j++;
    const word = src.slice(i, j);
    if (!WORD.test(word)) return null;
    out.push(OPS.has(word) ? { op: word as 'AND' | 'OR' | 'NOT' } : { term: word, raw: word });
    i = j;
  }
  return out;
}

/** The entry's expression tree, or null where the monitor would fall back to a literal. */
export function parseExpr(src: string): Expr | null {
  const toks = tokenize(src);
  if (!toks || toks.length === 0) return null;
  let at = 0;
  const peekOp = () => { const t = toks[at]; return t && 'op' in t ? t.op : null; };
  const or = (): Expr | null => {
    let left = and();
    while (left !== null && peekOp() === 'OR') { at++; const r = and(); left = r === null ? null : { or: [left, r] }; }
    return left;
  };
  const and = (): Expr | null => {
    let left = not();
    while (left !== null && peekOp() === 'AND') { at++; const r = not(); left = r === null ? null : { and: [left, r] }; }
    return left;
  };
  const not = (): Expr | null => {
    if (peekOp() === 'NOT') { at++; const e = not(); return e === null ? null : { not: e }; }
    return atom();
  };
  const atom = (): Expr | null => {
    const t = toks[at];
    if (!t) return null;
    if ('term' in t) { at++; return t.term; }
    if (t.op !== '(') return null;
    at++;
    const e = or();
    if (e === null || peekOp() !== ')') return null;
    at++;
    return e;
  };
  const e = or();
  return e !== null && at === toks.length ? e : null;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `text` holds `term` where a word starts. The front is anchored so
 * "ram" stops matching ceramic; the end stays open so "ssd" still finds ssds.
 */
export function containsTerm(term: string, text: string): boolean {
  const t = normalize(term).trim();
  if (!t) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escape(t)}`, 'iu').test(normalize(text));
}

const evaluate = (e: Expr, text: string): boolean => {
  if (typeof e === 'string') return containsTerm(e, text);
  if ('not' in e) return !evaluate(e.not, text);
  if ('and' in e) return evaluate(e.and[0], text) && evaluate(e.and[1], text);
  return evaluate(e.or[0], text) || evaluate(e.or[1], text);
};

/** Whether one entry matches `text`, exactly as the monitor decides it. */
export function ruleMatches(rule: string, text: string): boolean {
  const e = parseExpr(rule);
  return e === null ? containsTerm(rule, text) : evaluate(e, text);
}

// ── A rule's shape, for showing and editing it ──

/**
 * `terms`: one term or a plain OR of terms, each with the operand as written
 * (`raw`, quotes and all) so an edit rewrites only the term it touched.
 * `expr`: anything with AND, NOT or grouping.
 */
export type RuleShape = { kind: 'terms'; terms: string[]; raw: string[] } | { kind: 'expr' };

// The flow card re-reads every rule on each render, hidden stages included,
// and a list holds the same few dozen strings between edits.
const shapes = new Map<string, RuleShape>();

export function ruleShape(rule: string): RuleShape {
  let shape = shapes.get(rule);
  if (!shape) {
    if (shapes.size > 500) shapes.clear();
    shape = readShape(rule);
    shapes.set(rule, shape);
  }
  return shape;
}

function readShape(rule: string): RuleShape {
  const text = rule.trim();
  if (parseExpr(text) === null) return { kind: 'terms', terms: [text], raw: [text] };
  const toks = tokenize(text) ?? [];
  // Parentheses around a plain OR still count as grouping: dropping them on
  // write would change a rule nobody touched.
  const plain = toks.every((t, i) => (i % 2 === 0 ? 'term' in t : 'op' in t && t.op === 'OR'));
  if (!plain) return { kind: 'expr' };
  const ops = toks.filter((t): t is { term: string; raw: string } => 'term' in t);
  return { kind: 'terms', terms: ops.map(t => t.term), raw: ops.map(t => t.raw) };
}

/** One term as an operand: bare when the grammar reads it back as itself, quoted otherwise. */
export function formatTerm(term: string): string {
  const t = term.trim();
  if (WORD.test(t) && !OPS.has(t) && !/^["']/.test(t)) return t;
  return t.includes('"') ? `'${t}'` : `"${t}"`;
}

/**
 * The entry for a list of operands, each already written as `formatTerm()` or
 * a `raw` from ruleShape(). A lone operand stays as typed — an unparseable
 * entry is already a literal — so `hard drive` does not become `"hard drive"`…
 */
export function formatRule(operands: readonly string[]): string {
  const ts = operands.map(t => t.trim()).filter(Boolean);
  if (ts.length !== 1) return ts.join(' OR ');
  // …unless the bare text would read as operators: `NOT working` is a phrase here.
  const e = parseExpr(ts[0]);
  return e === null || typeof e === 'string' ? ts[0] : formatTerm(ts[0]);
}

/** The draft's newline-joined list as its entries, as the save sends them. */
export const ruleLines = (v: string): string[] => v.split('\n').map(l => l.trim()).filter(Boolean);

/** What a typed or pasted chunk adds: one entry per line, or per comma when it has no operators. */
export function splitEntry(raw: string): string[] {
  return raw.split('\n').flatMap(line => {
    const l = line.trim();
    if (!l) return [];
    if (/\b(AND|OR|NOT)\b|["'()]/.test(l)) return [l];
    return l.split(',').map(s => s.trim()).filter(Boolean);
  });
}

export const termKey = (t: string) => normalize(t).trim();

/**
 * Terms that appear in more than one place in a list, by lowercased term, so
 * a second copy (which only costs a reader time) can be pointed out.
 */
export function duplicateTerms(rules: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const rule of rules) {
    const shape = ruleShape(rule);
    if (shape.kind !== 'terms') continue;
    for (const t of shape.terms) {
      const k = termKey(t);
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
  }
  return dup;
}

/** How many keywords a list holds, as its chips show them: a term each, an expression as one. */
export function keywordCount(rules: readonly string[]): number {
  return rules.reduce((n, rule) => {
    const shape = ruleShape(rule);
    return n + (shape.kind === 'terms' ? shape.terms.length : 1);
  }, 0);
}

/** A list's plain terms by lowercased term; expressions are left out, since no one term stands for them. */
export function listTermKeys(rules: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const rule of rules) {
    const shape = ruleShape(rule);
    if (shape.kind === 'terms') for (const t of shape.terms) keys.add(termKey(t));
  }
  return keys;
}

// ── What a listing would do ──

/** Which entry matched, and which of its terms when it is a group of them. */
export type RuleHit = { rule: number; term: string | null };

function firstHit(rules: readonly string[], text: string): RuleHit | null {
  for (let i = 0; i < rules.length; i++) {
    if (!ruleMatches(rules[i], text)) continue;
    const shape = ruleShape(rules[i]);
    const term = shape.kind === 'terms' ? shape.terms.find(t => containsTerm(t, text)) ?? null : null;
    return { rule: i, term };
  }
  return null;
}

// monitor's MIN_INFORMATIVE_TITLE_WORDS: a shorter title is too terse to
// reject on, so its page is opened anyway.
export const MIN_TITLE_WORDS = 4;

/**
 * `pass`; `anti`: an anti-keyword drops it; `missing`: no keyword matched;
 * `deferred`: no keyword in the title, but the title gate lets it through to
 * have its page read (prefilter off, or a title too short to judge).
 */
export type ListingVerdict =
  | { kind: 'pass'; hit: RuleHit | null }
  | { kind: 'anti'; hit: RuleHit }
  | { kind: 'missing' }
  | { kind: 'deferred'; reason: 'prefilter' | 'short' };

/**
 * check_listing() for one item. `titleOnly` is the card on the results page,
 * before the description is known; there the keyword gate rejects only with
 * the title prefilter on.
 */
export function checkListing(
  rules: { keywords: readonly string[]; antikeywords: readonly string[] },
  title: string,
  description: string,
  opts: { titleOnly: boolean; prefilter: boolean },
): ListingVerdict {
  const desc = opts.titleOnly ? '' : description;
  const anti = firstHit(rules.antikeywords, `${title} ${desc}`);
  if (anti) return { kind: 'anti', hit: anti };
  if (!rules.keywords.length) return { kind: 'pass', hit: null };
  const hit = firstHit(rules.keywords, `${title}  ${desc}`);
  if (hit) return { kind: 'pass', hit };
  if (!opts.titleOnly) return { kind: 'missing' };
  if (!opts.prefilter) return { kind: 'deferred', reason: 'prefilter' };
  if (title.split(/\s+/).filter(Boolean).length < MIN_TITLE_WORDS) return { kind: 'deferred', reason: 'short' };
  return { kind: 'missing' };
}
