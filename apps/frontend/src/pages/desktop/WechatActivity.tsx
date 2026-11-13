import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { WechatActivity, WechatActivityDay, WechatActivityGroup } from '@recycle-erp/shared';
import { Skeleton } from '../../components/Skeleton';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { navigate, wechatDayPath } from '../../lib/route';
import { useElementWidth } from '../../lib/useElementWidth';
import { wechatApi } from '../../lib/wechatMarket';
import { niceStep } from './DashboardChart';

// ─── Monitors ▸ WeChat ▸ Activity ─────────────────────────────────────────────
// How much the trading groups talked, day by day and hour by hour, so a thin
// report can be told from a quiet market: the office Mac's WeChat logged out,
// a group gone silent, or a morning nobody posted. Everything here comes from
// what memtrade pushed with each report day; the selected day is the last one.

const RANGES = [14, 30, 60] as const;
type Range = (typeof RANGES)[number];
const DAY_H = 168;
const DAY_PAD = { t: 12, b: 34 };
const HOUR_H = 128;
const HOUR_PAD = { t: 18, b: 22 };
// An hour-long hole is ordinary at night; three in a row is worth a band.
const QUIET_RUN_H = 3;
const HEAT_ROWS = 24;
const REPORT_TZ = 'America/New_York';

export function ActivityTab({ until }: { until: string | null }) {
  const { t, locale } = useT();
  const [range, setRange] = useState<Range>(30);
  const [data, setData] = useState<WechatActivity | null>(null);
  useEffect(() => {
    if (!until) return;
    let alive = true;
    setData(null);
    wechatApi.activity(until, range).then(d => { if (alive) setData(d); }).catch(handleFetchError);
    return () => { alive = false; };
  }, [until, range]);

  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const days = data?.days ?? null;
  const today = days?.at(-1) ?? null;

  return (
    <div className="wx-activity">
      <section className="card" aria-label={t('wxActDailyTitle')}>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('wxActDailyTitle')}</h2>
            <span className="card-sub">{t('wxActDailySub')}</span>
          </div>
          <div className="seg wx-act-range" role="group" aria-label={t('wxActRange')}>
            {RANGES.map(r => (
              <button key={r} type="button" className={r === range ? 'active' : ''} aria-pressed={r === range}
                onClick={() => setRange(r)}>{t('wxActDays', { n: r })}</button>
            ))}
          </div>
        </div>
        <div className="card-body">
          {!days ? <Skeleton width="100%" height={DAY_H + 64} /> : <>
            {today && <DayFigures days={days} fmt={fmt} />}
            <DailyChart days={days} fmt={fmt} locale={locale} />
          </>}
        </div>
      </section>

      <section className="card" aria-label={t('wxActHoursTitle')}>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('wxActHoursTitle')}</h2>
            <span className="card-sub">{t('wxActHoursSub')}</span>
          </div>
        </div>
        <div className="card-body">
          {!data || !today ? <Skeleton width="100%" height={HOUR_H} />
            : data.hours.length === 0 ? <p className="fp-muted wx-chart-empty">{t('wxActHoursNone')}</p>
            : <HourChart hours={data.hours} start={today.windowStart} fmt={fmt} locale={locale} />}
        </div>
      </section>

      <section className="card" aria-label={t('wxActGroupsTitle')}>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('wxActGroupsTitle')}</h2>
            <span className="card-sub">{t('wxActGroupsSub')}</span>
          </div>
        </div>
        <div className="card-body">
          {!data ? <Skeleton width="100%" height={260} />
            : <GroupHeat days={data.days} groups={data.groups} fmt={fmt} locale={locale} />}
        </div>
      </section>
    </div>
  );
}

// ── The selected day against the week before it ──────────────────────────────

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function DayFigures({ days, fmt }: { days: WechatActivityDay[]; fmt: Intl.NumberFormat }) {
  const { t } = useT();
  const day = days.at(-1)!;
  const before = days.slice(-8, -1);
  const figures: { key: string; label: string; value: string; now: number; pick: (d: WechatActivityDay) => number }[] = [
    { key: 'messages', label: t('wxActMessages'), value: fmt.format(day.messages), now: day.messages, pick: d => d.messages },
    {
      key: 'groups', label: t('wxActGroupsActive'), value: `${fmt.format(day.groupsActive)} / ${fmt.format(day.groupsTotal)}`,
      now: day.groupsActive, pick: d => d.groupsActive,
    },
    { key: 'posts', label: t('wxActPosts'), value: fmt.format(day.posts), now: day.posts, pick: d => d.posts },
    {
      key: 'traders', label: t('wxActTraders'), value: `${fmt.format(day.buyers)} / ${fmt.format(day.sellers)}`,
      now: day.buyers + day.sellers, pick: d => d.buyers + d.sellers,
    },
  ];
  return (
    <dl className="wx-act-figs">
      {figures.map(f => {
        const base = median(before.map(f.pick));
        const pct = base ? Math.round(((f.now - base) / base) * 100) : null;
        const off = pct !== null && Math.abs(pct) >= 25;
        return (
          <div key={f.key} className="wx-act-fig">
            <dt>{f.label}</dt>
            <dd>
              <b>{f.value}</b>
              {pct === null ? <small>{t('wxActNoBase')}</small> : (
                <small className={off && pct < 0 ? 'is-low' : undefined}>
                  {t('wxActVsWeek', { pct: `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%` })}
                </small>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ── Messages per report day ───────────────────────────────────────────────────

function DailyChart({ days, fmt, locale }: { days: WechatActivityDay[]; fmt: Intl.NumberFormat; locale: string }) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale]);
  const label = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));
  if (!days.length) return <p className="fp-muted wx-chart-empty">{t('wxActEmpty')}</p>;

  const n = days.length;
  const hi = Math.max(1, ...days.map(d => d.messages));
  const step = niceStep(hi / 3);
  const yMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v);
  const padL = 12 + Math.max(...ticks.map(v => fmt.format(v).length)) * 6.6;
  const innerW = Math.max(0, width - padL - 8);
  const innerH = DAY_H - DAY_PAD.t - DAY_PAD.b;
  const slot = innerW / n;
  const barW = Math.max(2, Math.min(22, slot - 4));
  const cx = (i: number) => padL + slot * (i + 0.5);
  const y = (v: number) => DAY_PAD.t + ((yMax - v) / yMax) * innerH;
  const every = Math.max(1, Math.ceil(52 / Math.max(1, slot)));
  const idxAt = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor((clientX - r.left - padL) / slot)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setHover(h => Math.max(0, (h ?? n - 1) - 1));
    else if (e.key === 'ArrowRight') setHover(h => Math.min(n - 1, (h ?? n - 1) + 1));
    else if (e.key === 'Enter' && hover !== null) navigate(wechatDayPath(days[hover]!.date));
    else return;
    e.preventDefault();
  };
  const h = hover !== null ? days[hover]! : null;

  return (
    <div className="wx-hist wx-act-daily" ref={wrap}>
      <svg width={Math.max(1, width)} height={DAY_H} role="img"
        aria-label={t('wxActDailyAria', { from: label(days[0]!.date), to: label(days[n - 1]!.date) })}>
        {ticks.map(v => (
          <g key={v}>
            <line className="wx-hist-grid" x1={padL} x2={padL + innerW} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="wx-hist-tick" x={padL - 8} y={y(v) + 3.5} textAnchor="end">{fmt.format(v)}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const top = y(d.messages);
          const bh = Math.max(0, DAY_PAD.t + innerH - top);
          return (
            <g key={d.date} className={`wx-act-day${i === n - 1 ? ' is-current' : ''}${hover === i ? ' is-hover' : ''}`}>
              {bh > 0 && (
                <path className="wx-act-bar"
                  d={roundedTop(cx(i) - barW / 2, top, barW, bh, Math.min(4, barW / 2))} />
              )}
              {d.warnings.length > 0 && (
                <path className="wx-act-flag" d={flag(cx(i), DAY_PAD.t + innerH + 7)}>
                  <title>{d.warnings.join('\n')}</title>
                </path>
              )}
            </g>
          );
        })}
        {days.map((d, i) => (n - 1 - i) % every === 0 && (
          <text key={d.date} className={`wx-hist-day${i === n - 1 ? ' is-current' : ''}`}
            x={cx(i)} y={DAY_H - 6} textAnchor="middle">{label(d.date)}</text>
        ))}
        <rect className="wx-hist-hit wx-act-hit" tabIndex={0} x={padL} y={DAY_PAD.t} width={innerW} height={innerH + 14}
          aria-label={t('wxActDailyKeys')}
          onPointerMove={e => setHover(idxAt(e.clientX))} onPointerLeave={() => setHover(null)}
          onClick={e => navigate(wechatDayPath(days[idxAt(e.clientX)]!.date))}
          onFocus={() => setHover(n - 1)} onBlur={() => setHover(null)} onKeyDown={onKey} />
      </svg>
      {h && hover !== null && (
        <div className="wx-hist-tip wx-act-tip" role="status"
          style={cx(hover) > width / 2 ? { right: width - cx(hover) + 14 } : { left: cx(hover) + 14 }}>
          <div className="wx-hist-tip-title">{label(h.date)}</div>
          <dl>
            <dt>{t('wxActMessages')}</dt><dd>{fmt.format(h.messages)}</dd>
            <dt>{t('wxActGroupsActive')}</dt><dd>{fmt.format(h.groupsActive)} / {fmt.format(h.groupsTotal)}</dd>
            <dt>{t('wxActPosts')}</dt><dd>{fmt.format(h.posts)}</dd>
            <dt>{t('wxActTraders')}</dt><dd>{fmt.format(h.buyers)} / {fmt.format(h.sellers)}</dd>
          </dl>
          {h.degraded && <p className="wx-act-tip-note">{t('wxActDegraded')}</p>}
          {h.warnings.map(w => <p key={w} className="wx-act-tip-note">{w}</p>)}
          <p className="wx-act-tip-hint">{t('wxActOpenDay')}</p>
        </div>
      )}
    </div>
  );
}

const roundedTop = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};
// A small upward triangle under a day memtrade warned about.
const flag = (x: number, y: number) => `M${x - 4},${y + 6}L${x},${y}L${x + 4},${y + 6}Z`;

// ── Trade posts by hour of the selected day ───────────────────────────────────

function HourChart({ hours, start, fmt, locale }: {
  hours: number[]; start: string; fmt: Intl.NumberFormat; locale: string;
}) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const t0 = Date.parse(start);
  const hourFmt = useMemo(() => new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: REPORT_TZ }), [locale]);
  const at = (i: number) => hourFmt.format(new Date(t0 + i * 3_600_000));

  const n = hours.length;
  const hi = Math.max(1, ...hours);
  const padL = 8;
  const innerW = Math.max(0, width - padL * 2);
  const innerH = HOUR_H - HOUR_PAD.t - HOUR_PAD.b;
  const slot = innerW / n;
  const barW = Math.max(2, slot - 3);
  const x = (i: number) => padL + slot * i;
  const y = (v: number) => HOUR_PAD.t + ((hi - v) / hi) * innerH;
  const runs = quietRuns(hours);
  const idxAt = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor((clientX - r.left - padL) / slot)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setHover(h => Math.max(0, (h ?? 0) - 1));
    else if (e.key === 'ArrowRight') setHover(h => Math.min(n - 1, (h ?? -1) + 1));
    else return;
    e.preventDefault();
  };

  return (
    <div className="wx-hist wx-act-hours" ref={wrap}>
      <svg width={Math.max(1, width)} height={HOUR_H} role="img"
        aria-label={t('wxActHoursAria', { quiet: runs.length })}>
        {runs.map(r => (
          <g key={r.from} className="wx-act-quiet">
            <rect x={x(r.from)} y={HOUR_PAD.t - 14} width={slot * r.len} height={innerH + 14} rx={4} />
            <text x={x(r.from) + 6} y={HOUR_PAD.t - 3}>{t('wxActQuiet', { h: r.len })}</text>
          </g>
        ))}
        <line className="wx-hist-grid" x1={padL} x2={padL + innerW} y1={HOUR_PAD.t + innerH + 0.5} y2={HOUR_PAD.t + innerH + 0.5} />
        {hours.map((v, i) => v > 0 && (
          <path key={i} className={`wx-act-bar${hover === i ? ' is-hover' : ''}`}
            d={roundedTop(x(i) + (slot - barW) / 2, y(v), barW, HOUR_PAD.t + innerH - y(v), Math.min(3, barW / 2))} />
        ))}
        {hours.map((_, i) => i % 3 === 0 && (
          <text key={i} className="wx-hist-day" x={x(i) + slot / 2} y={HOUR_H - 5} textAnchor="middle">{at(i)}</text>
        ))}
        <rect className="wx-hist-hit" tabIndex={0} x={padL} y={HOUR_PAD.t} width={innerW} height={innerH}
          aria-label={t('wxActHoursKeys')}
          onPointerMove={e => setHover(idxAt(e.clientX))} onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(0)} onBlur={() => setHover(null)} onKeyDown={onKey} />
      </svg>
      {hover !== null && (
        <div className="wx-hist-tip wx-act-tip" role="status"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 8 } : { left: x(hover) + slot + 8 }}>
          <div className="wx-hist-tip-title">{at(hover)} – {at(hover + 1)} ET</div>
          <b className="wx-act-tip-big">{t('wxActPostsN', { n: fmt.format(hours[hover]!) })}</b>
        </div>
      )}
    </div>
  );
}

function quietRuns(hours: number[]) {
  const runs: { from: number; len: number }[] = [];
  let from = -1;
  hours.forEach((v, i) => {
    if (v === 0 && from < 0) from = i;
    if ((v !== 0 || i === hours.length - 1) && from >= 0) {
      const end = v === 0 ? i + 1 : i;
      if (end - from >= QUIET_RUN_H) runs.push({ from, len: end - from });
      from = -1;
    }
  });
  return runs;
}

// ── Each group's messages per day ─────────────────────────────────────────────

// Five steps of one hue, cut at the quintiles of the cells that had
// messages: group sizes span three orders of magnitude, and a linear or log
// scale leaves most of the grid in one or two shades.
const HEAT_STEPS = [12, 26, 44, 66, 90];

function heatCuts(groups: WechatActivityGroup[]): number[] {
  const vals = groups.flatMap(g => g.messages.filter((v): v is number => v !== null && v > 0)).sort((a, b) => a - b);
  if (!vals.length) return [];
  return HEAT_STEPS.slice(1).map((_, k) => vals[Math.floor(((k + 1) / HEAT_STEPS.length) * (vals.length - 1))]!);
}

function heatStep(v: number, cuts: number[]) {
  if (v <= 0) return -1;
  let s = 0;
  while (s < cuts.length && v > cuts[s]!) s++;
  return s;
}

function GroupHeat({ days, groups, fmt, locale }: {
  days: WechatActivityDay[]; groups: WechatActivityGroup[]; fmt: Intl.NumberFormat; locale: string;
}) {
  const { t } = useT();
  const [all, setAll] = useState(false);
  const [tip, setTip] = useState<{ g: number; i: number; left: number; top: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale]);
  const label = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));
  if (!groups.length) return <p className="fp-muted wx-chart-empty">{t('wxActEmpty')}</p>;

  const cuts = heatCuts(groups);
  const shown = all ? groups : groups.slice(0, HEAT_ROWS);
  const n = days.length;
  const lastActive = (g: WechatActivityGroup) => {
    for (let i = n - 1; i >= 0; i--) if ((g.messages[i] ?? 0) > 0) return i;
    return -1;
  };
  const hoverAt = (gi: number, i: number, el: HTMLElement) => {
    const box = wrap.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({ g: gi, i, left: r.left - box.left + r.width / 2, top: r.bottom - box.top + 6 });
  };
  const tg = tip ? shown[tip.g] : null;

  return (
    <div className="wx-heat-wrap" ref={wrap} onPointerLeave={() => setTip(null)}>
      <div className="wx-heat" style={{ gridTemplateColumns: `minmax(140px, 220px) repeat(${n}, minmax(8px, 1fr)) auto` }}
        role="table" aria-label={t('wxActGroupsTitle')}>
        <div role="row" className="wx-heat-row wx-heat-head">
          <span role="columnheader">{t('wxColGroup')}</span>
          {days.map((d, i) => (
            <span key={d.date} role="columnheader" className="wx-heat-day" aria-label={label(d.date)}>
              {(n - 1 - i) % Math.max(1, Math.ceil(n / 8)) === 0 ? label(d.date) : ''}
            </span>
          ))}
          <span role="columnheader" className="wx-num wx-heat-last">{t('wxActLastHeard')}</span>
        </div>
        {shown.map((g, gi) => {
          const last = lastActive(g);
          const quiet = last >= 0 && n - 1 - last >= 2;
          return (
            <div key={g.id} role="row" className="wx-heat-row">
              <span role="rowheader" className="wx-heat-name" title={g.name || g.id}>{g.name || g.id}</span>
              {g.messages.map((v, i) => {
                const s = v === null ? null : heatStep(v, cuts);
                return (
                  <span key={i} role="cell" tabIndex={-1}
                    className={`wx-heat-cell${v === null ? ' is-absent' : s! < 0 ? ' is-zero' : ''}`}
                    style={s !== null && s >= 0 ? { ['--heat' as string]: `${HEAT_STEPS[s]}%` } : undefined}
                    aria-label={`${label(days[i]!.date)}: ${v === null ? t('wxActAbsent') : fmt.format(v)}`}
                    onPointerEnter={e => hoverAt(gi, i, e.currentTarget)} />
                );
              })}
              <span role="cell" className={`wx-num wx-heat-last${quiet ? ' is-quiet' : ''}`}>
                {last < 0 ? t('wxActNever') : last === n - 1 ? t('wxActToday') : label(days[last]!.date)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="wx-heat-foot">
        <span className="wx-heat-key" aria-hidden>
          {t('wxActFewer')}
          {HEAT_STEPS.map(p => <i key={p} style={{ ['--heat' as string]: `${p}%` }} />)}
          {t('wxActMore')}
          <i className="is-absent" />{t('wxActAbsent')}
        </span>
        {groups.length > HEAT_ROWS && (
          <button type="button" className="btn sm" onClick={() => setAll(a => !a)}>
            {all ? t('wxActFewerGroups', { n: HEAT_ROWS }) : t('wxActAllGroups', { n: groups.length })}
          </button>
        )}
      </div>
      {tip && tg && (
        <div className="wx-hist-tip wx-act-tip wx-heat-tip" role="status"
          style={{ left: tip.left, top: tip.top, transform: 'translateX(-50%)' }}>
          <div className="wx-hist-tip-title">{tg.name || tg.id} · {label(days[tip.i]!.date)}</div>
          {tg.messages[tip.i] === null ? <span className="fp-muted">{t('wxActAbsent')}</span> : (
            <dl>
              <dt>{t('wxActMessages')}</dt><dd>{fmt.format(tg.messages[tip.i]!)}</dd>
              <dt>{t('wxActCandidates')}</dt><dd>{fmt.format(tg.candidates[tip.i] ?? 0)}</dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
