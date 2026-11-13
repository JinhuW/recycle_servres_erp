import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fbChatConfigValue,
  type FbChatConfigEntry, type FbChatConfigPage, type FbChatKnownConfigField, type FbChatTelegramStatus,
} from '@recycle-erp/shared';
import { handleFetchError } from '../../../../lib/errorToast';
import { FB_CHAT_POLL_MS, fbChatAccountName, fbChatApi, usePolled } from '../../../../lib/fbChat';
import { useT } from '../../../../lib/i18n';
import type { FbChatTabProps } from './FbChatsPage';
import {
  SETTINGS_COPY, accountsThatDiffer, draftOf, groupSettings, hasOwnValue, itemKeys, orphanEntries, parseDraft,
  rangeCommit, settingProblem,
  type Range, type SettingMessage, type SettingsItem,
} from './SettingsModel';
import { LoadState, fbcHueStyle } from './shared';
import '../../../../styles/fbChatSettings.css';

// ─── Leads ▸ Facebook ▸ Settings ──────────────────────────────────────────────
// What the chat extensions load from the ERP. The form is not a fixed list: it
// is drawn from the fields the extensions report, so a new setting needs only
// an extension release. A value is set for every account or for one, and an
// extension picks a change up at its next settings check.

type Write = { key: string; value: unknown };
type ScopeAccount = { id: number; no: number; label: string; fb_uid: string };
type SectionId = 'sending' | 'reading' | 'telegram';
type Translate = ReturnType<typeof useT>['t'];

const SECTIONS: { id: SectionId; key: string }[] = [
  { id: 'sending', key: 'fbcs_sending' },
  { id: 'reading', key: 'fbcs_reading' },
  { id: 'telegram', key: 'fbcs_telegram' },
];
const sectionDomId = (id: SectionId) => `fbcs-${id}`;
// A section counts as current once its heading is this close to the top.
const NAV_OFFSET_PX = 120;
// Topics are made as chats arrive; the count is a glance, not a live figure.
const TELEGRAM_POLL_MS = 60_000;

export function SettingsTab({ showToast }: FbChatTabProps) {
  const { t } = useT();
  // null: the value for every account; otherwise one account's own.
  const [scope, setScope] = useState<number | null>(null);
  const config = usePolled(fbChatApi.config, FB_CHAT_POLL_MS.accounts);
  // The config page's accounts carry no display number; this read does.
  const accounts = usePolled(fbChatApi.accounts, FB_CHAT_POLL_MS.accounts);
  const telegram = usePolled(fbChatApi.telegram, TELEGRAM_POLL_MS);

  if (!config.data) {
    return (
      <LoadState
        failed={config.failed} loading={t('fbcs_loading')} failedText={t('fbcs_loadFailed')} retryText={t('fbcs_tryAgain')}
        onRetry={() => void config.reload()}
      />
    );
  }

  // Reads again whatever happened: a range is two writes, and the first may
  // have landed when the second fails.
  const save = async (writes: Write[]) => {
    try {
      for (const w of writes) await fbChatApi.setConfig(w.key, scope, w.value);
      showToast?.(t('fbcs_saved'), 'success');
    } finally {
      await config.reload();
    }
  };
  const reset = async (keys: string[]) => {
    try {
      for (const key of keys) await fbChatApi.resetConfig(key, scope);
      showToast?.(t('fbcs_saved'), 'success');
    } finally {
      await config.reload();
    }
  };

  return (
    <SettingsForm
      page={config.data}
      accounts={accounts.data?.accounts ?? []}
      telegram={telegram.data}
      scope={scope}
      onScope={setScope}
      onSave={save}
      onReset={reset}
    />
  );
}

export function SettingsForm({ page, accounts, telegram, scope, onScope, onSave, onReset }: {
  page: FbChatConfigPage;
  accounts: ScopeAccount[];
  telegram: FbChatTelegramStatus | null;
  scope: number | null;
  onScope: (scope: number | null) => void;
  onSave: (writes: Write[]) => Promise<void>;
  onReset: (keys: string[]) => Promise<void>;
}) {
  const { t, locale } = useT();
  const root = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<SectionId>('sending');

  // The tab body scrolls, not the window, so the nav follows that element.
  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.fbc-scroll');
    if (!scroller) return;
    const follow = () => {
      const top = scroller.getBoundingClientRect().top;
      let at: SectionId = 'sending';
      for (const s of SECTIONS) {
        const el = document.getElementById(sectionDomId(s.id));
        if (el && el.getBoundingClientRect().top - top < NAV_OFFSET_PX) at = s.id;
      }
      // The last section is too short to reach the top on a tall window.
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        at = SECTIONS[SECTIONS.length - 1]!.id;
      }
      setCurrent(at);
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    return () => scroller.removeEventListener('scroll', follow);
  }, []);

  const groups = groupSettings(page.fields);
  const orphans = orphanEntries(page, scope);
  const account = scope === null ? null : accounts.find((a) => a.id === scope) ?? null;

  const row = (item: SettingsItem) => {
    const keys = itemKeys(item);
    const shared = {
      scope,
      accountNo: account?.no ?? null,
      own: hasOwnValue(page.entries, keys, scope),
      differ: scope === null ? accountsThatDiffer(page.entries, keys) : 0,
      onSave,
      onReset: () => onReset(keys.filter((k) => hasOwnValue(page.entries, [k], scope))),
    };
    // Keyed by scope too, so a draft typed for one account never shows on another.
    const key = `${scope}:${item.id}`;
    return item.kind === 'range'
      ? <RangeRow key={key} {...shared} lo={item.lo} hi={item.hi}
          value={{ lo: Number(fbChatConfigValue(page, item.lo.key, scope)), hi: Number(fbChatConfigValue(page, item.hi.key, scope)) }} />
      : <FieldRow key={key} {...shared} field={item.field} known={item.known} value={fbChatConfigValue(page, item.field.key, scope)} />;
  };

  const scopeBar = (
    <div className="fbcs-scope">
      <span>{t('fbcs_editing')}</span>
      <select
        className="input"
        aria-label={t('fbcs_scopeLabel')}
        value={scope ?? ''}
        onChange={(e) => onScope(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{t('fbcs_everyAccount')}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>#{a.no} {fbChatAccountName(a)}</option>)}
      </select>
      <span className="fbcs-scope-hint">{scope === null ? t('fbcs_hintAll') : t('fbcs_hintOne')}</span>
    </div>
  );
  const none = <div className="fbcs-none">{t('fbcs_noFields')}</div>;

  return (
    <div className="fbcs-grid" ref={root}>
      <nav className="fbcs-nav" aria-label={t('fbcs_sections')}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={current === s.id ? 'on' : ''}
            aria-current={current === s.id ? 'true' : undefined}
            onClick={() => {
              setCurrent(s.id);
              document.getElementById(sectionDomId(s.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >{t(s.key)}</button>
        ))}
      </nav>
      <div>
        <Section id="sending" title={t('fbcs_sending')} sub={t('fbcs_sendingSub')}>
          <div className="card">
            {scopeBar}
            <div className="fbcs-fields">{groups.send.length ? groups.send.map(row) : none}</div>
          </div>
        </Section>

        <Section id="reading" title={t('fbcs_reading')} sub={t('fbcs_readingSub')}>
          <div className="card">
            {scopeBar}
            <div className="fbcs-fields">{groups.read.length ? groups.read.map(row) : none}</div>
            {(groups.adv.length > 0 || orphans.length > 0) && (
              <details className="fbcs-adv">
                <summary>{t('fbcs_advanced')}</summary>
                <div className="fbcs-fields">
                  {groups.adv.map(row)}
                  {orphans.map((e) => <OrphanRow key={`${scope}:${e.key}`} entry={e} onReset={() => onReset([e.key])} />)}
                </div>
              </details>
            )}
          </div>
        </Section>

        <Section id="telegram" title={t('fbcs_telegram')} sub={t('fbcs_telegramSub')}>
          <div className="card"><div className="fbcs-tg">
            <div>
              <small>{t('fbcs_tgBot')}</small>
              {telegram === null ? <b>–</b> : (
                <b className={`fbc-health ${telegram.configured ? 'fbc-h-running' : 'fbc-h-stale'}`}>
                  <i />{t(telegram.configured ? 'fbcs_tgConnected' : 'fbcs_tgNotSetUp')}
                </b>
              )}
              <p>{t('fbcs_tgBotSub')}</p>
            </div>
            <div>
              <small>{t('fbcs_tgTopics')}</small>
              <b>{telegram === null ? '–' : telegram.topics.toLocaleString(locale)}</b>
              <p>{t('fbcs_tgTopicsSub')}</p>
            </div>
            <div>
              <small>{t('fbcs_tgAlerts')}</small>
              <b>{t('fbcs_tgAlertsValue')}</b>
              <p>{t('fbcs_tgAlertsSub')}</p>
            </div>
          </div></div>
        </Section>
      </div>
    </div>
  );
}

function Section({ id, title, sub, children }: { id: SectionId; title: string; sub: string; children: ReactNode }) {
  return (
    <section className="fbcs-sec" id={sectionDomId(id)}>
      <header><h3>{title}</h3><p>{sub}</p></header>
      {children}
    </section>
  );
}

type RowShared = {
  scope: number | null;
  /** The scoped account's display number, for the tint of a row it overrides. */
  accountNo: number | null;
  /** The scope holds a value of its own for this row. */
  own: boolean;
  /** On "Every account": how many accounts hold their own value. */
  differ: number;
  onSave: (writes: Write[]) => Promise<void>;
  onReset: () => Promise<void>;
};

/** One save or reset at a time per row; a failure opens the usual error dialog. */
function useBusy(): [boolean, (work: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  return [busy, run];
}

const say = (t: Translate, m: SettingMessage) => t(m.key, m.vars);

function boundsText(t: Translate, b: { min?: number; max?: number; unit: string; def: string }): string {
  const withUnit = (key: string, vars: Record<string, string | number>) => t(key, { ...vars, unit: b.unit }).trim();
  const limits = b.min !== undefined && b.max !== undefined ? withUnit('fbcs_boundsRange', { min: b.min, max: b.max })
    : b.min !== undefined ? withUnit('fbcs_boundsMin', { min: b.min })
      : b.max !== undefined ? withUnit('fbcs_boundsMax', { max: b.max })
        : null;
  const def = t('fbcs_default', { value: b.def });
  return limits ? `${limits} · ${def}` : def;
}

function RowFrame({ shared, busy, label, help, code, error, children }: {
  shared: RowShared; busy: boolean; label: string; help?: string; code?: string; error: string | null; children: ReactNode;
}) {
  const { t } = useT();
  const { scope, accountNo, own, differ, onReset } = shared;
  const tinted = scope !== null && own;
  return (
    <div className={`fbcs-field${tinted ? ' fbcs-own fbc-acct' : ''}`} style={tinted && accountNo !== null ? fbcHueStyle(accountNo) : undefined}>
      <div>
        <div className="fbcs-label">{label}{code && <code>{code}</code>}</div>
        {help && <p>{help}</p>}
        {error && <p className="fbcs-error" role="alert">{error}</p>}
      </div>
      <div>{children}</div>
      <div className="fbcs-note">
        {scope !== null
          ? own
            ? <><b>{t('fbcs_thisAccount')}</b><button type="button" disabled={busy} onClick={() => void onReset()}>{t('fbcs_useEvery')}</button></>
            : t('fbcs_everyAccount')
          : (
            <>
              {differ > 0 && t('fbcs_differ', { n: differ })}
              {own && <button type="button" disabled={busy} onClick={() => void onReset()}>{t('fbcs_resetDefault')}</button>}
            </>
          )}
      </div>
    </div>
  );
}

function FieldRow({ field, known, value, ...shared }: RowShared & { field: FbChatKnownConfigField; known: boolean; value: unknown }) {
  const { t } = useT();
  const copy = known ? SETTINGS_COPY[field.key] : undefined;
  const label = known ? t(`fbcs_f_${field.key}`) : field.label;
  const help = known ? t(`fbcs_f_${field.key}Help`) : field.help;
  const unit = known ? (copy?.unit ? t(copy.unit) : '') : field.unit ?? '';

  const [draft, setDraft] = useState(draftOf(field, value));
  const [error, setError] = useState<string | null>(null);
  const [busy, run] = useBusy();
  // A value that changed underneath (another manager, a reset) replaces the draft.
  const stored = JSON.stringify(value);
  useEffect(() => { setDraft(draftOf(field, value)); setError(null); }, [stored]);

  const commit = (next: unknown) => {
    const problem = settingProblem(field, next);
    if (problem) { setError(say(t, problem)); return; }
    setError(null);
    void run(() => shared.onSave([{ key: field.key, value: next }]));
  };
  const commitDraft = () => {
    if (draft === draftOf(field, value)) return;
    const parsed = parseDraft(field, draft);
    if ('error' in parsed) setError(say(t, parsed.error));
    else commit(parsed.value);
  };

  const numeric = field.type === 'integer' || field.type === 'number';
  const def = boundsText(t, { min: numeric ? field.min : undefined, max: numeric ? field.max : undefined, unit, def: draftOf(field, field.default) });
  let control: ReactNode;
  if (field.type === 'boolean') {
    control = (
      <button
        type="button"
        role="switch"
        className={`fbcs-sw${copy?.caution ? ' caution' : ''}`}
        aria-checked={value === true}
        aria-label={label}
        disabled={busy}
        onClick={() => commit(value !== true)}
      />
    );
  } else if (field.type === 'string' && field.options) {
    control = (
      <>
        <select className="input" aria-label={label} value={String(value)} disabled={busy} onChange={(e) => commit(e.target.value)}>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <div className="fbcs-bounds">{def}</div>
      </>
    );
  } else if (field.type === 'json') {
    control = (
      <>
        <textarea className="input mono" rows={4} aria-label={label} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
        <div className="fbcs-json-save">
          <button type="button" className="btn sm" disabled={busy || draft === draftOf(field, value)} onClick={commitDraft}>{t('fbcs_save')}</button>
        </div>
      </>
    );
  } else {
    control = (
      <>
        <div className="fbcs-unit">
          <input
            className="input"
            type={numeric ? 'number' : 'text'}
            min={field.min}
            max={field.max}
            step={numeric ? copy?.step ?? (field.type === 'integer' ? 1 : 'any') : undefined}
            aria-label={label}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          {unit && <span>{unit}</span>}
        </div>
        <div className="fbcs-bounds">{def}</div>
      </>
    );
  }

  return (
    <RowFrame shared={shared} busy={busy} label={label} help={help} code={known ? undefined : field.key} error={error}>
      {control}
    </RowFrame>
  );
}

function RangeRow({ lo, hi, value, ...shared }: RowShared & {
  lo: FbChatKnownConfigField; hi: FbChatKnownConfigField; value: Range;
}) {
  const { t } = useT();
  const unit = t(SETTINGS_COPY.inboxRefresh!.unit!);
  const asDraft = (r: Range) => ({ lo: String(r.lo), hi: String(r.hi) });
  const [draft, setDraft] = useState(asDraft(value));
  const [error, setError] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const stored = useRef(value);
  stored.current = value;
  // Typed into and not yet committed. The inputs stay live while a save runs
  // (the natural edit is shortest, Tab, longest), so what is being typed must
  // survive the stored value changing underneath it.
  const dirty = useRef(false);
  // Where the saves still on their way take the range, and the saves in order.
  const heading = useRef<Range | null>(null);
  const saves = useRef(Promise.resolve());
  useEffect(() => {
    if (dirty.current) return;
    setDraft(asDraft(value));
    setError(null);
  }, [value.lo, value.hi]);

  // The row commits as one, when focus leaves both inputs: committing each
  // end on its own blur would save a half-typed range in between.
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    const result = rangeCommit(heading.current ?? value, draft, lo, hi);
    if ('error' in result) { setError(say(t, result.error)); return; }
    setError(null);
    setDraft(asDraft(result.next));
    // A longest typed under the shortest snaps back to where it already was.
    if (!result.writes.length) return;
    const { next, writes } = result;
    heading.current = next;
    saves.current = saves.current.then(() => run(() => shared.onSave(writes))).then(() => {
      if (heading.current !== next) return;
      heading.current = null;
      // A save that failed left the stored range where it was; show that.
      if (!dirty.current) setDraft(asDraft(stored.current));
    });
  };

  const input = (end: 'lo' | 'hi', field: FbChatKnownConfigField, label: string) => (
    <input
      className="input"
      type="number"
      min={field.min}
      max={field.max}
      step={field.type === 'integer' ? 1 : 'any'}
      aria-label={label}
      value={draft[end]}
      onChange={(e) => { dirty.current = true; setDraft({ ...draft, [end]: e.target.value }); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );

  return (
    <RowFrame shared={shared} busy={busy} label={t('fbcs_f_inboxRefresh')} help={t('fbcs_f_inboxRefreshHelp')} error={error}>
      <div className="fbcs-range" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) commit(); }}>
        {input('lo', lo, t('fbcs_shortest'))}
        <span>{t('fbcs_rangeTo')}</span>
        {input('hi', hi, t('fbcs_longest'))}
        <span>{unit}</span>
      </div>
      <div className="fbcs-bounds">
        {boundsText(t, { min: lo.min, max: hi.max, unit, def: `${String(lo.default)}–${String(hi.default)}` })}
      </div>
    </RowFrame>
  );
}

// A value set here that no recent extension reports. There is no field to
// draw a control from, so it shows as stored and can only be removed.
function OrphanRow({ entry, onReset }: { entry: FbChatConfigEntry; onReset: () => Promise<void> }) {
  const { t } = useT();
  const [busy, run] = useBusy();
  return (
    <div className="fbcs-field">
      <div>
        <div className="fbcs-label"><code className="fbcs-key">{entry.key}</code></div>
        <p>{t('fbcs_orphan')}</p>
      </div>
      <div><code className="fbcs-raw">{typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}</code></div>
      <div className="fbcs-note">
        <button type="button" disabled={busy} onClick={() => void run(onReset)}>{t('fbcs_remove')}</button>
      </div>
    </div>
  );
}
