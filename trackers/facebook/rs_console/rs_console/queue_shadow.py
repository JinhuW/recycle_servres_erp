"""The city queue's shadow report, from the console's side.

The coordinator replays the fleet through the queue (`rs_coordinator.city_queue`)
but cannot read the worker configs, so the console sends it the roster: the
catalog with each city's region, and each worker's home cities, proxy,
start_at times and phrase count, all from the same document `/v1/fleet`
serves. Nothing here changes what a worker searches.

    python -m rs_console.queue_shadow                 # last 3 days, stored settings
    python -m rs_console.queue_shadow --days 7 --budget 240 --window 10
    python -m rs_console.queue_shadow --per-day 3,2,1 --json
"""

import argparse
import asyncio
import json
import sys
from typing import Any, Dict, List, Optional


def roster(doc: Dict[str, Any]) -> Dict[str, Any]:
    """The `/v1/fleet` document as the coordinator's roster.

    Partners are the workers on one proxy variable: two accounts behind one
    exit IP, which the queue keeps apart.
    """
    catalog: List[Dict[str, Any]] = []
    seen = set()
    for region in doc.get("regions") or []:
        for city in region.get("cities") or []:
            if city["slug"] not in seen:
                seen.add(city["slug"])
                catalog.append(
                    {"slug": city["slug"], "name": city.get("name"), "region": region["key"]}
                )
    workers: Dict[str, Dict[str, Any]] = {}
    for worker in doc.get("workers") or []:
        cities = worker.get("cities") or []
        for city in cities:
            # A city set on the worker page that no region holds.
            if city["slug"] not in seen:
                seen.add(city["slug"])
                catalog.append({"slug": city["slug"], "name": city.get("name"), "region": None})
        workers[worker["worker_id"]] = {
            "home": [c["slug"] for c in cities],
            "partner_key": worker.get("proxy_env") or None,
            "start_at": worker.get("start_at") or [],
            "phrases": (worker.get("plan") or {}).get("phrases") or 2,
        }
    return {"catalog": catalog, "workers": workers}


def _row(cells: List[Any], widths: List[int]) -> str:
    return "  ".join(
        str(c).ljust(w) if i == 0 else str(c).rjust(w)
        for i, (c, w) in enumerate(zip(cells, widths))
    )


def render(report: Dict[str, Any], worst: int = 15) -> str:
    """The report as text tables for a terminal."""
    window = report["window"]
    lines = [f"Shadow city queue: {window['start']} to {window['end']} ({window['days']:g} days)"]
    if report.get("partial"):
        since = report.get("log_since") or "nothing yet"
        lines.append(f"! the search log starts {since}; the actual side reads idle before that")

    labels = [
        ("searches_per_day", "searches a day"),
        ("browser_minutes_per_day", "browser minutes a day"),
        ("accounts_used", "accounts used"),
        ("max_account_minutes_per_day", "busiest account, min a day"),
        ("median_account_minutes_per_day", "median account, min a day"),
        ("redundant_searches", "redundant searches"),
        ("cities_gap_over_26h", "cities with a gap over 26 h"),
        ("overdue_hours", "overdue city-hours"),
    ]
    actual, shadow = report["fleet"]["actual"], report["fleet"]["shadow"]
    widths = [30, 8, 8]
    lines += ["", _row(["", "actual", "shadow"], widths)]
    lines += [_row([label, actual[key], shadow[key]], widths) for key, label in labels]

    lines += ["", "Quarantined: every search at 0 cards on cities others get cards from"]
    if not report["quarantined"]:
        lines.append("  none")
    for q in report["quarantined"]:
        others = ", ".join(f"{c} ({n})" for c, n in q["others_cards"].items())
        lines.append(f"  {q['worker_id']}: {q['searches']} searches; others get cards on {others}")

    widths = [12, 5, 8, 8, 8, 8, 14, 22]
    lines += [
        "",
        _row(
            [
                "worker",
                "home",
                "act srch",
                "act min",
                "shd srch",
                "shd min",
                "home/fam/oth",
                "idle min",
            ],
            widths,
        ),
    ]
    for w in report["workers"]:
        by = w["shadow"]["by"]
        idle = ", ".join(f"{k} {v}" for k, v in w["shadow"]["idle_minutes"].items() if v)
        lines.append(
            _row(
                [
                    w["worker_id"] + (" (Q)" if w["quarantined"] else ""),
                    w["home"],
                    w["actual"]["searches"],
                    w["actual"]["minutes"],
                    w["shadow"]["searches"],
                    w["shadow"]["minutes"],
                    f"{by.get('home', 0)}/{by.get('familiar', 0)}/{by.get('other', 0)}",
                    idle or "-",
                ],
                widths,
            )
        )

    widths = [24, 6, 9, 9, 30]
    cities = sorted(report["cities"], key=lambda c: -c["shadow"]["max_gap_h"])[:worst]
    lines += [
        "",
        f"Longest shadow gaps (top {len(cities)})",
        _row(["city", "a day", "act gap", "shd gap", "searched by (shadow)"], widths),
    ]
    for c in cities:
        lines.append(
            _row(
                [
                    (c["name"] or c["slug"])[:24],
                    c["per_day"],
                    f"{c['actual']['max_gap_h']}h",
                    f"{c['shadow']['max_gap_h']}h",
                    ", ".join(c["shadow"]["workers"]) or "-",
                ],
                widths,
            )
        )
    return "\n".join(lines)


def _settings(args: argparse.Namespace) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if args.budget is not None:
        out["budget_minutes"] = args.budget
    if args.window is not None:
        out["window_hours"] = args.window
    if args.per_day:
        out["tiers"] = {"per_day": [int(n) for n in args.per_day.split(",")]}
    return out


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m rs_console.queue_shadow", description=__doc__.split("\n\n")[0]
    )
    parser.add_argument("--days", type=int, default=3, help="window to replay, 1 to 14 days")
    parser.add_argument("--budget", type=int, help="browser minutes per account per day")
    parser.add_argument(
        "--window", type=float, help="hours a worker keeps asking after each start_at"
    )
    parser.add_argument(
        "--per-day", help="searches a day for the busiest, middle and other cities, e.g. 3,2,1"
    )
    parser.add_argument("--json", action="store_true", help="print the raw report")
    args = parser.parse_args(argv)

    # Imported here: the app imports this module for its route.
    from . import app

    res = asyncio.run(app.queue_shadow({"days": args.days, "settings": _settings(args)}))
    body = json.loads(res.body)
    if res.status_code != 200:
        print(
            f"coordinator answered {res.status_code}: {body.get('detail', body)}", file=sys.stderr
        )
        return 1
    print(json.dumps(body, indent=2) if args.json else render(body))
    return 0


if __name__ == "__main__":
    sys.exit(main())
