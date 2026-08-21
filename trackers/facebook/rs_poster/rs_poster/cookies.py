"""Turn exported browser cookies into a Playwright storage_state file.

This is how workers authenticate without a stored password: you log into
Facebook once in a normal browser, export the cookies, and hand them to the
fleet. Nothing here ever sees a password.

Two input formats are accepted, covering what browsers and cookie extensions
actually emit:

  - Netscape `cookies.txt` (curl, wget, "Get cookies.txt" extensions)
  - JSON arrays from Cookie-Editor / EditThisCookie style extensions

Facebook's session lives in `c_user` (the account id) and `xs` (the session
token). Without both, the session is not authenticated.
"""

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

# Both must be present for a session to be usable.
REQUIRED_COOKIES = ("c_user", "xs")
# Long-lived device/browser identifiers. Facebook treats a session that arrives
# without the device cookies it was created with as more suspicious, so carry
# them across when the export includes them.
DEVICE_COOKIES = ("datr", "sb")

FACEBOOK_DOMAINS = (".facebook.com", "facebook.com", ".www.facebook.com")
VALID_SAME_SITE = {"Strict", "Lax", "None"}


class CookieError(RuntimeError):
    pass


@dataclass
class SessionInfo:
    """What we can tell about a session without contacting Facebook."""

    account_id: Optional[str]
    cookie_names: List[str]
    earliest_expiry: Optional[float]

    @property
    def has_required(self: "SessionInfo") -> bool:
        return all(name in self.cookie_names for name in REQUIRED_COOKIES)

    @property
    def missing(self: "SessionInfo") -> List[str]:
        return [name for name in REQUIRED_COOKIES if name not in self.cookie_names]

    @property
    def seconds_remaining(self: "SessionInfo") -> Optional[float]:
        if self.earliest_expiry is None:
            return None
        return self.earliest_expiry - time.time()

    @property
    def days_remaining(self: "SessionInfo") -> Optional[float]:
        remaining = self.seconds_remaining
        return None if remaining is None else remaining / 86400

    @property
    def expired(self: "SessionInfo") -> bool:
        remaining = self.seconds_remaining
        return remaining is not None and remaining <= 0


def _normalize_same_site(value: Any) -> str:
    """Map the many spellings extensions use onto Playwright's three values."""
    if not value:
        return "Lax"
    text = str(value).strip().lower()
    if text in ("no_restriction", "none"):
        return "None"
    if text in ("strict",):
        return "Strict"
    if text in ("lax", "unspecified"):
        return "Lax"
    return "Lax"


def _normalize_expiry(value: Any) -> float:
    """Return a POSIX expiry, using -1 for session cookies (Playwright's rule)."""
    if value in (None, "", 0):
        return -1
    try:
        expiry = float(value)
    except (TypeError, ValueError):
        return -1
    # Some exports use milliseconds; anything this far out is not seconds.
    if expiry > 1e11:
        expiry /= 1000.0
    return expiry


def parse_netscape(text: str) -> List[Dict[str, Any]]:
    cookies: List[Dict[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        # "#HttpOnly_" is a real cookie line, not a comment.
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_") :]
        elif not line or line.startswith("#"):
            continue

        parts = line.split("\t")
        if len(parts) != 7:
            parts = line.split()
            if len(parts) != 7:
                continue

        domain, _include_subdomains, path, secure, expiry, name, value = parts
        cookies.append(
            {
                "name": name,
                "value": value,
                "domain": domain,
                "path": path or "/",
                "expires": _normalize_expiry(expiry),
                "httpOnly": False,
                "secure": secure.upper() == "TRUE",
                "sameSite": "Lax",
            }
        )
    return cookies


def parse_json_cookies(data: Any) -> List[Dict[str, Any]]:
    # Cookie-Editor exports a bare array; some tools wrap it in {"cookies": [...]}.
    if isinstance(data, dict):
        data = data.get("cookies", data.get("Cookies", []))
    if not isinstance(data, list):
        raise CookieError("Expected a JSON array of cookies.")

    cookies: List[Dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict) or "name" not in entry:
            continue
        cookies.append(
            {
                "name": entry["name"],
                "value": str(entry.get("value", "")),
                "domain": entry.get("domain") or ".facebook.com",
                "path": entry.get("path") or "/",
                "expires": _normalize_expiry(
                    entry.get("expirationDate", entry.get("expires", entry.get("expiry")))
                ),
                "httpOnly": bool(entry.get("httpOnly", False)),
                "secure": bool(entry.get("secure", True)),
                "sameSite": _normalize_same_site(entry.get("sameSite")),
            }
        )
    return cookies


def load_cookie_file(path: str | Path) -> List[Dict[str, Any]]:
    path = Path(path)
    if not path.exists():
        raise CookieError(f"Cookie file not found: {path}")

    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        raise CookieError(f"Cookie file is empty: {path}")

    if text.startswith(("[", "{")):
        try:
            return parse_json_cookies(json.loads(text))
        except json.JSONDecodeError as e:
            raise CookieError(f"{path} looks like JSON but does not parse: {e}") from e
    return parse_netscape(text)


def filter_facebook(cookies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep Facebook cookies only, so an unfiltered browser export is safe to hand over."""
    kept = []
    for cookie in cookies:
        domain = str(cookie.get("domain", ""))
        if domain.endswith("facebook.com") or domain.endswith("messenger.com"):
            # Playwright rejects sameSite=None on a non-secure cookie.
            if cookie.get("sameSite") == "None" and not cookie.get("secure"):
                cookie["secure"] = True
            if cookie.get("sameSite") not in VALID_SAME_SITE:
                cookie["sameSite"] = "Lax"
            kept.append(cookie)
    return kept


def describe(cookies: List[Dict[str, Any]]) -> SessionInfo:
    names = [str(cookie.get("name")) for cookie in cookies]
    account_id = next(
        (str(c.get("value")) for c in cookies if c.get("name") == "c_user"), None
    )
    # Session cookies (-1) never "expire" on a clock, so ignore them here.
    expiries = [
        float(c["expires"])
        for c in cookies
        if str(c.get("name")) in REQUIRED_COOKIES
        and isinstance(c.get("expires"), (int, float))
        and float(c["expires"]) > 0
    ]
    return SessionInfo(
        account_id=account_id,
        cookie_names=names,
        earliest_expiry=min(expiries) if expiries else None,
    )


def filter_facebook_origins(origins: List[Dict[str, Any]] | None) -> List[Dict[str, Any]]:
    """Keep only Facebook origins from a storage_state's `origins` list.

    An origin entry carries that site's localStorage and, when Playwright is
    asked for it, its IndexedDB. Both are per-site, so an unfiltered browser
    export would otherwise hand a worker every site's client-side storage.
    """
    kept = []
    for origin in origins or []:
        url = str(origin.get("origin", ""))
        if "facebook.com" in url or "messenger.com" in url:
            kept.append(origin)
    return kept


def to_storage_state(
    cookies: List[Dict[str, Any]], origins: List[Dict[str, Any]] | None = None
) -> Dict[str, Any]:
    return {"cookies": cookies, "origins": origins or []}


def meta_path_for(state_path: str | Path) -> Path:
    """Sidecar holding the environment a session was created in.

    Facebook soft-pins a session to the browser and network it was born on, so
    reusing cookies under a different user-agent or from a different IP is a
    common way to get checkpointed. storage_state has nowhere to record that,
    hence this companion file.
    """
    return Path(str(state_path) + ".meta.json")


def write_session_meta(
    state_path: str | Path,
    user_agent: str | None = None,
    proxy: str | None = None,
    account_id: str | None = None,
    extra: Dict[str, Any] | None = None,
) -> Path:
    """Merge fields into the sidecar, leaving anything the caller omits alone.

    `extra` carries fields this module has no opinion about — the TOTP secret
    `rs_poster.totp` stores, for instance. A key mapped to None is deleted,
    which is how a stored value gets removed without rewriting the file.
    """
    path = meta_path_for(state_path)
    existing: Dict[str, Any] = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except json.JSONDecodeError:
            existing = {}

    meta = {
        **existing,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    # Only overwrite what the caller actually knows.
    for key, value in (
        ("user_agent", user_agent),
        ("proxy", proxy),
        ("account_id", account_id),
    ):
        if value:
            meta[key] = value

    for key, value in (extra or {}).items():
        if value is None:
            meta.pop(key, None)
        else:
            meta[key] = value

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2))
    path.chmod(0o600)
    return path


def read_session_meta(state_path: str | Path) -> Dict[str, Any]:
    path = meta_path_for(state_path)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def storage_state_cookies(path: str | Path) -> List[Dict[str, Any]]:
    path = Path(path)
    if not path.exists():
        raise CookieError(f"No session file at {path}")
    try:
        state = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise CookieError(f"{path} is not valid JSON: {e}") from e
    return list(state.get("cookies", []))


def write_storage_state(
    cookies: List[Dict[str, Any]],
    path: str | Path,
    origins: List[Dict[str, Any]] | None = None,
) -> SessionInfo:
    """Validate cookies and write them as a Playwright storage_state file.

    `origins` carries per-site localStorage and IndexedDB. Facebook keeps device
    state there as well as in cookies, so a session captured with it looks more
    like the browser it was born in than one restored from cookies alone. A
    cookies-only export (cookies.txt has no concept of origins) simply omits it.
    """
    facebook_cookies = filter_facebook(cookies)
    if not facebook_cookies:
        raise CookieError(
            "No facebook.com cookies found in the export. Make sure you exported "
            "while on facebook.com, not another site."
        )

    info = describe(facebook_cookies)
    if not info.has_required:
        raise CookieError(
            f"Export is missing required cookie(s): {', '.join(info.missing)}. "
            "These carry the login session — re-export while logged in, and make "
            "sure the tool includes httpOnly cookies."
        )
    if info.expired:
        raise CookieError(
            "The session cookies in this export have already expired. Log in again "
            "in your browser and re-export."
        )

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    state = to_storage_state(facebook_cookies, filter_facebook_origins(origins))
    path.write_text(json.dumps(state, indent=2))
    # The file is a live credential: keep it owner-readable only.
    path.chmod(0o600)
    return info
