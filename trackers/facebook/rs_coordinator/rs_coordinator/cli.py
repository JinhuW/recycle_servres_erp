"""Command line entry point: `rsc`."""

import argparse
import functools
import getpass
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import __version__
from .db import open_database
from .sharding import (
    DEFAULT_CONTROL_PLANE_TOKEN_ENV,
    check_region_coverage,
    check_region_overlap,
    generate_all,
    load_toml,
)
from .tokens import TokenError, generate_secret, mint_host_token, mint_worker_token
from .totp import normalize_totp_secret, totp_code
from .vault import SECRET_FIELDS, AccountStore, Vault, VaultError, generate_key

DEFAULT_CONFIGS = Path(__file__).resolve().parents[2] / "configs"

# The secrets `vault set-account` asks for, in prompt order. Each one can be
# skipped so an operator updating a single field is not walked through all four.
# What Facebook (and every authenticator app) uses: 6 digits, 30 seconds, SHA-1.

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

    # Alerts owed to Telegram but not yet delivered. Non-zero while Telegram is
    # merely slow is fine; growing while the fleet is quiet means delivery is
    # failing and the background loop's log says why.
    backlog = db.outbox_backlog()
    if backlog:
        print(f"\n{backlog} alert(s) queued for Telegram delivery (outbox backlog).")
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

    Stop rs-coordinator first: its update consumer holds the bot's one global
    getUpdates cursor, so two pollers steal each other's updates (and Telegram
    409s concurrent polls).
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
                value = normalize_totp_secret(str(value))
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
            secrets[field] = normalize_totp_secret(entered) if field == "totp_secret" else entered

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
        fb_uid=args.fb_uid,
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
            code, remaining = totp_code(secrets["totp_secret"])
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
            f"fb uid: {account.get('fb_uid') or '-'}    "
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
    code, remaining = totp_code(str(secret))
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


def cmd_identity_list(args: argparse.Namespace) -> int:
    profiles = open_database().list_device_profiles()
    if not profiles:
        print("No device profiles yet. A worker creates its account's on its first login.")
        return 0
    print(f"{len(profiles)} device profile(s):")
    for p in profiles:
        print(
            f"\n{p['identity_key']}  device {p['device_id']}  ({p.get('source') or '-'}, "
            f"since {p.get('created_at') or '-'})"
        )
        print(
            f"  screen {p['screen_w']}x{p['screen_h']}  viewport {p['viewport_w']}x"
            f"{p['viewport_h']}  scale {p['device_scale_factor']}  {p['locale']}  "
            f"{p['timezone_id']}  device cookies: {'SET' if p['has_device_cookies'] else '-'}"
        )
        print(f"  user agent: {p.get('user_agent') or '(the browser’s own)'}")
    return 0


@_guarded
def cmd_identity_learn_uids(args: argparse.Namespace) -> int:
    """Fill in the uid of accounts that predate it, from their slot's session.

    Only for the migration. The uid picks an account's device, so each row
    printed here is a claim — "this slot's session is this account's login" —
    for an operator to check against the ERP's pool before `--apply`.
    """
    from .routers.session import fb_user_id_of

    store = _account_store()
    candidates = []
    for account in store.list_accounts():
        if account.get("fb_uid") or not account.get("worker_id"):
            continue
        snapshot = store.db.get_snapshot(account["worker_id"])
        if not snapshot or snapshot.get("state_blob") is None:
            continue
        uid = snapshot.get("fb_user_id") or fb_user_id_of(
            store.vault.decrypt(snapshot["state_blob"])
        )
        if uid:
            candidates.append((account, uid, snapshot.get("backed_up_at")))
    if not candidates:
        print("Every account with a backed-up session already has a uid.")
        return 0
    for account, uid, backed_up_at in candidates:
        print(
            f"{account['account_id']:<20} worker {account['worker_id']:<12} "
            f"login {account.get('fb_username') or '-':<32} session uid {uid} "
            f"(backed up {backed_up_at or '-'})"
        )
    if not args.apply:
        print("\nNothing written. Check each uid against the ERP's pool, then rerun with --apply.")
        return 0
    for account, uid, _ in candidates:
        store.db.put_account(account["account_id"], {"fb_uid": uid})
    print(f"\nwrote the uid of {len(candidates)} account(s)")
    return 0


# -- fleet ------------------------------------------------------------------


def _fleet_db():
    return open_database()


def cmd_fleet_hosts(args: argparse.Namespace) -> int:
    from . import fleet

    db = _fleet_db()
    hosts = db.list_fleet_hosts()
    if not hosts:
        print("No hosts. A host appears here the first time its rs-fleetd agent asks.")
        return 0
    load: Dict[str, int] = {}
    for a in db.list_assignments():
        if a["state"] == fleet.RUN:
            load[a["host_id"]] = load.get(a["host_id"], 0) + 1
    now = fleet._moment(None)
    for h in hosts:
        print(
            f"{h['host_id']:<16} {'live' if fleet.host_live(h, now) else 'SILENT':<6} "
            f"workers {load.get(h['host_id'], 0)}/{h['capacity']:<3} "
            f"{'authoritative' if h['authoritative'] else 'observe-only':<13} "
            f"{'CORDONED ' if h['cordoned'] else ''}agent {h.get('agent_version') or '-'}  "
            f"seen {h.get('last_seen_at') or 'never'}  vnc {h.get('vnc_host') or 'rs-fleet network'}"
        )
    return 0


def cmd_fleet_host(args: argparse.Namespace) -> int:
    fields: Dict[str, Any] = {}
    if args.capacity is not None:
        fields["capacity"] = args.capacity
    if args.cordon is not None:
        fields["cordoned"] = 1 if args.cordon else 0
    if args.authoritative is not None:
        fields["authoritative"] = 1 if args.authoritative else 0
    if args.vnc_host is not None:
        fields["vnc_host"] = args.vnc_host or None
    db = _fleet_db()
    db.upsert_fleet_host(args.host, fields)
    print(json.dumps({k: v for k, v in (db.get_fleet_host(args.host) or {}).items() if k != "report_json"}, indent=2))
    return 0


def cmd_fleet_state(args: argparse.Namespace) -> int:
    from . import fleet

    db = _fleet_db()
    workers = {w["worker_id"]: w for w in db.list_workers()}
    configs = {c["worker_id"] for c in db.list_worker_configs()}
    print(f"image for new workers: {fleet.fleet_image(db) or '(none — run `rsc fleet release`)'}")
    for a in db.list_assignments():
        w = workers.get(a["worker_id"]) or {}
        move = f" -> {a['move_to_host']} (pending)" if a.get("move_to_host") else ""
        print(
            f"{a['worker_id']:<12} {a['state']:<8} {a['host_id']}{move:<14} {a['image']:<28} "
            f"gen {a['generation']:<3} runs {w.get('version') or '-'} {w.get('state') or ''}"
        )
    for account in db.list_accounts():
        wid = account.get("worker_id")
        if wid and not db.get_assignment(wid):
            why = []
            if not account.get("fleet_enabled"):
                why.append("fleet off")
            if wid not in configs:
                why.append("no config")
            print(f"{wid:<12} {'unplaced':<8} ({', '.join(why) or 'no live host with room, or no image yet'})")
    release = fleet.active_release(db) or next(iter(db.list_releases(limit=1)), None)
    if release:
        print(
            f"\nrelease {release['id']}: {release['version']} {release['state']} "
            f"current {release.get('current_worker') or '-'} upgraded {release.get('upgraded_json') or '[]'} "
            f"skipped {release.get('skipped_json') or '[]'}"
        )
        if release.get("failure"):
            print(f"  failure: {release['failure']}")
    return 0


def _slot_account(db: Any, worker_id: str) -> Optional[Dict[str, Any]]:
    account = db.account_row_for_worker(worker_id)
    if account is None:
        print(f"error: no vault account names worker '{worker_id}'", file=sys.stderr)
    return account


def cmd_fleet_enable(args: argparse.Namespace) -> int:
    db = _fleet_db()
    account = _slot_account(db, args.worker)
    if account is None:
        return 1
    fields: Dict[str, Any] = {"fleet_enabled": 0 if args.disable else 1}
    if args.pin_host is not None:
        fields["pin_host"] = args.pin_host or None
    db.put_account(account["account_id"], fields)
    print(f"fleet {'off' if args.disable else 'on'} for {args.worker}"
          + (f", pinned to {args.pin_host}" if args.pin_host else ""))
    return 0


def cmd_fleet_config(args: argparse.Namespace) -> int:
    import hashlib
    import tomllib

    db = _fleet_db()
    if args.config_command == "get":
        config = db.get_worker_config(args.worker)
        if config is None:
            print(f"error: no config is published for {args.worker}", file=sys.stderr)
            return 1
        sys.stdout.write(config["toml"])
        return 0
    text = Path(args.file).read_text(encoding="utf-8")
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        print(f"error: {args.file} is not valid TOML: {e}", file=sys.stderr)
        return 1
    sha = hashlib.sha256(text.encode()).hexdigest()
    db.put_worker_config(args.worker, text, sha, "rsc")
    print(f"published the config of {args.worker} ({sha[:12]})")
    return 0


def cmd_fleet_release(args: argparse.Namespace) -> int:
    from . import fleet

    db = _fleet_db()
    image = args.image or f"aimm-recycle:{args.version}"
    release_id = fleet.start_release(db, args.version, image, getpass.getuser())
    print(f"release {release_id}: rolling {image} one worker at a time; watch `rsc fleet state`")
    return 0


def cmd_fleet_release_action(args: argparse.Namespace) -> int:
    from . import fleet

    db = _fleet_db()
    release = db.get_release(args.id) if args.id else fleet.active_release(db)
    if release is None:
        print("error: no active release", file=sys.stderr)
        return 1
    target = {"pause": fleet.PAUSED, "resume": fleet.ROLLING, "abort": fleet.ABORTED}[args.fleet_command]
    fields: Dict[str, Any] = {"state": target}
    if target == fleet.ABORTED:
        fields["finished_at"] = fleet.utcnow()
    db.update_release(int(release["id"]), fields)
    print(f"release {release['id']} is {target}")
    return 0


def cmd_fleet_move(args: argparse.Namespace) -> int:
    from . import fleet

    try:
        moved = fleet.move_worker(_fleet_db(), args.worker, args.host, args.force)
    except KeyError:
        print(f"error: {args.worker} has no assignment", file=sys.stderr)
        return 1
    except LookupError:
        print(f"error: no host '{args.host}'", file=sys.stderr)
        return 1
    if moved.get("move_to_host"):
        print(f"{args.worker} moves to {args.host} once {moved['host_id']} reports its container gone")
    else:
        print(f"{args.worker} is now assigned to {moved['host_id']}")
    return 0


def cmd_fleet_restart(args: argparse.Namespace) -> int:
    db = _fleet_db()
    assignment = db.get_assignment(args.worker)
    if assignment is None:
        print(f"error: {args.worker} has no assignment", file=sys.stderr)
        return 1
    db.put_assignment(args.worker, {"generation": int(assignment["generation"]) + 1})
    print(f"{args.worker} is recreated on {assignment['host_id']} at its agent's next pass")
    return 0


@_guarded
def cmd_mint_host_token(args: argparse.Namespace) -> int:
    print(mint_host_token(args.host))
    print(
        f"\nPut this in host '{args.host}''s secrets.env as RS_HOST_TOKEN, with "
        f"RS_HOST_ID={args.host}. It lets that host's rs-fleetd read its own desired "
        "state and its workers' configs, nothing else.",
        file=sys.stderr,
    )
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


def cmd_msg_threads(args: argparse.Namespace) -> int:
    from .db import open_database

    db = open_database()
    threads = db.list_threads(limit=args.limit)
    if not threads:
        print("No Messenger threads have been reported yet.")
        return 0
    print(f"{'THREAD':<20} {'FROM':<24} {'LAST MESSAGE':<26} FLAGS")
    for row in threads:
        flags = []
        if row.get("human_claimed"):
            flags.append("claimed")
        if row.get("autoreplied_at"):
            flags.append("auto-replied")
        print(
            f"{str(row['thread_id']):<20} {str(row.get('counterpart') or '-'):<24} "
            f"{str(row.get('last_message_at') or '-'):<26} {', '.join(flags) or '-'}"
        )
        if row.get("listing_title"):
            print(f"    re: {row['listing_title']}")
    return 0


def cmd_msg_show(args: argparse.Namespace) -> int:
    from .db import open_database

    db = open_database()
    if db.get_thread(args.thread_id) is None:
        print(f"error: no thread {args.thread_id}", file=sys.stderr)
        return 1
    for message in db.list_messages(args.thread_id):
        arrow = "<-" if message["direction"] == "in" else "->"
        stamp = message.get("sent_at") or message.get("created_at") or ""
        print(f"{arrow} [{stamp}] {message.get('sender') or ''}: {message.get('text') or ''}")
    return 0


def cmd_msg_reply(args: argparse.Namespace) -> int:
    from .db import open_database

    db = open_database()
    row = db.get_thread(args.thread_id)
    if row is None:
        print(f"error: no thread {args.thread_id}", file=sys.stderr)
        return 1
    if not args.text.strip():
        print("error: reply text is empty", file=sys.stderr)
        return 1
    transport = getattr(args, "via", "matrix")
    # A matrix reply is claimed by transport, not worker id, so leave worker_id
    # NULL for any router to pick up; a playwright reply targets the specific
    # scraper worker that owns the thread.
    worker_id = None if transport == "matrix" else row.get("worker_id")
    outbound_id = db.enqueue_outbound(
        args.thread_id, worker_id, args.text.strip(), "operator", transport=transport
    )
    # Replying claims the thread: the human is in the conversation now, so the
    # auto-reply policy must stay out of it.
    db.set_thread_fields(args.thread_id, {"human_claimed": 1})
    carrier = "the router" if transport == "matrix" else (
        f"worker {row.get('worker_id') or '(unassigned)'}"
    )
    print(f"queued reply {outbound_id} via {transport}; {carrier} sends it on its next poll")
    return 0


def cmd_msg_claim(args: argparse.Namespace) -> int:
    from .db import open_database

    db = open_database()
    if db.get_thread(args.thread_id) is None:
        print(f"error: no thread {args.thread_id}", file=sys.stderr)
        return 1
    db.set_thread_fields(args.thread_id, {"human_claimed": 1})
    print("claimed; auto-reply will not touch this thread")
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
    v_set.add_argument(
        "--fb-uid",
        help="Facebook uid of that login: picks the device profile its worker presents",
    )
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

    identity = sub.add_parser("identity", help="Device profiles: one browser per account")
    identity_sub = identity.add_subparsers(dest="identity_command", required=True)
    i_list = identity_sub.add_parser("list", help="List device profiles")
    i_list.set_defaults(func=cmd_identity_list)
    i_learn = identity_sub.add_parser(
        "learn-uids", help="Fill in missing account uids from each slot's backed-up session"
    )
    i_learn.add_argument("--apply", action="store_true", help="Write them (default: print)")
    i_learn.set_defaults(func=cmd_identity_learn_uids)

    fleet_p = sub.add_parser("fleet", help="Hosts, slots, configs and rolling releases")
    fleet_sub = fleet_p.add_subparsers(dest="fleet_command", required=True)
    f_hosts = fleet_sub.add_parser("hosts", help="List hosts and their load")
    f_hosts.set_defaults(func=cmd_fleet_hosts)
    f_host = fleet_sub.add_parser("host", help="Set a host's capacity, trust or VNC address")
    f_host.add_argument("host")
    f_host.add_argument("--capacity", type=int)
    f_host.add_argument("--cordon", dest="cordon", action="store_const", const=True, default=None)
    f_host.add_argument("--uncordon", dest="cordon", action="store_const", const=False)
    f_host.add_argument("--authoritative", dest="authoritative", action="store_const", const=True, default=None,
                        help="Let the agent apply its plan (default: observe-only)")
    f_host.add_argument("--observe", dest="authoritative", action="store_const", const=False)
    f_host.add_argument("--vnc-host", help="Where the console reaches this host's VNC ports ('' = rs-fleet network)")
    f_host.set_defaults(func=cmd_fleet_host)
    f_state = fleet_sub.add_parser("state", help="Where every worker runs, and the release")
    f_state.set_defaults(func=cmd_fleet_state)
    f_enable = fleet_sub.add_parser("enable", help="Run a worker for this slot")
    f_enable.add_argument("--worker", required=True)
    f_enable.add_argument("--pin-host", help="Only ever run it on this host ('' to unpin)")
    f_enable.set_defaults(func=cmd_fleet_enable, disable=False)
    f_disable = fleet_sub.add_parser("disable", help="Stop this slot's worker (its /data is kept)")
    f_disable.add_argument("--worker", required=True)
    f_disable.set_defaults(func=cmd_fleet_enable, disable=True, pin_host=None)
    f_config = fleet_sub.add_parser("config", help="A worker's published config")
    config_sub = f_config.add_subparsers(dest="config_command", required=True)
    c_put = config_sub.add_parser("put", help="Publish a config file for a worker")
    c_put.add_argument("--worker", required=True)
    c_put.add_argument("--file", required=True)
    c_put.set_defaults(func=cmd_fleet_config)
    c_get = config_sub.add_parser("get", help="Print a worker's published config")
    c_get.add_argument("--worker", required=True)
    c_get.set_defaults(func=cmd_fleet_config)
    f_release = fleet_sub.add_parser("release", help="Roll a version out, one worker at a time")
    f_release.add_argument("version")
    f_release.add_argument("--image", help="default: aimm-recycle:<version>")
    f_release.set_defaults(func=cmd_fleet_release)
    for name, text in (("pause", "Pause the rollout"), ("resume", "Resume it"), ("abort", "Stop it for good")):
        f_action = fleet_sub.add_parser(name, help=text)
        f_action.add_argument("--id", type=int, help="default: the active release")
        f_action.set_defaults(func=cmd_fleet_release_action)
    f_move = fleet_sub.add_parser("move", help="Move a worker to another host")
    f_move.add_argument("--worker", required=True)
    f_move.add_argument("--host", required=True)
    f_move.add_argument("--force", action="store_true",
                        help="Do not wait for the old host: only when it is dead")
    f_move.set_defaults(func=cmd_fleet_move)
    f_restart = fleet_sub.add_parser("restart", help="Recreate a worker's container")
    f_restart.add_argument("--worker", required=True)
    f_restart.set_defaults(func=cmd_fleet_restart)

    host_token = sub.add_parser("mint-host-token", help="Print a host agent's bearer token")
    host_token.add_argument("--host", required=True)
    host_token.set_defaults(func=cmd_mint_host_token)

    token = sub.add_parser("mint-token", help="Print a worker's bearer token")
    token.add_argument("--worker", required=True, help="Worker id the token authenticates")
    token.set_defaults(func=cmd_mint_token)

    msg = sub.add_parser("msg", help="Messenger threads: list, read, reply, claim")
    msg_sub = msg.add_subparsers(dest="msg_command", required=True)

    m_threads = msg_sub.add_parser("threads", help="List Messenger threads, newest first")
    m_threads.add_argument("--limit", type=int, default=25)
    m_threads.set_defaults(func=cmd_msg_threads)

    m_show = msg_sub.add_parser("show", help="Print one thread's messages")
    m_show.add_argument("thread_id")
    m_show.set_defaults(func=cmd_msg_show)

    m_reply = msg_sub.add_parser(
        "reply", help="Queue a reply; the thread's worker sends it on its next poll"
    )
    m_reply.add_argument("thread_id")
    m_reply.add_argument("text")
    m_reply.add_argument(
        "--via",
        choices=("matrix", "playwright"),
        default="matrix",
        help="Which bridge sends the reply: matrix (mautrix-meta, the default) "
        "or playwright (the legacy scraper, the fallback when the bridge is down)",
    )
    m_reply.set_defaults(func=cmd_msg_reply)

    m_claim = msg_sub.add_parser(
        "claim", help="Mark a thread human-handled so auto-reply never touches it"
    )
    m_claim.add_argument("thread_id")
    m_claim.set_defaults(func=cmd_msg_claim)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
