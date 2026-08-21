"""Verification codes scraped out of an account's own inbox.

Facebook falls back to email whenever an account has no authenticator app, and
it also mails a code when it challenges a login it does not like. The control
plane already holds the mailbox credentials for every account, so it can read
that code itself and hand it to the worker: no human, no phone, no pause in the
run. This is the second of the two auto-resolving paths in the design (the
other is `totp_code`).

Two constraints shape the implementation:

* **Stdlib only.** `imaplib` + `email` do the whole job, and a code path that
  handles account passwords is the last place to want a new dependency.
* **Never replay an old code.** A mailbox usually holds the *previous*
  challenge's code too, and it parses exactly as well as today's. Callers pass
  `since` (the moment the challenge was raised) and anything older than it is
  ignored, even if that means reporting "nothing yet" and being retried.

The IMAP client is reached through the module-level `_connect`, and the parsing
is in pure helpers (`extract_code`, `message_is_recent`), so tests exercise the
real logic against a fake mailbox instead of a live server.
"""

import imaplib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parsedate_to_datetime
from html import unescape
from typing import Any, Dict, List, Optional, Tuple

from . import deps
from .code_service import CodeUnavailable

# How long we promise the returned code stays usable. Facebook's email codes
# actually live for tens of minutes, but a *worker* only ever wants one it is
# about to type: five minutes is long enough to survive a slow page load and
# short enough that a stalled worker asks again rather than replaying a code
# that a later challenge has already superseded.
CODE_TTL_SECONDS = 300

# IMAP SEARCH has day granularity, so this is a coarse "don't drag the whole
# mailbox over the wire" bound, not the freshness check — `since` does that.
SEARCH_WINDOW_HOURS = 24

# Newest-first scanning depth. A challenge mail is always among the last few;
# fetching more just means downloading unrelated Facebook marketing mail.
MAX_MESSAGES_TO_SCAN = 10

DEFAULT_IMAP_PORT = 993

_FIX_IT = (
    "Store them with `rsc vault set-account <account> --email <address> "
    "--email-password <password> [--imap-host <host>]`."
)

# Hosts we can infer from the address, so the common cases need no extra
# config. Anything else must be given explicitly — guessing `imap.<domain>` is
# wrong often enough that a clear error beats a silent connection failure.
IMAP_HOSTS_BY_DOMAIN = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "hotmail.co.uk": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "msn.com": "outlook.office365.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "aol.com": "imap.aol.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "fastmail.com": "imap.fastmail.com",
    "zoho.com": "imap.zoho.com",
}

# Month names for IMAP's dd-Mon-yyyy date format. Hand-rolled because
# strftime("%b") follows the process locale and IMAP does not.
_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

# Facebook's codes are six digits; the older "FB-12345" form is five. The
# upper bound keeps a stray order number or year out of the match.
_DIGITS = r"\d{5,8}"

# Tried in order, most specific first, against the subject and then the body.
# Facebook has shipped all of these wordings and localised variants of them, so
# the list is deliberately ordered from "unmistakably a code" to "a number that
# is described as a code".
_CODE_PATTERNS: Tuple[re.Pattern, ...] = (
    # "FB-12345" — the legacy short form, unambiguous wherever it appears.
    re.compile(rf"\bFB-({_DIGITS})\b", re.IGNORECASE),
    # "123456 is your Facebook code" / "... your Facebook confirmation code"
    re.compile(rf"\b({_DIGITS})\b\s+is\s+your\s+(?:facebook|fb)\b", re.IGNORECASE),
    # "Your Facebook confirmation code is 123456" / "Facebook code: 123456"
    re.compile(rf"(?:facebook|fb)\b[^\d\n\r]{{0,60}}?\bcode\b[^\d]{{0,20}}?({_DIGITS})\b",
               re.IGNORECASE),
    # "123456 is your login code" / "123456 is your code"
    re.compile(rf"\b({_DIGITS})\b\s+is\s+your\b[^\d\n\r]{{0,30}}\bcode\b", re.IGNORECASE),
    # "Your confirmation code is 123456" / "Login code: 123456"
    re.compile(rf"\bcode\b[^\d]{{0,20}}?({_DIGITS})\b", re.IGNORECASE),
)

# A message only counts as Facebook's if it says so in the From or Subject.
# The server-side SEARCH already filters on sender, but the fallback search
# does not, and the generic patterns above are loose enough that some unrelated
# service's "your code is 123456" must never be handed to a worker.
_FACEBOOK_MARKER = re.compile(r"\b(?:facebook|facebookmail|fb)\b", re.IGNORECASE)

_HTML_DROP = re.compile(r"(?is)<(script|style)\b.*?</\1>")
_HTML_BREAK = re.compile(r"(?i)<(?:br\s*/?|/p|/div|/tr|/td)\s*>")
_HTML_TAG = re.compile(r"<[^>]+>")

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


@dataclass(frozen=True)
class MailboxConfig:
    """Everything needed to open one account's inbox."""

    address: str
    password: str
    host: str
    port: int


# -- configuration ---------------------------------------------------------


def imap_host_for(address: str) -> Optional[str]:
    """The well-known IMAP host for an address's domain, if we know one."""
    _, _, domain = address.rpartition("@")
    return IMAP_HOSTS_BY_DOMAIN.get(domain.strip().lower())


def mailbox_config(account_id: str) -> MailboxConfig:
    """Read the account's mailbox settings out of the vault.

    Raises CodeUnavailable naming the CLI when the account was set up without
    email credentials — that is a configuration gap an operator fixes, not a
    condition a worker should keep retrying blindly, but it reaches the worker
    as a plain "no code" so a single misconfigured account cannot 500 the
    control plane.
    """
    secrets: Dict[str, Any] = deps.get_account_store().get_secret(account_id)

    address = str(secrets.get("email") or "").strip()
    password = str(secrets.get("email_password") or "")
    if not address or not password:
        raise CodeUnavailable(
            f"Account '{account_id}' has no email login stored, so its inbox cannot be "
            f"read for a verification code. {_FIX_IT}"
        )

    host = str(secrets.get("imap_host") or "").strip() or imap_host_for(address)
    if not host:
        _, _, domain = address.rpartition("@")
        raise CodeUnavailable(
            f"No IMAP host is known for '{domain}' (account '{account_id}'). {_FIX_IT}"
        )

    raw_port = secrets.get("imap_port") or DEFAULT_IMAP_PORT
    try:
        port = int(raw_port)
    except (TypeError, ValueError) as e:
        raise CodeUnavailable(
            f"Account '{account_id}' has a non-numeric imap_port stored ({raw_port!r}). "
            f"{_FIX_IT}"
        ) from e

    return MailboxConfig(address=address, password=password, host=host, port=port)


# -- parsing helpers (pure) ------------------------------------------------


def _decode_header(raw: Optional[str]) -> str:
    """Header text with any RFC 2047 encoded words expanded."""
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw)))
    except (UnicodeDecodeError, LookupError, ValueError):
        # A malformed header must not sink the whole scan; the body usually
        # carries the code too.
        return raw


def _html_to_text(html: str) -> str:
    text = _HTML_DROP.sub(" ", html)
    text = _HTML_BREAK.sub("\n", text)
    text = _HTML_TAG.sub(" ", text)
    return unescape(text)


def _part_text(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        text = payload.decode(charset, errors="replace")
    except LookupError:
        text = payload.decode("utf-8", errors="replace")
    return _html_to_text(text) if part.get_content_subtype() == "html" else text


def message_body(msg: Message) -> str:
    """The message's readable text, plain parts first, HTML flattened.

    `get_payload(decode=True)` unwinds quoted-printable and base64, which
    Facebook uses for both; the charset comes from the part, not a guess.
    """
    if not msg.is_multipart():
        return _part_text(msg)

    plain: List[str] = []
    html: List[str] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        if (part.get_content_disposition() or "") == "attachment":
            continue
        if part.get_content_maintype() != "text":
            continue
        (html if part.get_content_subtype() == "html" else plain).append(_part_text(part))
    return "\n".join(plain + html)


def extract_code(subject: str, body: str) -> Optional[str]:
    """The verification code in a message, or None.

    The subject is searched first and completely: when Facebook puts the code
    in the subject line it is the code for *this* mail, whereas a body can also
    quote an earlier one or explain the feature in general.
    """
    for text in (_normalise(subject), _normalise(body)):
        if not text:
            continue
        for pattern in _CODE_PATTERNS:
            match = pattern.search(text)
            if match:
                return match.group(1)
    return None


def _normalise(text: str) -> str:
    """Collapse the whitespace HTML mail is full of, keeping line breaks."""
    if not text:
        return ""
    # HTML mail is full of non-breaking and zero-width spaces, and they land
    # right between the digits often enough to matter.
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n{2,}", "\n", text)


def message_date(msg: Message) -> Optional[datetime]:
    """The message's Date header as an aware UTC datetime, or None."""
    raw = msg.get("Date")
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    # A Date without a zone is rare but legal; UTC is the only sane reading
    # here, and it is also the conservative one (it makes the mail look older).
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def message_is_recent(msg: Message, since: str | datetime | None) -> bool:
    """True when the message is at least as new as `since`.

    With no `since` every message qualifies. With one, a message we cannot date
    is rejected: the entire point of `since` is to refuse codes that might
    belong to a previous challenge, so "unknown age" has to count as too old.
    """
    if since is None:
        return True
    cutoff = _as_datetime(since)
    if cutoff is None:
        return True
    sent = message_date(msg)
    if sent is None:
        return False
    return sent >= cutoff


def _as_datetime(value: str | datetime | None) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            # An unparseable `since` must not become "accept everything", but
            # it is the caller's bug, not the mailbox's — surface it plainly.
            raise CodeUnavailable(f"'since' is not an ISO timestamp: {value!r}") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def looks_like_facebook(msg: Message) -> bool:
    sender = _decode_header(msg.get("From"))
    subject = _decode_header(msg.get("Subject"))
    return bool(_FACEBOOK_MARKER.search(f"{sender} {subject}"))


# -- IMAP ------------------------------------------------------------------


def _connect(host: str, port: int, user: str, password: str) -> Any:
    """Open and authenticate an IMAP connection. Monkeypatched in tests."""
    client = imaplib.IMAP4_SSL(host, port)
    client.login(user, password)
    return client


def _imap_date(when: datetime) -> str:
    return f"{when.day:02d}-{_MONTHS[when.month - 1]}-{when.year}"


def _open(config: MailboxConfig, account_id: str) -> Any:
    """Connect, translating every failure mode into something actionable.

    An `imaplib` traceback would carry the mailbox address and the server's raw
    response into the logs; a wrong password is also not something a worker
    should retry forever, so it is separated from the transient failures. The
    password itself never appears in any of these messages.
    """
    try:
        return _connect(config.host, config.port, config.address, config.password)
    except imaplib.IMAP4.abort as e:
        raise CodeUnavailable(
            f"IMAP connection to {config.host}:{config.port} was dropped while "
            f"connecting: {e}"
        ) from e
    except imaplib.IMAP4.error as e:
        raise RuntimeError(
            f"IMAP login was rejected for account '{account_id}' at "
            f"{config.host}:{config.port}. Check the stored email login (most providers "
            f"need an app password, not the account password). Server said: {e}"
        ) from e
    except OSError as e:
        raise CodeUnavailable(
            f"Could not reach IMAP host {config.host}:{config.port}: {e}"
        ) from e


def _logout(client: Any) -> None:
    """Best-effort close — a failure here must not mask a code we already have."""
    try:
        client.logout()
    except Exception:  # noqa: BLE001 - nothing useful to do with a logout failure
        pass


def _ids_from(data: Any) -> List[bytes]:
    if not data:
        return []
    head = data[0]
    if isinstance(head, str):
        head = head.encode()
    return head.split() if head else []


def _search(client: Any, window_start: datetime) -> List[bytes]:
    """Message ids worth fetching, newest last.

    The sender filter is done server-side first. Some providers rewrite or
    localise the From display name, so an empty result falls back to "everything
    in the window" — `looks_like_facebook` then re-applies the filter locally.
    """
    window = _imap_date(window_start)
    for criteria in (f'(FROM "facebook" SINCE {window})', f"(SINCE {window})"):
        status, data = client.search(None, criteria)
        if status != "OK":
            continue
        ids = _ids_from(data)
        if ids:
            return ids
    return []


def _raw_message(payload: Any) -> Optional[bytes]:
    """Pull the RFC822 bytes out of one FETCH response item."""
    if not payload:
        return None
    for item in payload:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
            return bytes(item[1])
    return None


def _collect_codes(client: Any, since: Optional[datetime]) -> List[Tuple[datetime, str]]:
    """(sent_at, code) for every message in the window that carries one."""
    # readonly=True (EXAMINE, not SELECT): a plain FETCH of RFC822 would set
    # \Seen, and these mailboxes are also read by people — the control plane
    # must leave no trace in one.
    status, _ = client.select("INBOX", readonly=True)
    if status != "OK":
        raise CodeUnavailable("The mailbox has no INBOX to read.")

    window_start = (since or datetime.now(timezone.utc) - timedelta(hours=SEARCH_WINDOW_HOURS))
    ids = _search(client, window_start)

    found: List[Tuple[datetime, str]] = []
    for msg_id in ids[-MAX_MESSAGES_TO_SCAN:]:
        status, payload = client.fetch(msg_id, "(RFC822)")
        if status != "OK":
            continue
        raw = _raw_message(payload)
        if raw is None:
            continue
        msg = message_from_bytes(raw)
        if not looks_like_facebook(msg):
            continue
        if not message_is_recent(msg, since):
            continue
        code = extract_code(_decode_header(msg.get("Subject")), message_body(msg))
        if code:
            found.append((message_date(msg) or _EPOCH, code))
    return found


def latest_code(account_id: str, since: str | None = None) -> Tuple[str, int]:
    """Return (code, seconds_it_stays_valid) from the account's inbox.

    `since` is an ISO timestamp — normally the moment the challenge was raised.
    Messages older than it are ignored, so the code of a previous challenge is
    never handed out a second time.

    Raises CodeUnavailable when the mailbox has nothing yet (the caller should
    retry — Facebook's mail often lands seconds after the prompt), when the
    account has no email credentials, or when IMAP is unreachable. A rejected
    login raises RuntimeError instead: retrying will not fix it.
    """
    config = mailbox_config(account_id)
    cutoff = _as_datetime(since)

    client = _open(config, account_id)
    try:
        found = _collect_codes(client, cutoff)
    except (imaplib.IMAP4.abort, OSError) as e:
        raise CodeUnavailable(f"IMAP session to {config.host} failed: {e}") from e
    except imaplib.IMAP4.error as e:
        raise CodeUnavailable(f"Could not read the inbox on {config.host}: {e}") from e
    finally:
        _logout(client)

    if not found:
        when = f" newer than {since}" if since else ""
        raise CodeUnavailable(
            f"No Facebook verification code{when} in the inbox for account "
            f"'{account_id}'. Facebook's mail can take a few seconds — retry."
        )

    # Stable sort: equal Date headers keep IMAP order, whose last entry is the
    # most recently delivered message.
    found.sort(key=lambda item: item[0])
    return found[-1][1], CODE_TTL_SECONDS
