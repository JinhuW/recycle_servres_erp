"""Command line entry point: `rs-poster`."""

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore

from .groups import GroupSharer
from .photo_library import PhotoLibrary, PhotoLibraryError
from .poster import AdTemplate, Poster, PostingError
from .session import PosterSession, SessionLockedError, account_lock
from .state import PacingRules, PosterState

ADS_DIR = Path(__file__).resolve().parents[1] / "ads"
logger = logging.getLogger("rs_poster")


def load_ads(path: Path) -> tuple[Dict[str, AdTemplate], PacingRules]:
    with open(path, "rb") as handle:
        config = tomllib.load(handle)
    ads = {
        name: AdTemplate.from_config(name, spec) for name, spec in config.get("ad", {}).items()
    }
    return ads, PacingRules.from_config(config.get("pacing", {}))


def build_context(args: argparse.Namespace) -> tuple[Dict[str, AdTemplate], PosterState, PhotoLibrary]:
    ads_dir = Path(args.ads_dir)
    ads, pacing = load_ads(ads_dir / "ads.toml")
    state = PosterState(ads_dir / "state.json", pacing=pacing)
    library = PhotoLibrary(ads_dir)
    return ads, state, library


def selected_targets(
    ads: Dict[str, AdTemplate], ad_name: str | None, city: str | None
) -> List[tuple[AdTemplate, str]]:
    if ad_name and ad_name not in ads:
        raise PostingError(f"Unknown ad '{ad_name}'. Known ads: {', '.join(sorted(ads))}")

    chosen = [ads[ad_name]] if ad_name else list(ads.values())
    targets = []
    for ad in chosen:
        for ad_city in ad.cities:
            if city and ad_city != city:
                continue
            targets.append((ad, ad_city))
    if not targets:
        raise PostingError("No ad/city combination matched the given filters.")
    return targets


def make_session(args: argparse.Namespace) -> PosterSession:
    return PosterSession(
        storage_state_path=args.storage_state,
        headless=args.headless,
        login_wait_time=args.login_wait_time,
    )


def cmd_validate(args: argparse.Namespace) -> int:
    ads, state, library = build_context(args)
    print(f"Ads defined: {', '.join(sorted(ads)) or 'none'}")
    print(f"Photo sets:  {', '.join(library.set_names) or 'none'}")

    problems = library.validate_all()
    referenced = {ad.photo_set for ad in ads.values()}
    missing_sets = referenced - set(library.set_names)

    for name, error in problems.items():
        print(f"  photo set '{name}': {error}", file=sys.stderr)
    for name in sorted(missing_sets):
        print(f"  ad references unknown photo set '{name}'", file=sys.stderr)

    print(f"\nActive ads on record: {len(state.active_ads())}/{state.pacing.max_active_ads}")
    print(f"Group shares today:   {state.shares_today()}/{state.pacing.max_group_shares_per_day}")

    broken = {name for name in problems if name in referenced} | missing_sets
    if broken:
        print(f"\n{len(broken)} problem(s) would block posting.", file=sys.stderr)
        return 1
    print("\nConfiguration is valid.")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    ads, state, library = build_context(args)
    targets = selected_targets(ads, args.ad, args.city)

    with account_lock(args.lock_file, timeout=args.lock_timeout):
        with make_session(args) as session:
            poster = Poster(session, library, state, dry_run=args.dry_run)
            sharer = GroupSharer(poster)
            for ad, city in targets:
                record = poster.create_listing(ad, city)
                if record and ad.groups:
                    sharer.share_all(record.title, ad.groups, ad.description)
    return 0


def cmd_renew(args: argparse.Namespace) -> int:
    ads, state, library = build_context(args)

    if args.all:
        targets = selected_targets(ads, args.ad, args.city)
    else:
        due = state.due_for_renewal()
        if not due:
            print("Nothing is due for renewal.")
            return 0
        targets = []
        for record in due:
            if record.ad_name in ads:
                targets.append((ads[record.ad_name], record.city))
            else:
                logger.warning("Record '%s' has no matching ad template.", record.key)

    if not targets:
        print("Nothing to renew.")
        return 0

    with account_lock(args.lock_file, timeout=args.lock_timeout):
        with make_session(args) as session:
            poster = Poster(session, library, state, dry_run=args.dry_run)
            for ad, city in targets:
                poster.renew(ad, city)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _, state, _ = build_context(args)
    records = list(state.ads.values())
    if not records:
        print("No ads have been posted from this node yet.")
        return 0

    print(f"{'AD':<22} {'CITY':<22} {'ACTIVE':<7} {'RENEWED':<22} DUE")
    for record in sorted(records, key=lambda r: r.key):
        due = "yes" if record.active and record.due_for_renewal() else "no"
        print(
            f"{record.ad_name:<22} {record.city:<22} "
            f"{'yes' if record.active else 'no':<7} {record.last_renewed_at:<22} {due}"
        )
    print(f"\nActive: {len(state.active_ads())}/{state.pacing.max_active_ads}")
    print(f"Shares today: {state.shares_today()}/{state.pacing.max_group_shares_per_day}")
    wait = state.seconds_until_next_action()
    print(f"Next action allowed in: {int(wait)}s" if wait else "Ready to act now.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rs-poster", description="Post buy ads to Marketplace")
    parser.add_argument("--ads-dir", default=str(ADS_DIR))
    parser.add_argument("--storage-state", default=os.environ.get("FB_STATE", "/data/fb_state.json"))
    parser.add_argument("--lock-file", default=os.environ.get("FB_LOCK", "/data/fb_account.lock"))
    parser.add_argument("--lock-timeout", type=int, default=0, help="Seconds to wait for the lock")
    parser.add_argument("--headless", action="store_true", help="Not recommended; easier to detect")
    parser.add_argument("--login-wait-time", type=int, default=120)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate", help="Check ads, photos, and pacing without a browser")
    validate.set_defaults(func=cmd_validate)

    post = sub.add_parser("post", help="Publish buy ads")
    post.add_argument("--ad", help="Only this ad (default: all)")
    post.add_argument("--city", help="Only this city (default: all cities of each ad)")
    post.add_argument("--dry-run", action="store_true", help="Fill the form and screenshot only")
    post.set_defaults(func=cmd_post)

    renew = sub.add_parser("renew", help="Delete and repost ads that are due")
    renew.add_argument("--ad")
    renew.add_argument("--city")
    renew.add_argument("--all", action="store_true", help="Renew regardless of schedule")
    renew.add_argument("--dry-run", action="store_true")
    renew.set_defaults(func=cmd_renew)

    status = sub.add_parser("status", help="Show posted ads and pacing budget")
    status.set_defaults(func=cmd_status)

    return parser


def main(argv: List[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        return int(args.func(args))
    except (PostingError, PhotoLibraryError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except SessionLockedError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
