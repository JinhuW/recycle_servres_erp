#!/usr/bin/env python
"""Mine the monitor log and coordinator DB into a compact keyword-evidence pack.

The point of this script is that the log is 500KB of Rich-wrapped prose and no
model should be asked to reason over it directly. Everything here is counting:
which search phrases Facebook refused, which titles the title-only keyword gate
threw away, which antikeyword did the throwing, and what the AI actually said.
The judgement calls are left to the report step that consumes this output.

    .venv-aimm/bin/python scripts/eval-keywords.py [--since HOURS] > pack.md
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import pathlib
import re
import sqlite3
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Rich's console layout: 20 cols of timestamp, 9 of level, then the message.
# A blank level column means the line is a wrap of the record above it.
TS_W, LVL_W = 20, 29

# Same notion of "actually server hardware" that probe_phrases.py measures with,
# kept identical on purpose so the two tools agree on what a hit looks like.
ON_TARGET = re.compile(
    r"\b(ecc|rdimm|lrdimm|registered|pc3|pc4|pc5|ddr[345]|dimm|"
    r"ssd|nvme|u\.2|sas|solid\s*state|xeon|epyc)\b",
    re.I,
)
COMPLETE_MACHINE = re.compile(
    r"\b(laptop|notebook|thinkpad|elitebook|macbook|chromebook|latitude|"
    r"probook|inspiron|pavilion|desktop|all-in-one|imac|rog|ally|"
    r"gaming pc|pc\b|workstation|nuc|surface|mini pc|"
    r"poweredge|proliant|supermicro|\bucs\b|rack server|blade server|\d+u rack)\b",
    re.I,
)


def split_terms(rule: str):
    """Split a rendered antikeyword list into its comma-separated terms.

    Terms may contain spaces ("single stick") or be OR-expressions of quoted
    phrases, so a naive word split mangles them — which is why this exists.
    """
    terms, buf, quoted = [], [], False
    for ch in rule:
        if ch == '"':
            quoted = not quoted
            buf.append(ch)
        elif ch == "," and not quoted:
            terms.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        terms.append("".join(buf).strip())
    return [t.rstrip(".") for t in terms if t]


def term_matches(term: str, title: str) -> bool:
    """Whether one antikeyword term (possibly an OR-expression) hits a title."""
    for alt in re.split(r"\s+OR\s+", term):
        alt = alt.strip().strip('"').strip()
        if alt and re.search(rf"\b{re.escape(alt)}", title, re.I):
            return True
    return False


def dedupe(rows, key):
    """Collapse repeats — the same listing is re-seen across cities and passes."""
    seen, out = set(), []
    for row in rows:
        k = key(row)
        if k not in seen:
            seen.add(k)
            out.append(row)
    return out


def unwrap(path: pathlib.Path):
    """Yield (timestamp, level, message) with wrapped continuations rejoined."""
    records, cur, ts = [], None, ""
    for line in path.read_text(encoding="utf-8", errors="replace").split("\n"):
        if len(line) < LVL_W:
            if cur and line.strip():
                cur[2] += " " + line.strip()
            continue
        stamp, level, msg = line[:TS_W].strip(), line[TS_W:LVL_W].strip(), line[LVL_W:]
        if stamp:
            ts = stamp
        if level:
            if cur:
                records.append(cur)
            cur = [ts, level, msg.strip()]
        elif cur:
            cur[2] += " " + msg.strip()
    if cur:
        records.append(cur)
    return [(t, lv, re.sub(r"\s+", " ", m).strip()) for t, lv, m in records]


def parse_ts(stamp: str):
    try:
        return dt.datetime.strptime(stamp.strip("[]"), "%m/%d/%y %H:%M:%S")
    except ValueError:
        return None


def configured_phrases():
    """search_phrases declared in master.toml and in each generated worker shard."""
    out = {}
    for path in [ROOT / "configs/master.toml", *sorted((ROOT / "configs/generated").glob("*.toml"))]:
        if not path.exists():
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            out[path.name] = {"__error__": str(exc)}
            continue
        out[path.name] = {
            name: {
                "phrases": body.get("search_phrases", []),
                "enabled": body.get("enabled", True),
                "keywords": body.get("keywords", []),
                "antikeywords": body.get("antikeywords", []),
                "min_price": body.get("min_price"),
                "max_price": body.get("max_price"),
            }
            for name, body in (data.get("item") or {}).items()
        }
    return out


def bullets(counter, limit, fmt="{k} — {v}"):
    return [fmt.format(k=k, v=v) for k, v in counter.most_common(limit)] or ["_none_"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=float, default=24.0, help="hours of log to consider")
    ap.add_argument("--log", default="logs/monitor.out.log")
    ap.add_argument("--db", default="data/coordinator.db")
    args = ap.parse_args()

    log_path = ROOT / args.log
    if not log_path.exists():
        print(f"# Keyword evidence\n\n**No log at {log_path}.** The monitor has not run.")
        return

    records = unwrap(log_path)
    stamps = [parse_ts(t) for t, _, _ in records]
    stamps = [s for s in stamps if s]
    if not stamps:
        print("# Keyword evidence\n\n**Log has no parseable timestamps.**")
        return
    # The log carries no year-safe absolute clock we can trust against "now"
    # (it is a local file that may be stale), so the window is measured from the
    # newest record in the file rather than from wall-clock time.
    newest = max(stamps)
    cutoff = newest - dt.timedelta(hours=args.since)

    failed = collections.Counter()          # phrase -> refusals
    failed_cities = collections.defaultdict(set)
    yields = collections.Counter()          # item -> new listings
    searches = collections.Counter()        # item -> searches run
    cities = collections.Counter()
    gate_drops, anti_drops = [], []
    anti_terms = collections.Counter()
    ai_scores = collections.Counter()
    ai_reasons = collections.Counter()
    wins, notified = [], []
    restarts = 0
    cur_item = None
    per_cycle = []          # failures recorded between consecutive search markers

    for stamp, level, msg in records:
        when = parse_ts(stamp)
        if when and when < cutoff:
            continue
        if msg.startswith("[VERSION]"):
            restarts += 1
        elif m := re.match(r"\[Search\] Searching \w+ for (\S+) from (.+?) with radius", msg):
            cur_item = m.group(1)
            searches[cur_item] += 1
            cities[m.group(2)] += 1
            per_cycle.append(0)
        elif m := re.match(r"\[Search\] Failed to get search results for (.+?) from (\S+)$", msg):
            failed[m.group(1)] += 1
            failed_cities[m.group(1)].add(m.group(2))
            if per_cycle:
                per_cycle[-1] += 1
        elif m := re.match(r"\[Search\] (\d+) new listings? for (\S+) (?:are|is) found", msg):
            yields[m.group(2)] += int(m.group(1))
        elif m := re.match(r"\[Skip\] Exclude (.+?) without required keywords", msg):
            gate_drops.append((cur_item, m.group(1).strip()))
        elif m := re.match(r"\[Skip\] Exclude (.+?) due to excluded keywords: (.+)$", msg):
            title = m.group(1).strip()
            anti_drops.append((cur_item, title, m.group(2)))
            fired = [t for t in split_terms(m.group(2)) if term_matches(t, title)]
            for term in fired or ["(fired on the description, not the title)"]:
                anti_terms[term] += 1
        elif m := re.match(r"\[AI\] \w+ concludes (.+?) \((\d)\): (.*?) for listing (.+)$", msg):
            verdict, score, reason, title = m.groups()
            ai_scores[f"{score} {verdict}"] += 1
            if int(score) >= 4:
                wins.append((int(score), title.strip()))
            else:
                ai_reasons[re.sub(r"\s+", " ", reason).strip().rstrip(".")[:110]] += 1
        elif msg.startswith("[Notify]"):
            notified.append(msg[len("[Notify]"):].strip()[:120])

    # Titles the title-only gate dropped that still look like server hardware —
    # these are the candidate false negatives worth a human eye.
    suspects = dedupe(
        [(i, t) for i, t in gate_drops
         if ON_TARGET.search(t) and not COMPLETE_MACHINE.search(t)],
        key=lambda r: r[1].lower())
    anti_suspects = dedupe(
        [(i, t, rule) for i, t, rule in anti_drops
         if ON_TARGET.search(t) and not COMPLETE_MACHINE.search(t)],
        key=lambda r: r[1].lower())
    wins = dedupe(wins, key=lambda r: r[1].lower())

    cfg = configured_phrases()
    master = cfg.get("master.toml", {})
    master_phrases = {p for body in master.values() if isinstance(body, dict)
                      for p in body.get("phrases", [])}
    gen_phrases = {p for name, items in cfg.items() if name != "master.toml"
                   for body in items.values() if isinstance(body, dict)
                   for p in body.get("phrases", [])}
    seen_phrases = set(failed)
    drift_running = sorted(seen_phrases - master_phrases)
    drift_generated = sorted(gen_phrases - master_phrases)

    out = []
    w = out.append
    w("# Facebook Marketplace — keyword evidence")
    w("")
    w(f"- Log window: **{min(stamps):%Y-%m-%d %H:%M} → {newest:%Y-%m-%d %H:%M}** "
      f"(last {args.since:g}h of a file spanning {(newest - min(stamps)).total_seconds()/3600:.1f}h)")
    w(f"- Monitor starts in window: **{restarts}**")
    w(f"- Searches run: **{sum(searches.values())}** across **{len(cities)}** cities")
    w(f"- Listings retrieved: **{len(gate_drops) + len(anti_drops) + sum(ai_scores.values())}**"
      f" · alerted: **{len(notified)}**")
    w("")

    w("## 1. Per-item yield")
    w("")
    w("| item | searches | new listings | enabled in master.toml |")
    w("| --- | --- | --- | --- |")
    for item in sorted(set(searches) | set(yields) | set(master)):
        body = master.get(item)
        state = "—" if not isinstance(body, dict) else ("yes" if body.get("enabled", True) else "**no**")
        w(f"| `{item}` | {searches.get(item, 0)} | {yields.get(item, 0)} | {state} |")
    w("")

    w("## 2. Search phrases Facebook refused")
    w("")
    spread = collections.Counter(per_cycle)
    if per_cycle and len(spread) == 1:
        n = next(iter(spread))
        w(f"> **Read this before ranking anything below.** Every one of the "
          f"**{len(per_cycle)}** search cycles recorded exactly **{n}** failure — "
          f"never more, never fewer. That is a fixed per-cycle tax that rotates "
          f"across whichever phrase is unlucky, not evidence that any particular "
          f"phrase is dead. Refusal counts here rank nothing; they track how often "
          f"a phrase was searched. Treat a phrase as dead only if a probe confirms "
          f"it, and investigate the per-cycle failure itself as a bug.")
    else:
        w(f"Failures per search cycle: "
          f"{', '.join(f'{k}×{v}' for k, v in sorted(spread.items()))}. A phrase that "
          f"dominates this table beyond its search share is a genuine dead phrase; a "
          f"flat distribution across phrases is a per-cycle artifact instead.")
    w("")
    w("`Failed to get search results` means that attempt returned nothing usable.")
    w("")
    if failed:
        w("| phrase | refusals | cities | in master.toml |")
        w("| --- | --- | --- | --- |")
        for phrase, n in failed.most_common(40):
            w(f"| `{phrase}` | {n} | {len(failed_cities[phrase])} | "
              f"{'yes' if phrase in master_phrases else '**NO — drift**'} |")
    else:
        w("_No failed searches in window._")
    w("")

    w("## 3. Config drift")
    w("")
    w("master.toml is the source of truth; configs/generated/ is what the fleet")
    w("actually runs. They diverge whenever `rsc gen-configs` has not been re-run.")
    w("")
    w(f"- Phrases the running fleet searched that master.toml does not declare: "
      f"**{len(drift_running)}**")
    for phrase in drift_running:
        w(f"  - `{phrase}`")
    if not drift_running:
        w("  - _none_")
    w("")

    # Per-item field diff against one representative shard. All shards are
    # generated from the same master, so a single comparison finds the drift;
    # any shard that disagrees with its siblings is called out separately.
    shards = {k: v for k, v in cfg.items() if k != "master.toml"}
    if shards:
        w("Field-level diff, master.toml vs generated shards:")
        w("")
        w("| item | field | master.toml | generated | shards affected |")
        w("| --- | --- | --- | --- | --- |")
        rows = 0
        for item in sorted(master):
            m_body = master.get(item)
            if not isinstance(m_body, dict):
                continue
            for field in ("phrases", "keywords", "antikeywords", "enabled",
                          "min_price", "max_price"):
                differing = {
                    name: items[item].get(field)
                    for name, items in shards.items()
                    if isinstance(items.get(item), dict)
                    and items[item].get(field) != m_body.get(field)
                }
                if not differing:
                    continue
                rows += 1
                got = sorted({repr(v) for v in differing.values()})
                w(f"| `{item}` | `{field}` | `{m_body.get(field)!r}` | "
                  f"{' / '.join('`' + g + '`' for g in got)} | "
                  f"{len(differing)}/{len(shards)} |")
        # Items present in one side only.
        for item in sorted(set().union(*[set(v) for v in shards.values()]) - set(master)):
            rows += 1
            w(f"| `{item}` | _whole item_ | absent | present | ? |")
        if not rows:
            w("| — | — | — | _no differences_ | — |")
    w("")

    w("## 4. Title-gate rejections (`keywords`)")
    w("")
    w(f"Total dropped before the description was ever fetched: **{len(gate_drops)}**. ")
    w(f"Of those, **{len(suspects)}** distinct titles still look like server hardware —")
    w("candidate")
    w("false negatives caused by the gate running against the title alone:")
    w("")
    for item, t in suspects[:40]:
        w(f"- `{item or '?'}` — {t[:130]}")
    if not suspects:
        w("- _none_")
    w("")

    w("## 5. Antikeyword rejections")
    w("")
    w("Which antikeyword actually matched the title, by volume (recomputed here —")
    w("the log prints the whole rule list, not the term that fired):")
    w("")
    for line in bullets(anti_terms, 25, "- `{k}` — {v}"):
        w(line)
    w("")
    w(f"On-target-looking titles killed by an antikeyword (**{len(anti_suspects)}**):")
    w("")
    for item, t, rule in anti_suspects[:25]:
        w(f"- `{item or '?'}` — {t[:110]}  \n  _rule:_ {rule[:110]}")
    if not anti_suspects:
        w("- _none_")
    w("")

    w("## 6. AI verdicts")
    w("")
    for line in bullets(ai_scores, 10, "- **{k}** — {v}"):
        w(line)
    w("")
    w("Recurring reasons for `No match`, i.e. what the searches keep dragging in.")
    w("Counts are sightings, not distinct listings:")
    w("")
    for line in bullets(ai_reasons, 20, "- {v}× — {k}"):
        w(line)
    w("")
    w(f"Listings that scored 4+ (**{len(wins)}** distinct titles; the verdict")
    w("histogram above counts every sighting, so it reads higher):")
    w("")
    for score, t in sorted(wins, reverse=True)[:25]:
        w(f"- **{score}** — {t[:130]}")
    if not wins:
        w("- _none_")
    w("")

    w("## 7. Coordinator DB")
    w("")
    db = ROOT / args.db
    if not db.exists():
        w(f"_No database at {db}._")
    else:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            total = con.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
            if not total:
                w("_`listings` is empty — the fleet has not reported to the coordinator, "
                  "so log analysis above is the only yield signal._")
            else:
                w("| item | listings | scored 4+ | first seen |")
                w("| --- | --- | --- | --- |")
                for row in con.execute(
                    "SELECT item_name, COUNT(*), SUM(ai_score >= 4), MIN(first_seen_at) "
                    "FROM listings GROUP BY 1 ORDER BY 2 DESC"
                ):
                    w(f"| `{row[0]}` | {row[1]} | {row[2] or 0} | {row[3]} |")
            con.close()
        except sqlite3.Error as exc:
            w(f"_DB read failed: {exc}_")
    w("")

    print("\n".join(out))


if __name__ == "__main__":
    main()
