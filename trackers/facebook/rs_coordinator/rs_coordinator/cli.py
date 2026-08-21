"""Command line entry point: `rsc`."""

import argparse
import base64
import binascii
import functools
import getpass
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import __version__
from .db import open_database
from .sharding import (
    DEFAULT_CONTROL_PLANE_TOKEN_ENV,
    check_region_coverage,
    check_region_overlap,
    generate_all,
    load_toml,
)
from .tokens import TokenError, generate_secret, mint_worker_token
from .vault import SECRET_FIELDS, AccountStore, Vault, VaultError, generate_key

DEFAULT_CONFIGS = Path(__file__).resolve().parents[2] / "configs"

# The secrets `vault set-account` asks for, in prompt order. Each one can be
# skipped so an operator updating a single field is not walked through all four.
# What Facebook (and every authenticator app) uses: 6 digits, 30 seconds, SHA-1.
TOTP_DEFAULTS = (6, 30, "SHA1")
TOTP_ALGORITHMS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}

SECRET_PROMPTS = (
    ("password", "--skip-password", "Facebook password"),
    ("email", "--skip-email", "Login / recovery email address"),
    ("email_password", "--skip-email-password", "Password for that email account"),
    ("totp_secret", "--skip-totp", "TOTP secret (base32 key or otpauth:// URI)"),
)


def cmd_gen_configs(args: argparse.Namespace) -> int:
    master = Path(args.master)
    fleet = Path(args.fleet)
    output = Path(args.output)

    for path in (master, fleet):
        if not path.exists():
            print(f"error: {path} not found", file=sys.stderr)
            return 1

    master_config = load_toml(master)
    fleet_config = load_toml(fleet)

    # Overlap only costs worker time — the coordinator dedupes — so it is a
    # warning.
    for warning in check_region_overlap(master_config, fleet_config):
        print(f"warning: {warning}", file=sys.stderr)

    # A gap is not: those metros are simply never searched, and nothing
    # downstream ever says so. Refuse to write configs that quietly cover less
    # than the single-machine config they replace.
    gaps = check_region_coverage(master_config, fleet_config)
    if gaps and not args.allow_gaps:
        for gap in gaps:
            print(f"error: {gap}", file=sys.stderr)
        print(
            "Pass --allow-gaps to generate anyway (a deliberate phased rollout).",
            file=sys.stderr,
        )
        return 1
    for gap in gaps:
        print(f"warning: {gap}", file=sys.stderr)

    written = generate_all(master, fleet, output)
    if not written:
        print("No workers defined in fleet.toml.", file=sys.stderr)
        return 1
    for path in written:
        print(f"wrote {path}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("rs_coordinator.app:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    from .db import open_database

    # Whatever backend the server uses, so `rsc status` never reports on a
    # different database than the one answering requests.
    db = open_database()
    workers = db.list_workers()
    if not workers:
        print("No workers have reported yet.")
    else:
        now = datetime.now(timezone.utc)
        print(f"{'WORKER':<16} {'REGION':<16} {'STATUS':<8} LAST HEARTBEAT")
        for worker in workers:
            beat = worker.get("last_heartbeat_at") or ""
            note = ""
            if beat:
                try:
                    age = now - datetime.fromisoformat(beat)
                    note = f"  ({int(age.total_seconds() // 60)}m ago)"
                    if age > timedelta(hours=2):
                        note += "  STALE"
                except ValueError:
                    pass
            print(
                f"{worker['worker_id']:<16} {str(worker.get('region') or '-'):<16} "
                f"{str(worker.get('status') or '-'):<8} {beat}{note}"
            )

    since = (datetime.now(timezone.utc) - timedelta(hours=args.hours)).isoformat(
        timespec="seconds"
    )
    listings = db.query_listings(since=since, limit=args.limit)
    print(f"\n{len(listings)} listing(s) in the last {args.hours}h:")
    for listing in listings:
        print(
            f"  [{listing.get('ai_score')}/5] {listing.get('title')} — "
            f"{listing.get('price')} — {listing.get('location')}"
        )
        if args.urls:
            print(f"        {listing.get('post_url')}")
    return 0


def cmd_test_telegram(args: argparse.Namespace) -> int:
    from .telegram_notify import TelegramNotifier

    notifier = TelegramNotifier(
        token=os.environ.get("TELEGRAM_TOKEN"), chat_id=os.environ.get("TELEGRAM_CHAT_ID")
    )
    if not notifier.enabled:
        print("error: TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set", file=sys.stderr)
        return 1
    ok = notifier.send("Recycle Servers coordinator test message\\.")
    print("sent" if ok else "failed")
    return 0 if ok else 1


def cmd_telegram_chatid(args: argparse.Namespace) -> int:
    """Discover the chat id by waiting for a message to the bot, then save it.

    A bot cannot start a conversation, so the recipient must message it once.
    This polls getUpdates until that message arrives, records the chat id in
    the env file, and sends a confirmation.
    """
    import json
    import time
    import urllib.request

    token = os.environ.get("TELEGRAM_TOKEN")
    if not token:
        print("error: TELEGRAM_TOKEN is not set", file=sys.stderr)
        return 1

    def api(method: str) -> dict:
        with urllib.request.urlopen(
            f"https://api.telegram.org/bot{token}/{method}", timeout=30
        ) as response:
            return json.load(response)

    me = api("getMe")
    if not me.get("ok"):
        print(f"error: token rejected by Telegram: {me}", file=sys.stderr)
        return 1
    username = me["result"]["username"]
    print(f"Bot: @{username}")
    print(f"Open https://t.me/{username} and send it any message (e.g. /start).")
    print(f"Waiting up to {args.timeout}s...")

    deadline = time.time() + args.timeout
    chat = None
    while time.time() < deadline:
        updates = api("getUpdates")
        for update in updates.get("result", []):
            message = update.get("message") or update.get("channel_post")
            if message and message.get("chat"):
                chat = message["chat"]
                break
        if chat:
            break
        time.sleep(3)

    if not chat:
        print("error: no message received before timeout.", file=sys.stderr)
        return 1

    chat_id = str(chat["id"])
    name = chat.get("title") or chat.get("username") or chat.get("first_name") or "?"
    print(f"Found chat: {name} (id {chat_id})")

    if args.env_file:
        _upsert_env(Path(args.env_file), "TELEGRAM_CHAT_ID", chat_id)
        print(f"Wrote TELEGRAM_CHAT_ID to {args.env_file}")

    from .telegram_notify import TelegramNotifier

    ok = TelegramNotifier(token=token, chat_id=chat_id).send(
        "Recycle Servers alerts are wired up\\. Matched Marketplace listings will "
        "arrive here\\."
    )
    print("confirmation sent" if ok else "warning: confirmation failed to send")
    return 0


def _upsert_env(path: Path, key: str, value: str) -> None:
    """Set KEY=value in a .env file, replacing any existing line."""
    lines = path.read_text().splitlines() if path.exists() else []
    replaced = False
    for i, line in enumerate(lines):
        if line.startswith(f"{key}=") or line.startswith(f"{key} ="):
            lines[i] = f"{key}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")


def _env_value(path: Path, key: str) -> Optional[str]:
    """The value KEY already has in an env file, or None when it is unset."""
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        name, sep, value = stripped.partition("=")
        if sep and name.strip() == key:
            return value.strip()
    return None


# -- vault ------------------------------------------------------------------
# The operator path: this is where the real Facebook passwords and TOTP secrets
# are loaded. Secrets are prompted for rather than passed as arguments so they
# never reach shell history, and nothing here ever prints a stored value back.


def _guarded(func: Callable[[argparse.Namespace], int]) -> Callable[[argparse.Namespace], int]:
    """Turn a vault/token failure into an actionable message, not a traceback."""

    @functools.wraps(func)
    def wrapper(args: argparse.Namespace) -> int:
        try:
            return func(args)
        except (VaultError, TokenError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

    return wrapper


def _account_store() -> AccountStore:
    """A store built for this one command — the CLI shares no singletons.

    Uses the configured backend, not always SQLite: seeding an account into a
    local file while the server reads Postgres is a split brain that surfaces
    much later as "the worker cannot find its secret".
    """
    return AccountStore(open_database(), Vault())


def _parse_totp(raw: str) -> Tuple[str, int, int, str]:
    """(base32 secret, digits, period, algorithm) from what a human pasted.

    Accepts what an operator actually has: the spaced key Facebook prints, or
    the whole ``otpauth://`` URI behind the QR code. `rs_poster` already does
    this properly, so use it when the two projects are installed together and
    fall back to a local check when they are not.
    """
    text = (raw or "").strip()
    if not text:
        raise VaultError("No TOTP secret given.")
    try:
        from rs_poster.totp import TotpError, parse_secret
    except ImportError:
        return _parse_totp_local(text)
    try:
        config = parse_secret(text)
    except TotpError as e:
        raise VaultError(str(e)) from e
    return config.secret, config.digits, config.period, config.algorithm


def _parse_totp_local(text: str) -> Tuple[str, int, int, str]:
    """Fallback parsing for when rs_poster is not installed alongside."""
    digits, period, algorithm = TOTP_DEFAULTS
    if text.lower().startswith("otpauth://"):
        from urllib.parse import parse_qs, urlparse

        params = parse_qs(urlparse(text).query)
        values = params.get("secret")
        if not values:
            raise VaultError("That otpauth:// URI has no 'secret' parameter.")
        text = values[0]
        algorithm = params.get("algorithm", [algorithm])[0].upper()
        if algorithm not in TOTP_ALGORITHMS:
            raise VaultError(
                f"Unsupported algorithm '{algorithm}'. Supported: "
                f"{', '.join(sorted(TOTP_ALGORITHMS))}."
            )
        try:
            digits = int(params.get("digits", [digits])[0])
            period = int(params.get("period", [period])[0])
        except ValueError as e:
            raise VaultError(f"That otpauth:// URI has a non-numeric digits/period: {e}") from e

    secret = re.sub(r"[\s\-_]+", "", text).rstrip("=").upper()
    try:
        base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    except (binascii.Error, ValueError) as e:
        raise VaultError(
            "That does not decode as a base32 TOTP secret. Copy the key Facebook shows "
            "under Settings -> Security -> Two-factor -> Authentication app -> "
            '"Set up another way", or paste the whole otpauth:// URI.'
        ) from e
    return secret, digits, period, algorithm


def _normalize_totp_secret(raw: str) -> str:
    """The validated value to store for `totp_secret`.

    Normally the bare base32 key. A URI carrying non-default parameters is kept
    verbatim instead: the vault has no field for digits/period/algorithm, and
    the code service honours a stored URI, so flattening one here would produce
    codes that are silently wrong.
    """
    secret, digits, period, algorithm = _parse_totp(raw)
    if (digits, period, algorithm) != TOTP_DEFAULTS:
        return raw.strip()
    return secret


def _totp_code(stored: str) -> Tuple[str, int]:
    """The code a stored secret produces right now, and its seconds remaining.

    Plain RFC 6238 — the same thing an authenticator app computes, which is the
    point: the operator compares the two.
    """
    try:
        import pyotp
    except ImportError as e:
        raise VaultError("pyotp is not installed — `pip install pyotp` to show codes.") from e

    secret, digits, period, algorithm = _parse_totp(stored)
    totp = pyotp.TOTP(
        secret + "=" * (-len(secret) % 8),
        digits=digits,
        interval=period,
        digest=TOTP_ALGORITHMS[algorithm],
    )
    return totp.now(), period - int(time.time()) % period


def _secret_marks(store: AccountStore, account_id: str) -> str:
    """Which secret fields are stored for an account. Never a value."""
    try:
        stored = store.get_secret(account_id)
    except VaultError as e:
        return f"unreadable — {e}"
    return "  ".join(f"{field}={'SET' if stored.get(field) else '-'}" for field in SECRET_FIELDS)


@_guarded
def cmd_vault_init(args: argparse.Namespace) -> int:
    path = Path(args.write_env) if args.write_env else None
    if path is not None and not args.force:
        clash = [
            key
            for key in ("RS_VAULT_KEY", "RS_WORKER_TOKEN_SECRET")
            if _env_value(path, key)
        ]
        if clash:
            print(f"error: {path} already defines {', '.join(clash)}.", file=sys.stderr)
            print(
                "Rotating RS_VAULT_KEY makes every secret already in the vault unreadable, "
                "and rotating RS_WORKER_TOKEN_SECRET revokes every worker token. Re-run "
                "with --force only if that is what you want.",
                file=sys.stderr,
            )
            return 1

    key = generate_key()
    secret = generate_secret()
    print(f"RS_VAULT_KEY={key}")
    print(f"RS_WORKER_TOKEN_SECRET={secret}")
    print()
    print("Put both in the control plane's environment (they are read at startup):")
    print("  RS_VAULT_KEY           encrypts every account secret. Back it up somewhere")
    print("                         safe — without it the vault cannot be read.")
    print("  RS_WORKER_TOKEN_SECRET signs per-worker tokens (`rsc mint-token --worker <id>`).")

    if path is not None:
        _upsert_env(path, "RS_VAULT_KEY", key)
        _upsert_env(path, "RS_WORKER_TOKEN_SECRET", secret)
        try:
            os.chmod(path, 0o600)
        except OSError:  # pragma: no cover - platform dependent
            pass
        print(f"\nwrote both to {path}")
        if args.force:
            print(
                "warning: --force replaced existing values; secrets stored under the old "
                "key are now unreadable and every worker token must be re-minted.",
                file=sys.stderr,
            )
    return 0


@_guarded
def cmd_vault_set_account(args: argparse.Namespace) -> int:
    store = _account_store()
    secrets: Dict[str, Any] = {}

    if args.secret_file:
        path = Path(args.secret_file)
        if not path.exists():
            print(f"error: {path} not found", file=sys.stderr)
            return 1
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            print(f"error: {path} is not valid JSON: {e}", file=sys.stderr)
            return 1
        if not isinstance(data, dict):
            print(f"error: {path} must contain a JSON object of secret fields", file=sys.stderr)
            return 1
        for field, value in data.items():
            if field not in SECRET_FIELDS:
                print(
                    f"error: unknown secret field '{field}' in {path}. "
                    f"Known: {', '.join(SECRET_FIELDS)}",
                    file=sys.stderr,
                )
                return 1
            if field == "totp_secret" and value is not None:
                value = _normalize_totp_secret(str(value))
            secrets[field] = value
    elif not args.no_prompt:
        print(f"Secrets for account '{args.account_id}' — input is hidden.")
        print("Leave a prompt blank to keep whatever is already stored.")
        sys.stdout.flush()  # getpass writes to the tty; keep the header in order
        for field, flag, label in SECRET_PROMPTS:
            if getattr(args, flag.lstrip("-").replace("-", "_")):
                continue
            entered = getpass.getpass(f"  {label}: ").strip()
            if not entered:
                continue
            secrets[field] = _normalize_totp_secret(entered) if field == "totp_secret" else entered

    for field in args.clear_secret or []:
        secrets[field] = None

    existing = store.get_account(args.account_id)
    # put_account takes a plain bool, so an update that does not mention the
    # flag must re-send whatever the account already had.
    allow_password_login = bool(existing["allow_password_login"]) if existing else False
    if args.allow_password_login is not None:
        allow_password_login = args.allow_password_login

    store.put_account(
        args.account_id,
        secrets or None,
        worker_id=args.worker,
        fb_username=args.fb_username,
        region=args.region,
        proxy=args.proxy,
        vnc_url=args.vnc_url,
        allow_password_login=allow_password_login,
        merge_secrets=True,
    )

    print(f"{'updated' if existing else 'created'} account '{args.account_id}'")
    print(f"  secrets: {_secret_marks(store, args.account_id)}")

    # Show the code the freshly stored secret produces, so a mistyped key is
    # caught here rather than at 2am when a worker cannot log in.
    if secrets.get("totp_secret"):
        try:
            code, remaining = _totp_code(secrets["totp_secret"])
            print(
                f"  TOTP now: {code} ({remaining}s left) — it must match your authenticator"
            )
        except VaultError as e:
            print(f"warning: {e}", file=sys.stderr)
    return 0


@_guarded
def cmd_vault_list(args: argparse.Namespace) -> int:
    store = _account_store()
    accounts = store.list_accounts()
    if not accounts:
        print("No accounts in the vault. Add one with `rsc vault set-account --account-id <id>`.")
        return 0

    print(f"{len(accounts)} account(s):")
    for account in accounts:
        account_id = account["account_id"]
        print(f"\n{account_id}")
        print(
            f"  worker: {account.get('worker_id') or '-'}    "
            f"region: {account.get('region') or '-'}    "
            f"password-login: {'yes' if account.get('allow_password_login') else 'no'}"
        )
        print(
            f"  fb user: {account.get('fb_username') or '-'}    "
            f"proxy: {account.get('proxy') or '-'}    "
            f"vnc: {account.get('vnc_url') or '-'}"
        )
        print(f"  secrets: {_secret_marks(store, account_id)}")
    print("\nSET means a value is stored; secret values are never printed.")
    return 0


@_guarded
def cmd_vault_show_code(args: argparse.Namespace) -> int:
    store = _account_store()
    secret = store.get_secret(args.account_id).get("totp_secret")
    if not secret:
        print(
            f"error: account '{args.account_id}' has no TOTP secret stored. Add one with "
            f"`rsc vault set-account --account-id {args.account_id} --skip-password "
            "--skip-email --skip-email-password`.",
            file=sys.stderr,
        )
        return 1
    code, remaining = _totp_code(str(secret))
    print(f"{code}  ({remaining}s left)")
    if remaining <= 5:
        print("(about to roll over — compare against the next code)", file=sys.stderr)
    return 0


@_guarded
def cmd_vault_rm(args: argparse.Namespace) -> int:
    store = _account_store()
    if store.get_account(args.account_id) is None:
        print(f"error: no account '{args.account_id}' in the vault.", file=sys.stderr)
        return 1
    if not args.yes:
        answer = input(
            f"Delete account '{args.account_id}' and every secret stored for it? [y/N] "
        )
        if answer.strip().lower() not in ("y", "yes"):
            print("aborted; nothing was deleted")
            return 1
    store.delete_account(args.account_id)
    print(f"deleted account '{args.account_id}'")
    return 0


@_guarded
def cmd_mint_token(args: argparse.Namespace) -> int:
    print(mint_worker_token(args.worker))
    # The note goes to stderr so the token itself stays pipeable. The variable
    # name matches the one `rsc gen-configs` writes into the worker's config.
    env_var = DEFAULT_CONTROL_PLANE_TOKEN_ENV
    print(
        f"\nPut this in worker '{args.worker}''s environment as {env_var} (one worker "
        "per VM, so the name is the same on each). It is sent as "
        "`Authorization: Bearer <token>` and authenticates that worker only, so a "
        "compromised VM reaches nothing but its own account. Rotating "
        "RS_WORKER_TOKEN_SECRET revokes every token at once.",
        file=sys.stderr,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rsc", description="Recycle Servers coordinator")
    # The first question during an incident is "which version is this box
    # running", and the answer has to come from the process, not from whatever
    # is checked out on the machine you are typing on.
    parser.add_argument("--version", action="version", version=f"rsc {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("gen-configs", help="Generate per-worker configs from master + fleet")
    gen.add_argument("--master", default=str(DEFAULT_CONFIGS / "master.toml"))
    gen.add_argument("--fleet", default=str(DEFAULT_CONFIGS / "fleet.toml"))
    gen.add_argument("--output", default=str(DEFAULT_CONFIGS / "generated"))
    gen.add_argument(
        "--allow-gaps",
        action="store_true",
        help="Generate even if some search_city entries are in no region",
    )
    gen.set_defaults(func=cmd_gen_configs)

    serve = sub.add_parser("serve", help="Run the coordinator API")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=8500)
    serve.add_argument("--reload", action="store_true")
    serve.set_defaults(func=cmd_serve)

    status = sub.add_parser("status", help="Show fleet health and recent listings")
    status.add_argument("--hours", type=int, default=24)
    status.add_argument("--limit", type=int, default=25)
    status.add_argument("--urls", action="store_true", help="Include listing URLs")
    status.set_defaults(func=cmd_status)

    test = sub.add_parser("test-telegram", help="Send a test Telegram message")
    test.set_defaults(func=cmd_test_telegram)

    chatid = sub.add_parser(
        "telegram-chatid", help="Wait for a message to the bot and save the chat id"
    )
    chatid.add_argument("--timeout", type=int, default=180, help="Seconds to wait")
    chatid.add_argument(
        "--env-file",
        default=str(DEFAULT_CONFIGS / "secrets.env"),
        help="Env file to write TELEGRAM_CHAT_ID into (empty to skip)",
    )
    chatid.set_defaults(func=cmd_telegram_chatid)

    vault = sub.add_parser("vault", help="Manage the encrypted account vault")
    vault_sub = vault.add_subparsers(dest="vault_command", required=True)

    v_init = vault_sub.add_parser(
        "init", help="Generate the vault key and the worker token secret"
    )
    v_init.add_argument("--write-env", help="Env file to upsert the generated values into")
    v_init.add_argument(
        "--force",
        action="store_true",
        help="Replace values already in the env file (old secrets become unreadable)",
    )
    v_init.set_defaults(func=cmd_vault_init)

    v_set = vault_sub.add_parser(
        "set-account", help="Create or update an account; secrets are prompted for"
    )
    v_set.add_argument("--account-id", required=True)
    v_set.add_argument("--worker", help="Worker id that owns this account")
    v_set.add_argument("--region", help="Region key from master.toml")
    v_set.add_argument("--fb-username", help="Facebook login (stored unencrypted, for display)")
    v_set.add_argument("--proxy", help="Proxy URL this account browses through")
    v_set.add_argument("--vnc-url", help="Where a human can take over this worker's browser")
    login = v_set.add_mutually_exclusive_group()
    login.add_argument(
        "--allow-password-login",
        dest="allow_password_login",
        action="store_const",
        const=True,
        default=None,
        help="Let the worker request the password (default: keep current setting)",
    )
    login.add_argument(
        "--no-password-login",
        dest="allow_password_login",
        action="store_const",
        const=False,
        help="Codes only — the password is never released to the worker",
    )
    v_set.add_argument(
        "--secret-file",
        help='JSON file of secrets, e.g. {"password": "...", "totp_secret": "..."}. '
        "Read non-interactively — nothing is prompted for.",
    )
    v_set.add_argument(
        "--no-prompt", action="store_true", help="Ask for no secrets (metadata-only update)"
    )
    for _field, flag, label in SECRET_PROMPTS:
        v_set.add_argument(flag, action="store_true", help=f"Skip the {label.lower()} prompt")
    v_set.add_argument(
        "--clear-secret",
        action="append",
        choices=list(SECRET_FIELDS),
        help="Delete a stored secret field (repeatable)",
    )
    v_set.set_defaults(func=cmd_vault_set_account)

    v_list = vault_sub.add_parser("list", help="List accounts and which secrets they hold")
    v_list.set_defaults(func=cmd_vault_list)

    v_code = vault_sub.add_parser(
        "show-code", help="Print an account's current TOTP code to verify the stored secret"
    )
    v_code.add_argument("--account-id", required=True)
    v_code.set_defaults(func=cmd_vault_show_code)

    v_rm = vault_sub.add_parser("rm", help="Delete an account and its secrets")
    v_rm.add_argument("--account-id", required=True)
    v_rm.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")
    v_rm.set_defaults(func=cmd_vault_rm)

    token = sub.add_parser("mint-token", help="Print a worker's bearer token")
    token.add_argument("--worker", required=True, help="Worker id the token authenticates")
    token.set_defaults(func=cmd_mint_token)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
