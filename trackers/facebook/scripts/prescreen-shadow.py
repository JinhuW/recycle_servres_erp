#!/usr/bin/env python3
"""Replay recent listing verdicts through a decision model, as a pre-screen would.

The listing LLM (`openai/gpt-5.6-luna`, see `configs/master.toml`) sees every
listing that passes the keyword gates and scores it 1-5; almost all of them
score 1. A decision model (OpenRouter's Decisions API: text in, probabilities
out, no prose) could reject the obvious misses before the LLM is paid for them.
Whether it can do that WITHOUT dropping the listings we alert on is what this
script measures, offline, against the `ai_eval` events the fleet already ships
to OpenSearch. Nothing here touches the fleet.

The sample is stratified: every billed verdict that scored 3+ (the listings a
pre-screen must not lose) plus a random sample of the 1-2s (the bulk it would
save). Shares of calls saved are weighted back to the full population.

    python3 scripts/prescreen-shadow.py                    # 14 days, Luna Decisions
    python3 scripts/prescreen-shadow.py --model typesafe/jev-1.14
    python3 scripts/prescreen-shadow.py --days 7 --sample 800
    python3 scripts/prescreen-shadow.py --save run.json     # keep the raw answers
    python3 scripts/prescreen-shadow.py --replay run.json   # re-analyse, no calls
    python3 scripts/prescreen-shadow.py --live --days 7     # the fleet's own verdicts

`--live` asks no model: the workers already run the pre-screen in shadow
(`RS_PRESCREEN_MODEL`, see the worker compose file) and log a `prescreen`
event per billed listing, so the same gate table comes straight from the
index. That is the report that decides whether `RS_PRESCREEN_ENFORCE` goes on.

Needs Python 3.11+ (tomllib), `OPENROUTER_API_KEY` (as in configs/secrets.env;
not for `--live`) and the OpenSearch the workers ship to (`RS_OPENSEARCH_URL`,
default the VM's local port; from a laptop, `ssh -L 19200:127.0.0.1:9200
jinhu@10.10.10.73`).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import statistics
import sys
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
MASTER_TOML = ROOT / "configs" / "master.toml"
OPENSEARCH = os.environ.get("RS_OPENSEARCH_URL", "http://127.0.0.1:9200")
INDEX = "fb-tracker-*"
DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
DEFAULT_MODEL = "openai/gpt-6-luna-decisions"

# What the LLM's 1-5 collapses to for a pre-screen. The gate would only ever
# act on `reject`; `maybe` and `buy` both go through to the LLM as today.
CRITERIA = {
    "reject": (
        "A reject rule applies, or the listing is probably not a qualifying bulk lot: "
        "not DDR4/DDR5 RAM or an enterprise SSD, a single unit, fewer than 5 units, "
        "no quantity to work out, a gaming-brand kit, a wanted/trade/sold post, or an "
        "online reseller cross-posting stock. (The LLM would rate this 1 or 2.)"
    ),
    "maybe": (
        "A qualifying component type but borderline: quantity around 5 or unclear "
        "condition, or a memory lot whose generation the text does not settle. "
        "(The LLM would rate this 3.)"
    ),
    "buy": (
        "A clear for-sale bulk lot of 5+ DDR4/DDR5 memory modules or 5+ enterprise "
        "SSDs from a local seller, with usable details. (The LLM would rate this 4 or 5.)"
    ),
}
# Below these the LLM's own verdict is the label a pre-screen must preserve.
ALERT_SCORE = 4
MAYBE_SCORE = 3
THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99)
# The rule the ticket set: keep >= 99% of the 4+ listings, drop >= 50% of calls.
RECALL_FLOOR = 0.99
SAVINGS_FLOOR = 0.50


# -- OpenSearch -------------------------------------------------------------


def search(body: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        f"{OPENSEARCH}/{INDEX}/_search",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def billed_filter(days: int) -> List[Dict[str, Any]]:
    return [
        {"term": {"kind.keyword": "ai_eval"}},
        {"term": {"cached": False}},
        {"range": {"@timestamp": {"gte": f"now-{days}d"}}},
    ]


FIELDS = [
    "listing_id", "title", "price", "description", "item", "score", "url",
    "search_city", "unit_count", "quantity", "@timestamp",
]


def population(days: int) -> Dict[int, int]:
    """Billed verdicts per score over the window: the weights for the sample."""
    data = search({
        "size": 0,
        "query": {"bool": {"filter": billed_filter(days)}},
        "aggs": {"score": {"terms": {"field": "score", "size": 10}}},
    })
    return {int(b["key"]): b["doc_count"] for b in data["aggregations"]["score"]["buckets"]}


def pull(days: int, sample: int, seed: int) -> List[Dict[str, Any]]:
    """Every billed 3+ verdict, plus `sample` random 1-2s, one row per listing."""
    high = search({
        "size": 10000,
        "_source": FIELDS,
        "query": {"bool": {"filter": billed_filter(days) + [{"range": {"score": {"gte": MAYBE_SCORE}}}]}},
        "sort": [{"@timestamp": "desc"}],
    })
    low = search({
        "size": sample,
        "_source": FIELDS,
        "query": {
            "function_score": {
                "query": {"bool": {"filter": billed_filter(days) + [{"range": {"score": {"lt": MAYBE_SCORE}}}]}},
                "random_score": {"seed": seed, "field": "_seq_no"},
                "boost_mode": "replace",
            }
        },
    })
    rows: Dict[str, Dict[str, Any]] = {}
    for hit in high["hits"]["hits"] + low["hits"]["hits"]:
        src = hit["_source"]
        key = str(src.get("listing_id") or hit["_id"])
        rows.setdefault(key, src)
    return list(rows.values())


LIVE_FIELDS = [
    "listing_id", "title", "price", "url", "item", "prescreen_p_reject", "prescreen_choice",
    "prescreen_cost", "prescreen_ms", "prescreen_model",
]


def pull_live(days: int) -> Tuple[List[Dict[str, Any]], Dict[int, int], int]:
    """The fleet's own fresh `prescreen` events, each joined to the billed LLM
    verdict for the same listing. Returns the joined rows, their score
    population (no sampling, so every row weighs 1) and how many events found
    no verdict (skipped under enforcement, or the LLM failed)."""
    events = search({
        "size": 10000,
        "_source": LIVE_FIELDS,
        "query": {"bool": {"filter": [
            {"term": {"kind.keyword": "prescreen"}},
            {"term": {"prescreen_cached": False}},
            {"range": {"@timestamp": {"gte": f"now-{days}d"}}},
        ]}},
        "sort": [{"@timestamp": "desc"}],
    })
    rows: Dict[str, Dict[str, Any]] = {}
    for hit in events["hits"]["hits"]:
        src = hit["_source"]
        key = str(src.get("listing_id") or hit["_id"])
        rows.setdefault(key, {
            "listing_id": key,
            "title": src.get("title"),
            "price": src.get("price"),
            "url": src.get("url"),
            "item": src.get("item"),
            "p_reject": float(src.get("prescreen_p_reject") or 0.0),
            "choice": src.get("prescreen_choice"),
            "cost": float(src.get("prescreen_cost") or 0.0),
            "latency_ms": int(src.get("prescreen_ms") or 0),
            "model": src.get("prescreen_model"),
        })
    ids = list(rows)
    for start in range(0, len(ids), 1000):
        chunk = ids[start:start + 1000]
        verdicts = search({
            "size": 10000,
            "_source": ["listing_id", "score", "unit_count"],
            "query": {"bool": {"filter": billed_filter(days) + [{"terms": {"listing_id.keyword": chunk}}]}},
        })
        for hit in verdicts["hits"]["hits"]:
            src = hit["_source"]
            row = rows.get(str(src.get("listing_id")))
            if row is not None and row.get("score") is None:
                row["score"] = src.get("score")
                row["unit_count"] = src.get("unit_count")
    judged = [r for r in rows.values() if r.get("score") is not None]
    pop: Dict[int, int] = {}
    for r in judged:
        pop[int(r["score"])] = pop.get(int(r["score"]), 0) + 1
    return judged, pop, len(rows) - len(judged)


# -- the question -----------------------------------------------------------


def production_prompt() -> str:
    """The purchasing rules the LLM is given, so the pre-screen judges by them."""
    config = tomllib.loads(MASTER_TOML.read_text())

    def walk(node: Any) -> Optional[str]:
        if isinstance(node, dict):
            if isinstance(node.get("prompt"), str) and "rating_prompt" in node:
                return node["prompt"]
            for value in node.values():
                found = walk(value)
                if found:
                    return found
        return None

    prompt = walk(config)
    if not prompt:
        sys.exit(f"no table with `prompt` and `rating_prompt` in {MASTER_TOML}")
    return prompt


def question(prompt: str) -> Dict[str, Any]:
    return {
        "verdict": {
            "type": "choice",
            "instructions": prompt
            + "\n\nJudge the listing in `state` by these rules and pick the one label that fits.",
            "criteria": CRITERIA,
        }
    }


def decide(row: Dict[str, Any], model: str, key: str, questions: Dict[str, Any]) -> Dict[str, Any]:
    body = {
        "model": model,
        "state": {
            "item": row.get("item"),
            "title": row.get("title"),
            "price": row.get("price"),
            "description": row.get("description") or "",
        },
        "questions": questions,
    }
    request = urllib.request.Request(
        DECISIONS_URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    started = time.monotonic()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 2:
                return {**row, "error": str(e)}
            time.sleep(2 * (attempt + 1))
    answer = (payload.get("answers") or {}).get("verdict") or {}
    probabilities = answer.get("probabilities") or {}
    return {
        **row,
        "choice": answer.get("choice"),
        "p_reject": float(probabilities.get("reject") or 0.0),
        "p_maybe": float(probabilities.get("maybe") or 0.0),
        "p_buy": float(probabilities.get("buy") or 0.0),
        "cost": float((payload.get("usage") or {}).get("cost") or 0.0),
        "latency_ms": round((time.monotonic() - started) * 1000),
        "model": payload.get("model") or model,
    }


def run(rows: List[Dict[str, Any]], model: str, key: str, concurrency: int) -> List[Dict[str, Any]]:
    questions = question(production_prompt())
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        return list(pool.map(lambda row: decide(row, model, key, questions), rows))


# -- the report ---------------------------------------------------------------


def weights(pop: Dict[int, int], results: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    """Sample row -> how many billed verdicts it stands for."""
    low_total = sum(n for s, n in pop.items() if s < MAYBE_SCORE)
    low_sampled = sum(1 for r in results if int(r.get("score") or 1) < MAYBE_SCORE)
    low_weight = (low_total / low_sampled) if low_sampled else 0.0
    return {"low": low_weight, "high": 1.0}


def report(results: List[Dict[str, Any]], pop: Dict[int, int], days: int, model: str,
           live: Optional[int] = None) -> int:
    answered = [r for r in results if "p_reject" in r]
    errors = [r for r in results if "error" in r]
    w = weights(pop, answered)
    total_billed = sum(pop.values())
    per_day = total_billed / max(days, 1)

    def weight(r: Dict[str, Any]) -> float:
        return w["low"] if int(r.get("score") or 1) < MAYBE_SCORE else w["high"]

    alerts = [r for r in answered if int(r.get("score") or 1) >= ALERT_SCORE]
    maybes = [r for r in answered if int(r.get("score") or 1) >= MAYBE_SCORE]
    costs = [r["cost"] for r in answered]
    latencies = [r["latency_ms"] for r in answered]

    bands = (f"{len(alerts)} scored 4+, {len(maybes) - len(alerts)} scored 3, "
             f"{len(answered) - len(maybes)} scored 1-2")
    if live is None:
        print(f"# Pre-screen shadow run: `{model}`\n")
        print(f"Window: last {days} days. Billed LLM verdicts: {total_billed} ({per_day:.0f}/day). "
              f"Sampled: {len(answered)} listings ({bands}, each standing for {w['low']:.1f}). "
              f"Decision calls failed: {len(errors)}.\n")
    else:
        print(f"# Pre-screen live shadow: `{model}`\n")
        print(f"Window: last {days} days of the fleet's own `prescreen` events, each joined to the "
              f"billed LLM verdict for the same listing: {len(answered)} listings ({bands}; "
              f"{per_day:.0f}/day). {live} pre-screened listings had no LLM verdict in the window "
              f"(skipped under enforcement, or the LLM failed).\n")
    if costs:
        print(f"Per call: median {statistics.median(latencies):.0f} ms, "
              f"p95 {sorted(latencies)[int(len(latencies) * 0.95) - 1]:.0f} ms, "
              f"${statistics.mean(costs):.6f}; at {per_day:.0f} calls/day that is "
              f"${statistics.mean(costs) * per_day:.3f}/day for the pre-screen.\n")

    print("## Label agreement (decision choice vs LLM score)\n")
    print("| LLM score | n | reject | maybe | buy |")
    print("|---|---|---|---|---|")
    for score in sorted({int(r.get("score") or 1) for r in answered}):
        band = [r for r in answered if int(r.get("score") or 1) == score]
        counts = {c: sum(1 for r in band if r.get("choice") == c) for c in CRITERIA}
        print(f"| {score} | {len(band)} | {counts['reject']} | {counts['maybe']} | {counts['buy']} |")

    print("\n## Gate on P(reject) >= threshold\n")
    print("| threshold | billed calls saved | 4+ kept | 3+ kept | 4+ dropped |")
    print("|---|---|---|---|---|")
    best: Optional[float] = None
    for t in THRESHOLDS:
        saved = sum(weight(r) for r in answered if r["p_reject"] >= t)
        saved_share = saved / total_billed if total_billed else 0.0
        kept4 = sum(1 for r in alerts if r["p_reject"] < t) / len(alerts) if alerts else 1.0
        kept3 = sum(1 for r in maybes if r["p_reject"] < t) / len(maybes) if maybes else 1.0
        dropped4 = sum(1 for r in alerts if r["p_reject"] >= t)
        print(f"| {t:.2f} | {saved_share:.1%} | {kept4:.1%} | {kept3:.1%} | {dropped4} |")
        if kept4 >= RECALL_FLOOR and saved_share >= SAVINGS_FLOOR and (best is None or t < best):
            best = t

    print()
    if best is None:
        print(f"**No-go**: no threshold keeps >= {RECALL_FLOOR:.0%} of the 4+ listings while saving "
              f">= {SAVINGS_FLOOR:.0%} of billed calls.")
    else:
        print(f"**Go candidate**: P(reject) >= {best:.2f} meets the rule (>= {RECALL_FLOOR:.0%} of 4+ kept, "
              f">= {SAVINGS_FLOOR:.0%} of calls saved). Lowest qualifying threshold shown.")

    show = best if best is not None else THRESHOLDS[-1]
    dropped = sorted((r for r in alerts if r["p_reject"] >= show), key=lambda r: -r["p_reject"])
    print(f"\n## 4+ listings a gate at {show:.2f} would have dropped ({len(dropped)})\n")
    if dropped:
        print("| LLM | P(reject) | choice | title | price | url |")
        print("|---|---|---|---|---|---|")
        for r in dropped:
            title = (r.get("title") or "").replace("|", "/")[:70]
            print(f"| {r.get('score')} | {r['p_reject']:.2f} | {r.get('choice')} | {title} | "
                  f"{r.get('price') or ''} | {r.get('url') or ''} |")
    else:
        print("None.")

    near = sorted((r for r in alerts if 0.2 <= r["p_reject"] < show), key=lambda r: -r["p_reject"])[:10]
    if near:
        print(f"\n## 4+ listings the model was least sure about (P(reject) 0.20-{show:.2f})\n")
        print("| LLM | P(reject) | title | price |")
        print("|---|---|---|---|")
        for r in near:
            print(f"| {r.get('score')} | {r['p_reject']:.2f} | {(r.get('title') or '')[:70]} | {r.get('price') or ''} |")
    return 0 if best is not None else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--sample", type=int, default=1500, help="random 1-2 verdicts to include")
    parser.add_argument("--seed", type=int, default=20261019)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--save", type=Path, help="write the raw answers (JSON) here")
    parser.add_argument("--replay", type=Path, help="re-analyse a saved run instead of calling the model")
    parser.add_argument("--live", action="store_true",
                        help="read the fleet's own prescreen events instead of asking a model")
    args = parser.parse_args()

    if args.live:
        rows, pop, unjoined = pull_live(args.days)
        seen = [r.get("model") for r in rows if r.get("model")]
        model = max(set(seen), key=seen.count) if seen else "(none)"
        print(f"Joined {len(rows)} live pre-screen verdicts to LLM verdicts "
              f"({unjoined} without one)...", file=sys.stderr)
        return report(rows, pop, args.days, str(model), live=unjoined)

    if args.replay:
        saved = json.loads(args.replay.read_text())
        return report(saved["results"], {int(k): v for k, v in saved["population"].items()},
                      saved["days"], saved["model"])

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY is not set")
    pop = population(args.days)
    rows = pull(args.days, args.sample, args.seed)
    print(f"Pulled {len(rows)} listings ({sum(pop.values())} billed verdicts in the window); "
          f"asking {args.model}...", file=sys.stderr)
    results = run(rows, args.model, key, args.concurrency)
    if args.save:
        args.save.write_text(json.dumps(
            {"days": args.days, "model": args.model, "population": pop, "results": results}, indent=1
        ))
    return report(results, pop, args.days, args.model)


if __name__ == "__main__":
    sys.exit(main())
