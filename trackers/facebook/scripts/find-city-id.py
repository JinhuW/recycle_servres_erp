#!/usr/bin/env python
"""Resolve a city name to the Marketplace location id Facebook actually uses.

Most cities have no readable slug. `worcester`, `lowell`, `hartford` and almost
every other Greater Boston name silently fall back to the account's own city,
which is worse than an error: the worker keeps returning plausible listings
from the wrong part of the country.

Guessing spellings does not work, so this asks Facebook instead. It drives the
Marketplace location picker the way a person would — open it, type the city,
take the first suggestion, apply — and reads the numeric id out of the URL that
results. Whatever it prints is by construction a location Facebook recognises.

    python scripts/find-city-id.py --session <state.json> \
        "Worcester, MA" "Lowell, MA" "Hartford, CT"

Output is TOML-ready: the id, and the label Facebook gave it so the two can be
compared by eye before anything is pasted into master.toml.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import List, Tuple

from playwright.sync_api import (
    BrowserContext,
    Page,
    TimeoutError as PlaywrightTimeout,
    sync_playwright,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SESSION = ROOT / "configs" / "sessions" / "personal.json"

# /marketplace/109424912415667/search... -> the id. Slugs are letters only.
LOCATION_IN_URL = re.compile(r"/marketplace/([0-9]{6,}|[a-z][a-z0-9]{1,30})/")

# The typeahead labels options with the full state name ("Hartford, Connecticut
# City"), so the two-letter code in the input has to be expanded to match it.
STATE_NAMES = {
    "CT": "Connecticut",
    "DE": "Delaware",
    "MA": "Massachusetts",
    "MD": "Maryland",
    "ME": "Maine",
    "NC": "North Carolina",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NY": "New York",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "VA": "Virginia",
    "VT": "Vermont",
    "WV": "West Virginia",
}


def open_location_picker(page: Page) -> bool:
    """Click whatever currently opens the location dialog."""
    for selector in (
        'div[role="button"]:has-text(" mi")',
        'div[role="button"]:has-text(" km")',
        'span:has-text("Within")',
    ):
        try:
            page.locator(selector).first.click(timeout=8_000)
            return True
        except PlaywrightTimeout:
            continue
    return False


def _await_suggestions(page: Page, seconds: int = 12) -> int:
    """Poll for typeahead results instead of assuming a fixed debounce.

    A fixed sleep was the bug behind a run that resolved four cities and then
    reported "no suggestion" for every one after: the picker gets slower once a
    location has been applied, so a wait long enough cold is too short warm.
    """
    options = page.locator('ul[role="listbox"] li, div[role="option"]')
    for _ in range(seconds * 2):
        if options.count() > 0:
            return options.count()
        page.wait_for_timeout(500)
    return 0


def _resolve_once(page: Page, city: str) -> Tuple[str, str]:
    # Start from a SEARCH url, not bare /marketplace/. The location id only
    # appears in the path of a search ("/marketplace/<id>/search?..."); on the
    # bare page applying a location changes the results but leaves the URL with
    # nothing to read, so every lookup reports the right city and no id.
    page.goto(
        "https://www.facebook.com/marketplace/search?query=ssd",
        wait_until="domcontentloaded",
        timeout=45_000,
    )
    page.wait_for_timeout(3_000)

    # /marketplace/search redirects to the ACCOUNT'S OWN location id, so the
    # URL already contains an id before anything is picked. Remember it: the
    # answer is the id that replaces it, and reading the URL without this check
    # returns the account's home city for every lookup, identically and wrongly.
    before = LOCATION_IN_URL.search(page.url)
    original = before.group(1) if before else ""

    if not open_location_picker(page):
        return ("", "could not open the location picker")

    page.wait_for_timeout(1_500)
    box = page.locator('input[type="text"], input[role="combobox"]').last
    box.click(timeout=8_000)
    box.fill("")
    # Type the bare city name. "Hartford, CT" returns NOTHING from the
    # typeahead, while "Hartford" returns five options — the state has to be
    # used to choose between them, not to search with.
    name, _, state = city.partition(",")
    box.type(name.strip(), delay=90)

    if _await_suggestions(page) == 0:
        return ("", f"no suggestion for {name.strip()!r}")

    options = page.locator('ul[role="listbox"] li, div[role="option"]')
    labels = [
        (options.nth(i).inner_text() or "").replace("\n", " ").strip()
        for i in range(options.count())
    ]

    # Pick by state, never by position. Searching "Hartford" offers Hartford RI
    # first and Hartford CT third; taking the first match would have quietly
    # pointed the worker at the wrong state. Prefer an entry Facebook labels
    # "City" so a neighbourhood ("East Springfield") cannot win either.
    wanted = STATE_NAMES.get(state.strip().upper(), state.strip())
    ranked = sorted(
        range(len(labels)),
        key=lambda i: (
            wanted.lower() not in labels[i].lower(),
            "city" not in labels[i].lower(),
            i,
        ),
    )
    index = ranked[0]
    if wanted and wanted.lower() not in labels[index].lower():
        return ("", f"no {wanted} option among: {' / '.join(labels[:4])}")

    label = labels[index]
    options.nth(index).click()
    page.wait_for_timeout(2_000)

    # Clicking a suggestion sometimes navigates on its own; Apply is only
    # needed when it does not. Try it, but treat its absence as fine.
    for selector in ('div[role="button"]:has-text("Apply")', 'span:has-text("Apply")'):
        try:
            page.locator(selector).first.click(timeout=5_000)
            break
        except PlaywrightTimeout:
            continue

    # The id lands in the URL only after the search page reloads under the new
    # location, which is a navigation, not a repaint. Wait for it to differ
    # from the one the redirect put there.
    for _ in range(24):
        found = LOCATION_IN_URL.search(page.url)
        if found and found.group(1) != original:
            return (found.group(1), label)
        page.wait_for_timeout(500)
    return ("", f"location never changed from {original or 'unknown'} — {label}")


def resolve(context: BrowserContext, city: str, attempts: int = 2) -> Tuple[str, str]:
    """Return (location_id, label_facebook_showed) for a city name.

    A fresh tab per attempt: once a location has been applied the picker stays
    prefilled and the typeahead goes stale, which is what made an earlier run
    resolve four cities and then report "no suggestion" for every one after.
    """
    last: Tuple[str, str] = ("", "not attempted")
    for attempt in range(attempts):
        page = context.new_page()
        try:
            last = _resolve_once(page, city)
        except Exception as error:  # noqa: BLE001 — a retry may still succeed
            last = ("", f"{type(error).__name__}: {error}")
        finally:
            page.close()
        if last[0]:
            return last
        time.sleep(3 * (attempt + 1))
    return last


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cities", nargs="+", help='e.g. "Worcester, MA"')
    parser.add_argument("--session", type=Path, default=DEFAULT_SESSION)
    args = parser.parse_args()

    meta_path = args.session.with_suffix(args.session.suffix + ".meta.json")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    results: List[Tuple[str, str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            storage_state=str(args.session), user_agent=meta.get("user_agent")
        )
        for city in args.cities:
            try:
                location_id, label = resolve(context, city)
            except Exception as error:  # noqa: BLE001 — report, never abort the sweep
                location_id, label = "", f"{type(error).__name__}: {error}"
            status = "ok  " if location_id else "FAIL"
            print(f"{status} {city:22s} {location_id:18s} {label}")
            results.append((city, location_id, label))
            time.sleep(2)
        browser.close()

    ok = [r for r in results if r[1]]
    print(f"\n{len(ok)}/{len(results)} resolved.")
    if ok:
        print("\nPaste-ready:")
        print("    " + ", ".join(f'"{r[1]}"' for r in ok))
        print("    # " + " | ".join(f"{r[1]} = {r[0]}" for r in ok))
    return 0 if len(ok) == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
