"""`rs-session` — create and inspect Facebook sessions without a password.

Three ways in, none of which store credentials:

  capture   open a browser, log in by hand, save the resulting session
  import    convert cookies exported from a browser you are already logged into
  check     confirm a session file still authenticates, and when it expires

The output is always a Playwright storage_state file. Point both the monitor
(`storage_state_path`) and the poster (`--storage-state`) at it.

Because every worker account has two-factor authentication on, two more
commands handle the six-digit code so nobody has to fetch it from a web
authenticator by hand:

  set-secret  store an account's TOTP secret in its session sidecar, once
  totp        print the current code — for one session, or all of them

Once a secret is stored, `capture` fills the 2FA prompt in by itself.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import List, Optional

from . import selectors as sel
from . import totp as totp_mod
from .cookies import (
    CookieError,
    describe,
    load_cookie_file,
    meta_path_for,
    read_session_meta,
    storage_state_cookies,
    write_session_meta,
    write_storage_state,
)

DEFAULT_STATE = os.environ.get("FB_STATE", "/data/fb_state.json")
MARKETPLACE_URL = "https://www.facebook.com/marketplace/"


def _print_session(info, path: Path) -> None:
    print(f"Session written to {path}")
    print(f"  account id : {info.account_id or 'unknown'}")
    print(f"  cookies    : {len(info.cookie_names)}")
    days = info.days_remaining
    if days is None:
        print("  expires    : session cookies only (no fixed expiry)")
    else:
        print(f"  expires in : {days:.0f} days")
        if days < 14:
            print("  NOTE: expiring soon — plan to re-export.", file=sys.stderr)


def _resolve_totp_or_warn(
    state_path: str | Path, explicit: str | None = None
) -> Optional[totp_mod.TotpConfig]:
    """Resolve this session's secret, reporting a bad one instead of raising."""
    try:
        return totp_mod.resolve(state_path, explicit)
    except totp_mod.TotpError as e:
        print(f"warning: stored 2FA secret is unusable: {e}", file=sys.stderr)
        return None


def _autofill_two_factor(page, config: totp_mod.TotpConfig, submitted: set) -> bool:
    """Fill the 2FA prompt if it is on screen. Safe to call on every poll.

    Each code is submitted at most once: Facebook rejects a code it has already
    consumed, so re-typing the same one inside its 30-second window turns a
    recoverable prompt into a failed login.
    """
    try:
        field = page.locator(sel.TWO_FACTOR_INPUT).first
        if not field.is_visible(timeout=1000):
            return False
    except Exception:
        return False

    # Too late in the window to be worth sending; the next poll will catch it.
    if totp_mod.seconds_remaining(config) <= 3:
        return False

    code = totp_mod.generate(config)
    if code in submitted:
        return False
    submitted.add(code)

    try:
        field.fill("")
        field.type(code, delay=120)
        page.keyboard.press("Enter")
    except Exception as e:
        print(f"warning: could not submit the 2FA code: {e}", file=sys.stderr)
        return False

    print(f"  2FA prompt detected — submitted {code}")
    page.wait_for_timeout(5000)
    try:
        trust = page.get_by_role("button", name=sel.TRUST_DEVICE_RE).first
        if trust.is_visible(timeout=3000):
            trust.click()
    except Exception:
        pass
    return True


def _session_files(directory: str | Path) -> List[Path]:
    """Every session a directory knows about, one path per account.

    A sidecar counts even with no session file next to it: `set-secret` runs
    before the first `capture`, so that is exactly the state an account is in
    while it is being set up.
    """
    directory = Path(directory)
    if not directory.is_dir():
        return []

    names = set()
    for path in directory.glob("*.json"):
        name = path.name
        # A sidecar is "<session file>.meta.json", so dropping that suffix
        # gives back the session file name — extension included.
        if name.endswith(".meta.json"):
            name = name[: -len(".meta.json")]
        names.add(name)
    return sorted(directory / name for name in names)


def cmd_set_secret(args: argparse.Namespace) -> int:
    """Store one account's TOTP secret alongside its session, once."""
    path = Path(args.storage_state)

    if args.remove:
        if totp_mod.clear(path):
            print(f"Removed the stored 2FA secret for {path}")
        else:
            print(f"No 2FA secret was stored for {path}")
        return 0

    secret = args.secret
    if not secret:
        # Prompting keeps the secret out of shell history, which is where it
        # would otherwise sit in plain text forever.
        import getpass

        secret = getpass.getpass("2FA secret (base32 key or otpauth:// URI): ")

    config = totp_mod.parse_secret(secret)
    meta_path = totp_mod.store(path, config)

    print(f"Stored the 2FA secret for {path}")
    print(f"  sidecar    : {meta_path} (0600, gitignored)")
    if config.label:
        print(f"  label      : {config.label}")
    if not config.is_default:
        print(
            f"  parameters : {config.digits} digits / {config.period}s / "
            f"{config.algorithm}"
        )
    print(f"  code now   : {totp_mod.generate(config)}")
    print(
        "\nConfirm it matches your authenticator before relying on it. If the "
        "session file does not exist yet, the secret is still recorded and "
        "`rs-session capture` will use it."
    )
    return 0


def _print_code(config: totp_mod.TotpConfig, label: str, raw: bool) -> None:
    code = totp_mod.generate(config)
    if raw:
        print(code)
    else:
        print(f"{label:<24} {code}  ({totp_mod.seconds_remaining(config)}s left)")


def cmd_totp(args: argparse.Namespace) -> int:
    """Print the current code — for one session, or the whole fleet."""
    if args.all:
        paths = _session_files(args.dir or Path(args.storage_state).parent)
        if not paths:
            print(
                f"No session files found in {args.dir or Path(args.storage_state).parent}",
                file=sys.stderr,
            )
            return 1
        found = 0
        for path in paths:
            config = _resolve_totp_or_warn(path)
            if config is None:
                print(f"{path.stem:<24} (no secret stored)", file=sys.stderr)
                continue
            found += 1
            _print_code(config, path.stem, args.raw)
        return 0 if found else 1

    config = _resolve_totp_or_warn(args.storage_state, args.secret)
    if config is None:
        print(
            f"error: no 2FA secret for {args.storage_state}. Store one with:\n"
            f"  rs-session set-secret --storage-state {args.storage_state}",
            file=sys.stderr,
        )
        return 1

    if not args.watch:
        _print_code(config, Path(args.storage_state).stem, args.raw)
        return 0

    print("Watching — Ctrl-C to stop.")
    last = None
    try:
        while True:
            code = totp_mod.generate(config)
            if code != last:
                last = code
                print(f"  {code}   valid {totp_mod.seconds_remaining(config)}s")
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


def cmd_import(args: argparse.Namespace) -> int:
    cookies = load_cookie_file(args.cookies)
    info = write_storage_state(cookies, args.storage_state)
    write_session_meta(
        args.storage_state,
        user_agent=args.user_agent,
        proxy=args.proxy,
        account_id=info.account_id,
    )
    _print_session(info, Path(args.storage_state))

    if not args.user_agent:
        print(
            "\nNOTE: no --user-agent recorded. Facebook ties a session to the browser "
            "it was created in, so passing the exporting browser's user agent makes "
            "the session survive longer. Find it at https://whatmyuseragent.com/",
            file=sys.stderr,
        )
    print("\nVerify it actually authenticates:  rs-session check")
    return 0


def cmd_capture(args: argparse.Namespace) -> int:
    """Open a real browser, let a human log in, keep only the resulting session."""
    from playwright.sync_api import sync_playwright

    print("Opening a browser. Log into Facebook, then return here.")
    print("Nothing you type is recorded — only the resulting session cookies are saved.\n")

    if args.proxy:
        print(f"Using proxy {args.proxy} — the session will be bound to that IP.\n")

    totp_config = _resolve_totp_or_warn(args.storage_state, getattr(args, "secret", None))
    if totp_config is not None:
        print("2FA: a secret is stored for this session — the code will be filled in.\n")
    else:
        print(
            "2FA: no secret stored for this session, so you will have to type the "
            "code yourself.\n     Store it once and this step goes away:\n"
            f"       rs-session set-secret --storage-state {args.storage_state} "
            "--secret <key>\n",
            file=sys.stderr,
        )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False, args=["--disable-blink-features=AutomationControlled"]
        )
        existing = Path(args.storage_state)
        context = browser.new_context(
            storage_state=str(existing) if existing.exists() and args.reuse else None,
            proxy={"server": args.proxy} if args.proxy else None,
            user_agent=args.user_agent,
            viewport={"width": 1440, "height": 900},
        )
        page = context.new_page()
        page.goto(MARKETPLACE_URL)

        print(f"Waiting up to {args.timeout}s for a logged-in session...")
        print("(Press Enter here once you are logged in, or just wait.)")

        deadline = args.timeout * 1000
        step = 3000
        waited = 0
        logged_in = False
        submitted: set[str] = set()
        while waited < deadline:
            page.wait_for_timeout(step)
            waited += step
            try:
                if any(cookie["name"] == "c_user" for cookie in context.cookies()):
                    logged_in = True
                    break
            except Exception:
                pass
            if totp_config is not None:
                _autofill_two_factor(page, totp_config, submitted)

        if not logged_in:
            browser.close()
            print(
                "error: no logged-in session detected before the timeout.",
                file=sys.stderr,
            )
            return 1

        # Take the whole state, not just cookies: `origins` carries Facebook's
        # localStorage and (with indexed_db) its IndexedDB device state. A
        # cookies-only capture starts every worker off missing that, which is
        # the opposite of the "look like the browser this session was born in"
        # goal. The cookies still go through our own validation below.
        state = context.storage_state(indexed_db=True)
        cookies = state.get("cookies", [])
        origins = state.get("origins", [])

        # Record the browser's real user agent so workers can present the same
        # one; a mismatch is a known session-hijack heuristic.
        try:
            user_agent = page.evaluate("() => navigator.userAgent")
        except Exception:
            user_agent = args.user_agent
        browser.close()

    info = write_storage_state(cookies, args.storage_state, origins=origins)
    write_session_meta(
        args.storage_state,
        user_agent=user_agent,
        proxy=args.proxy,
        account_id=info.account_id,
    )
    _print_session(info, Path(args.storage_state))
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    path = Path(args.storage_state)
    cookies = storage_state_cookies(path)
    info = describe(cookies)

    print(f"Session file : {path}")
    print(f"  account id : {info.account_id or 'unknown'}")
    print(f"  cookies    : {len(info.cookie_names)}")
    if not info.has_required:
        print(f"  MISSING    : {', '.join(info.missing)}", file=sys.stderr)
        return 1
    days = info.days_remaining
    if days is not None:
        print(f"  expires in : {days:.0f} days")
        if info.expired:
            print("  EXPIRED — re-import or re-capture.", file=sys.stderr)
            return 1

    meta = read_session_meta(path)
    if meta.get("user_agent"):
        print(f"  user agent : {meta['user_agent'][:60]}...")
    if meta.get("proxy"):
        print(f"  proxy      : {meta['proxy']}")
    if meta.get("captured_at"):
        print(f"  captured   : {meta['captured_at']}")

    totp_config = _resolve_totp_or_warn(path)
    if totp_config is None:
        print("  2FA        : no secret stored — logins will need a code by hand")
    else:
        print(f"  2FA        : stored (code now {totp_mod.generate(totp_config)})")

    if args.offline:
        return 0

    from playwright.sync_api import sync_playwright

    # Check under the same browser identity and network the session was born
    # on, otherwise a passing check does not predict how a worker will fare.
    proxy = args.proxy or meta.get("proxy")
    user_agent = meta.get("user_agent")

    print("\nChecking against Facebook...")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=args.headless, args=["--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            storage_state=str(path),
            proxy={"server": proxy} if proxy else None,
            user_agent=user_agent,
            viewport={"width": 1440, "height": 900},
        )
        page = context.new_page()
        page.goto(MARKETPLACE_URL, timeout=60000)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(4000)

        login_form = page.locator('input[name="email"]').count() > 0
        url = page.url
        # Facebook parks a challenged session on a checkpoint URL rather than
        # showing the login form, so treat that separately.
        checkpoint = "checkpoint" in url or "login" in url

        if args.save_refreshed and not login_form and not checkpoint:
            # Facebook rotates session cookies; saving after a successful load
            # keeps the stored session fresh. indexed_db=True so the refresh
            # keeps the device state too rather than narrowing the session to
            # cookies on every check.
            context.storage_state(path=str(path), indexed_db=True)
            print("Refreshed stored session.")
        browser.close()

    if login_form:
        print("NOT AUTHENTICATED: Facebook served the login page.", file=sys.stderr)
        print(
            "The session was likely invalidated (password change, 'log out of all "
            "devices', or a security checkpoint). Re-export cookies.",
            file=sys.stderr,
        )
        return 1
    if checkpoint:
        print(f"CHECKPOINT: Facebook redirected to {url}", file=sys.stderr)
        print(
            "Open this account in a normal browser, clear the checkpoint, then "
            "re-export cookies.",
            file=sys.stderr,
        )
        return 1

    print("Authenticated — Marketplace loaded.")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    """Machine-readable summary, for cron/monitoring."""
    path = Path(args.storage_state)
    try:
        info = describe(storage_state_cookies(path))
        meta = read_session_meta(path)
        payload = {
            "path": str(path),
            "account_id": info.account_id,
            "cookie_count": len(info.cookie_names),
            "has_required": info.has_required,
            "missing": info.missing,
            "days_remaining": info.days_remaining,
            "expired": info.expired,
            "user_agent": meta.get("user_agent"),
            "proxy": meta.get("proxy"),
            "captured_at": meta.get("captured_at"),
            # Whether a code can be produced, never the secret itself: this
            # output is meant for cron and logs.
            "totp_configured": _resolve_totp_or_warn(path) is not None,
        }
    except CookieError as e:
        payload = {"path": str(path), "error": str(e)}
    print(json.dumps(payload, indent=2))
    return 0 if payload.get("has_required") else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rs-session",
        description="Create and verify password-free Facebook sessions",
    )
    # --storage-state is shared by every subcommand. Defining it on a parent
    # parser (rather than the top level) lets it appear AFTER the subcommand —
    # `rs-session set-secret --storage-state X` — which is how everyone writes
    # it. It still accepts the pre-subcommand form too.
    common = argparse.ArgumentParser(add_help=False)
    # SUPPRESS default: when the flag is absent after the subcommand, the
    # attribute is not set here, so a value given before the subcommand (or the
    # top-level default) stands instead of being overwritten.
    common.add_argument(
        "--storage-state", default=argparse.SUPPRESS, help="Session file path"
    )

    parser.add_argument(
        "--storage-state", default=DEFAULT_STATE, help=argparse.SUPPRESS
    )
    sub = parser.add_subparsers(dest="command", required=True)

    imp = sub.add_parser(
        "import",
        parents=[common],
        help="Convert exported browser cookies into a session",
    )
    imp.add_argument(
        "--cookies",
        required=True,
        help="cookies.txt (Netscape) or JSON export from a cookie extension",
    )
    imp.add_argument(
        "--user-agent",
        help="User agent of the browser the cookies came from. Recorded so workers "
        "present the same identity; a mismatch shortens the session's life.",
    )
    imp.add_argument(
        "--proxy", help="Proxy the worker will use, recorded for later checks"
    )
    imp.set_defaults(func=cmd_import)

    cap = sub.add_parser(
        "capture",
        parents=[common],
        help="Log in manually in a browser and save the session",
    )
    cap.add_argument("--timeout", type=int, default=300, help="Seconds to wait for login")
    cap.add_argument("--reuse", action="store_true", help="Start from the existing session")
    cap.add_argument(
        "--proxy",
        help="Capture through the worker's proxy so the session is born on the IP "
        "that will use it. Strongly recommended for remote workers.",
    )
    cap.add_argument("--user-agent", help="Override the browser's user agent")
    cap.add_argument(
        "--secret",
        help="TOTP secret to fill the 2FA prompt with, instead of the stored one",
    )
    cap.set_defaults(func=cmd_capture)

    secret = sub.add_parser(
        "set-secret",
        parents=[common],
        help="Store this account's 2FA secret so logins fill the code in themselves",
        description="The secret is written to the session's .meta.json sidecar "
        "(0600, gitignored), next to the cookies it belongs with. Omit --secret "
        "to be prompted, which keeps it out of your shell history.",
    )
    secret.add_argument(
        "--secret",
        help="Base32 key from Facebook's 'Set up another way', or a full "
        "otpauth:// URI from the QR code",
    )
    secret.add_argument(
        "--remove", action="store_true", help="Delete the stored secret instead"
    )
    secret.set_defaults(func=cmd_set_secret)

    code = sub.add_parser(
        "totp",
        parents=[common],
        help="Print the current 2FA code for a session, or for all of them",
    )
    code.add_argument("--secret", help="Use this secret instead of the stored one")
    code.add_argument(
        "--all",
        action="store_true",
        help="Print a code for every session in the sessions directory",
    )
    code.add_argument(
        "--dir", help="Sessions directory for --all (default: alongside --storage-state)"
    )
    code.add_argument(
        "--watch", action="store_true", help="Keep printing as the code rolls over"
    )
    code.add_argument(
        "--raw",
        action="store_true",
        help="Print just the digits, for scripting (e.g. | pbcopy)",
    )
    code.set_defaults(func=cmd_totp)

    check = sub.add_parser(
        "check", parents=[common], help="Verify the session still authenticates"
    )
    check.add_argument("--offline", action="store_true", help="Inspect the file only")
    check.add_argument("--headless", action="store_true")
    check.add_argument("--proxy", help="Check through this proxy, as the worker would")
    check.add_argument(
        "--save-refreshed",
        action="store_true",
        help="Persist rotated cookies after a successful check",
    )
    check.set_defaults(func=cmd_check)

    info = sub.add_parser(
        "info", parents=[common], help="Print session status as JSON"
    )
    info.set_defaults(func=cmd_info)

    return parser


def main(argv: List[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (CookieError, totp_mod.TotpError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
