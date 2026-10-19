"""Pure logic behind the escalation queue.

When a worker meets something it cannot solve on its own — a CAPTCHA, a hard
checkpoint — it stops guessing and hands the problem to a human. Everything in
here supports that hand-off: storing the evidence (a screenshot), finding the
one-click way in (the VNC URL), and phrasing the ops alert.

Kept apart from the router so the formatting and decoding rules are testable
without an HTTP client, and so a malformed payload fails as a clear error
rather than a traceback in the request path.
"""

import base64
import binascii
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .db import default_db_path
from .telegram_notify import escape_markdown

logger = logging.getLogger(__name__)

ENV_SCREENSHOT_DIR = "RS_SCREENSHOT_DIR"
# Beside the database file, never relative to the working directory: a bare
# `data/screenshots` once resolved to the image's /app, outside the /data
# volume, and every redeploy threw the screenshots away.
DEFAULT_SCREENSHOT_SUBDIR = "screenshots"

# A full-page PNG from a 1080p headless browser is well under a megabyte; the
# cap is generous but still small enough that a buggy (or hostile) worker
# cannot fill the control plane's disk with one request.
MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
# Base64 costs 4 characters per 3 bytes. Checking the encoded length first
# means an oversized payload is refused before it is expanded in memory.
MAX_SCREENSHOT_B64_CHARS = (MAX_SCREENSHOT_BYTES // 3 + 1) * 4

# How much of `detail` to put in the Telegram message. The alert is a nudge to
# open the console, not the whole record.
ALERT_DETAIL_ITEMS = 4
ALERT_DETAIL_VALUE_CHARS = 120


class ScreenshotError(ValueError):
    """A screenshot payload that cannot be stored, with a reason to report.

    Carries an operator-readable message because it is turned straight into a
    400 for the worker that sent the bad payload.
    """


def screenshot_dir() -> Path:
    """The directory challenge screenshots are written to, created on demand.

    The environment is read on every call rather than at import time so tests
    (and a redeployed process) can point it somewhere else without a reimport.
    """
    env = os.environ.get(ENV_SCREENSHOT_DIR)
    if env:
        path = Path(env)
    else:
        path = Path(default_db_path()).resolve().parent / DEFAULT_SCREENSHOT_SUBDIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _strip_data_url(raw: str) -> str:
    """Drop a `data:image/png;base64,` prefix if the worker sent one.

    Browser-side capture APIs hand back a data URL, and making every worker
    remember to slice it off is a bug waiting to happen.
    """
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1]
    return raw


def decode_screenshot(screenshot_b64: str | None) -> Optional[bytes]:
    """Validate and decode a base64 screenshot, or None when there is none.

    Raises ScreenshotError (never a bare binascii traceback) so the caller can
    answer with a 400 that says what was wrong.
    """
    if not screenshot_b64:
        return None

    payload = _strip_data_url(screenshot_b64.strip())
    # Workers and HTTP clients wrap long base64; validate=True would reject the
    # newlines, so normalise before checking.
    payload = "".join(payload.split())
    if not payload:
        return None
    if len(payload) > MAX_SCREENSHOT_B64_CHARS:
        raise ScreenshotError(
            f"Screenshot is too large: {len(payload)} base64 characters exceeds the "
            f"{MAX_SCREENSHOT_BYTES // (1024 * 1024)} MB limit."
        )

    try:
        blob = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ScreenshotError(f"screenshot_b64 is not valid base64: {e}") from e

    if not blob:
        raise ScreenshotError("screenshot_b64 decoded to zero bytes.")
    if len(blob) > MAX_SCREENSHOT_BYTES:
        raise ScreenshotError(
            f"Screenshot is too large: {len(blob)} bytes exceeds the "
            f"{MAX_SCREENSHOT_BYTES // (1024 * 1024)} MB limit."
        )
    return blob


def save_screenshot(challenge_id: int, screenshot_b64: str | bytes | None) -> Optional[str]:
    """Write the challenge's screenshot to `<screenshot_dir>/<id>.png`.

    Returns the path written, or None when the worker sent no screenshot.
    Already-decoded bytes are accepted as well as base64 text: the router
    validates the payload before it inserts a row (so a bad payload leaves no
    orphan challenge behind) and then passes the bytes straight through instead
    of decoding the same megabytes twice.
    """
    blob = screenshot_b64 if isinstance(screenshot_b64, bytes) else decode_screenshot(screenshot_b64)
    if not blob:
        return None
    path = (screenshot_dir() / f"{int(challenge_id)}.png").resolve()
    path.write_bytes(blob)
    return str(path)


def screenshot_on_disk(path: str | None) -> bool:
    """Whether a stored screenshot path still points at a file.

    A row can outlive its file (a redeploy before the directory sat on the
    volume), and a link that 404s is worse for the operator than no link.
    """
    return bool(path) and Path(path).is_file()


def resolve_vnc_url(
    worker_row: Dict[str, Any] | None, account_row: Dict[str, Any] | None
) -> Optional[str]:
    """The URL an operator opens to drive the stuck browser by hand.

    The worker row wins: it is refreshed on every heartbeat, so it reflects
    where the browser is running right now, while the account row holds the
    statically configured fallback.
    """
    for row in (worker_row, account_row):
        if not row:
            continue
        url = row.get("vnc_url")
        if url:
            return str(url)
    return None


def _escape_link_target(url: str) -> str:
    """Escape a URL for the `(...)` half of a MarkdownV2 inline link.

    Telegram only requires ')' and '\\' to be escaped there — escaping the rest
    would corrupt the link.
    """
    return url.replace("\\", "\\\\").replace(")", "\\)")


def _detail_lines(detail: Any) -> list[str]:
    """A short, escaped rendering of the worker's `detail` payload."""
    if not detail:
        return []
    if not isinstance(detail, dict):
        return [escape_markdown(str(detail)[:ALERT_DETAIL_VALUE_CHARS])]

    lines: list[str] = []
    for key, value in list(detail.items())[:ALERT_DETAIL_ITEMS]:
        text = str(value)[:ALERT_DETAIL_VALUE_CHARS]
        lines.append(f"{escape_markdown(str(key))}: {escape_markdown(text)}")
    return lines


def format_alert(
    challenge_id: int,
    worker_id: str,
    kind: str | None,
    vnc_url: str | None,
    detail: Any = None,
) -> str:
    """The ops Telegram message for a raised challenge (MarkdownV2).

    Written so an operator reading it on a phone knows in one glance what is
    stuck, which worker it is stuck on, and can tap straight into the VNC
    session — the whole point of escalating is that a human acts fast.
    """
    kind_text = escape_markdown(str(kind or "challenge"))
    lines = [
        f"*Human needed: {kind_text}*",
        "",
        # Plain escaped text, not a code span: inside `...` MarkdownV2 renders
        # the backslashes literally.
        f"Worker: {escape_markdown(str(worker_id))}",
        f"Challenge: \\#{challenge_id}",
    ]
    lines.extend(_detail_lines(detail))

    if vnc_url:
        lines.append("")
        lines.append(f"[Open VNC session]({_escape_link_target(str(vnc_url))})")
    else:
        lines.append("")
        lines.append(escape_markdown("No VNC URL is registered for this worker."))
    return "\n".join(lines)


def parse_detail(detail_json: Any) -> Dict[str, Any]:
    """`detail_json` back into a dict, tolerating anything already stored.

    Old rows, hand-edited rows, and non-object JSON must not break the console,
    so anything unparseable is surfaced under `raw` instead of raising.
    """
    if not detail_json:
        return {}
    if isinstance(detail_json, dict):
        return detail_json
    try:
        parsed = json.loads(detail_json)
    except (TypeError, ValueError):
        return {"raw": str(detail_json)}
    if isinstance(parsed, dict):
        return parsed
    return {"raw": parsed}


def screenshot_url(challenge_id: int) -> str:
    """The admin-only route that serves a challenge's screenshot."""
    return f"/v1/challenges/{int(challenge_id)}/screenshot"


def to_challenge_out(row: Dict[str, Any]) -> Dict[str, Any]:
    """A `challenges` row in the `ChallengeOut` shape the console consumes.

    `screenshot_url` is set only when the screenshot is actually on disk, so the
    console can decide whether to render a thumbnail without a probe request.
    """
    challenge_id = int(row["id"])
    return {
        "id": challenge_id,
        "worker_id": row.get("worker_id") or "",
        "account_id": row.get("account_id"),
        "kind": row.get("kind"),
        "status": row.get("status") or "open",
        "vnc_url": row.get("vnc_url"),
        "screenshot_url": (
            screenshot_url(challenge_id) if screenshot_on_disk(row.get("screenshot_path")) else None
        ),
        "detail": parse_detail(row.get("detail_json")),
        "created_at": row.get("created_at"),
        "resolved_at": row.get("resolved_at"),
        "resolved_by": row.get("resolved_by"),
    }
