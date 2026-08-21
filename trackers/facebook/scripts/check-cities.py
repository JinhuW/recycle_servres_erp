#!/usr/bin/env python
"""Verify every search_city in master.toml is the location Facebook thinks it is.

A wrong Marketplace location slug does not error. Facebook silently falls back
to the account's own location, so a worker keeps running and keeps returning
plausible listings — from the wrong part of the country. `billings`, for
example, searches wherever the logged-in account lives; Billings, MT is only
reachable by its numeric location id.

This opens each city in a real browser using a saved session and prints the
location label Facebook shows, so the two can be compared by eye:

    python scripts/check-cities.py                      # every region
    python scripts/check-cities.py rs_west rs_mountain  # named regions only
    python scripts/check-cities.py --city sac --city la # ad-hoc slugs

Exit status is non-zero if any location failed to resolve, so it can gate a
deploy. Run it against an operator session (configs/sessions/personal.json by
default), not a worker's — it is one page load per city, but it is still
Marketplace traffic on whatever account it uses.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import List, Tuple

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "configs" / "master.toml"
DEFAULT_SESSION = ROOT / "configs" / "sessions" / "personal.json"

# The location chip reads e.g. "Denver, Colorado · Within 500 mi".
LOCATION_CHIP = re.compile(r"\d+\s*(mi|km)\b")


def cities_from_master(regions: List[str]) -> List[Tuple[str, str, str]]:
    """Return (region, search_city, city_name) for the requested regions."""
    with open(MASTER, "rb") as handle:
        master = tomllib.load(handle)

    defined = master.get("region", {})
    unknown = [region for region in regions if region not in defined]
    if unknown:
        raise SystemExit(
            f"Unknown region(s): {', '.join(unknown)}. "
            f"master.toml defines: {', '.join(sorted(defined))}"
        )

    out: List[Tuple[str, str, str]] = []
    for name in regions or sorted(defined):
        region = defined[name]
        city_names = region.get("city_name") or []
        for index, city in enumerate(region.get("search_city", [])):
            expected = city_names[index] if index < len(city_names) else ""
            out.append((name, city, expected))
    return out


def check(targets: List[Tuple[str, str, str]], session: Path, query: str) -> int:
    meta_path = session.with_suffix(session.suffix + ".meta.json")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            storage_state=str(session),
            user_agent=meta.get("user_agent"),
            proxy={"server": meta["proxy"]} if meta.get("proxy") else None,
        )
        page = context.new_page()
        for region, city, expected in targets:
            url = f"https://www.facebook.com/marketplace/{city}/search?query={query}"
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                page.wait_for_timeout(3_500)
                labels = page.eval_on_selector_all(
                    "span,div[role=button]",
                    "els => els.map(e => e.innerText).filter("
                    "t => t && t.length < 40 && /\\d+\\s*(mi|km)\\b/.test(t))",
                )
            except Exception as error:  # noqa: BLE001 — report, never abort the sweep
                print(f"FAIL {region:17s} {city:18s} {type(error).__name__}: {error}")
                failures += 1
                continue

            # An unusable location redirects to bare /marketplace/ (or, worse,
            # quietly answers from the account's own city).
            resolved = labels[0].replace("\n", " ").strip() if labels else ""
            landed_elsewhere = "/marketplace/" + str(city) not in page.url
            if not resolved or landed_elsewhere:
                print(f"FAIL {region:17s} {city:18s} did not resolve — {page.url}")
                failures += 1
            else:
                print(f"ok   {region:17s} {city:18s} {resolved}   (want: {expected})")
            time.sleep(1.5)
        browser.close()
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("regions", nargs="*", help="regions to check (default: all)")
    parser.add_argument(
        "--city",
        action="append",
        default=[],
        help="check this slug or numeric id instead of reading master.toml",
    )
    parser.add_argument(
        "--session",
        type=Path,
        default=DEFAULT_SESSION,
        help=f"session file to browse with (default: {DEFAULT_SESSION})",
    )
    parser.add_argument(
        "--query",
        default="ssd",
        help="search term used for the probe (default: ssd)",
    )
    args = parser.parse_args()

    if not args.session.exists():
        raise SystemExit(
            f"No session at {args.session}. Create one with:\n"
            f"  rs-session capture --storage-state {args.session}"
        )

    targets = (
        [("--city", city, "") for city in args.city]
        if args.city
        else cities_from_master(args.regions)
    )
    failures = check(targets, args.session, args.query)
    print(f"\n{len(targets) - failures}/{len(targets)} locations resolved.")
    if failures:
        print(
            "A location that does not resolve is searched from the account's own "
            "city instead. Fix it in master.toml — take the slug from the URL of a "
            "Marketplace search in that city, or use its numeric location id."
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
