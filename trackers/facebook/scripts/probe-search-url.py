#!/usr/bin/env python3
"""Run the monitor's own search URL in a browser and report what it brings back.

The complaint this answers is "I search that URL by hand and the results look
fine, so why is the log full of harmonicas?" — and the only way to answer it is
to use the monitor's own URL, its own page parser and its own gate, rather than
a second implementation that can drift from all three.

    python scripts/probe-search-url.py                      # every item, first phrase, first city
    python scripts/probe-search-url.py --item server_ram --city dc \
        --phrase "samsung micron sk hynix ram"
    python scripts/probe-search-url.py --out reports/search-probe-2026-08-20.md

Needs an authenticated session (configs/sessions/*.json) and the secrets that
master.toml reads; scripts/probe-search-url.sh loads both.
"""

from __future__ import annotations

import argparse
import datetime
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ai-marketplace-monitor" / "src"))

from playwright.sync_api import sync_playwright  # noqa: E402

from ai_marketplace_monitor.config import Config  # noqa: E402
from ai_marketplace_monitor.facebook import (  # noqa: E402
    MAX_RESULT_SCROLLS,
    FacebookMarketplace,
    FacebookSearchResultPage,
)

DEFAULT_CONFIG = ROOT / "configs" / "master.toml"
DEFAULT_SESSION = ROOT / "configs" / "sessions" / "personal.json"


def query_tokens(phrase: str) -> List[str]:
    return [t for t in re.split(r"\W+", phrase.lower()) if len(t) > 1]


def matched_the_query(title: str, tokens: List[str]) -> bool:
    """Did Facebook match the query at all, or is this padding?

    Past a certain depth Marketplace stops answering the query and fills the
    grid with whatever else is local — a TV, a watch, a rifle sight. None of
    those share a single word with the search.
    """
    low = title.lower()
    return any(re.search(rf"\b{re.escape(t)}", low) for t in tokens)


def probe(
    marketplace: FacebookMarketplace,
    page: Any,
    item_config: Any,
    city: str,
    radius: int | None,
    phrase: str,
) -> Dict[str, Any]:
    base = marketplace.base_search_options(item_config)
    options = marketplace.city_search_options(item_config, base, radius=radius)
    url = marketplace.build_search_url(city, phrase, options)

    page.goto(url, timeout=60_000)
    page.wait_for_timeout(6_000)
    marketplace.page = page
    listings = FacebookSearchResultPage(page, marketplace.translator, None).get_listings()

    tokens = query_tokens(phrase)
    rows = []
    for pos, listing in enumerate(listings, 1):
        rows.append(
            {
                "pos": pos,
                "title": listing.title,
                "url": listing.post_url.split("?")[0],
                # False => the monitor opens the listing's page to read its
                # description. That visit is the expensive part of a cycle.
                "fetched": marketplace.check_listing(
                    listing, item_config, description_available=False
                ),
                "on_query": matched_the_query(listing.title, tokens),
            }
        )
    return {"url": url, "item": item_config.name, "city": city, "phrase": phrase, "rows": rows}


def render(results: List[Dict[str, Any]]) -> str:
    today = datetime.date.today().isoformat()
    out = [f"# Search probe — {today}", ""]
    out += [
        "Each URL below is the one the monitor visits, built by its own",
        "`build_search_url`, and parsed by its own result-page parser. Paste one",
        "into a browser and you are looking at exactly what the worker saw.",
        "",
    ]
    for r in results:
        rows = r["rows"]
        n = len(rows)
        if not n:
            out += [f"## {r['item']} — `{r['phrase']}` from {r['city']}", "",
                    f"<{r['url']}>", "", "**No results.**", ""]
            continue
        fetched = [x for x in rows if x["fetched"]]
        padding = [x for x in rows if not x["on_query"]]
        first_pad = next((x["pos"] for x in rows if not x["on_query"]), None)
        deep = [x for x in fetched if x["pos"] > 40]
        out += [
            f"## {r['item']} — `{r['phrase']}` from {r['city']}",
            "",
            f"<{r['url']}>",
            "",
            f"- results returned: **{n}**",
            f"- rejected on the title, no page opened: **{n - len(fetched)}**",
            f"- detail pages the monitor opens: **{len(fetched)}**",
            f"- results matching no word of the query (Facebook padding): **{len(padding)}**"
            + (f", first at position {first_pad}" if first_pad else ""),
            f"- listings still worth opening past position 40: **{len(deep)}**"
            "  — the argument for reading the whole list rather than the first screen",
            "",
            "| pos | opened | on query | title |",
            "| ---: | :---: | :---: | --- |",
        ]
        for x in rows:
            title = x["title"].replace("|", "\\|")[:90]
            out.append(
                f"| {x['pos']} | {'yes' if x['fetched'] else 'no'} | "
                f"{'yes' if x['on_query'] else 'no'} | [{title}]({x['url']}) |"
            )
        out.append("")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--session", default=str(DEFAULT_SESSION))
    ap.add_argument("--item", action="append", help="repeatable; default is every item")
    ap.add_argument("--city", help="default is the item's first search city")
    ap.add_argument("--phrase", action="append", help="repeatable; default is the first phrase")
    ap.add_argument("--all-phrases", action="store_true")
    ap.add_argument("--out", help="write a markdown report here instead of stdout")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    config = Config([args.config])
    mp_config = config.marketplace["facebook"]
    items = args.item or list(config.item)

    marketplace = FacebookMarketplace(name="facebook", browser=MagicMock(), logger=None)
    marketplace.config = mp_config

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(
            storage_state=args.session, viewport={"width": 1400, "height": 1000}
        )
        page = ctx.new_page()
        for name in items:
            item_config = config.item[name]
            cities = item_config.search_city or mp_config.search_city or []
            radii = item_config.radius or mp_config.radius or []
            if args.city:
                city = args.city
                radius = radii[cities.index(city)] if city in cities and radii else None
            else:
                city = cities[0]
                radius = radii[0] if radii else None
            phrases = args.phrase or (
                item_config.search_phrases if args.all_phrases else item_config.search_phrases[:1]
            )
            for phrase in phrases:
                print(f"probing {name}: {phrase!r} from {city} (radius={radius})", file=sys.stderr)
                results.append(probe(marketplace, page, item_config, city, radius, phrase))
        browser.close()

    report = render(results)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(report)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
