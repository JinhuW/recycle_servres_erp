"""Turn a pool account's stored cookie into a Playwright storage_state.

The ERP's Facebook account pool keeps each account's cookie as the operator
pasted it, in one of three shapes (see `packages/shared/src/facebookPool.ts`
`cookieUid`): a browser cookie header (`c_user=..; xs=..`), the JSON a cookie
extension exports (an array of `{name, value, ...}`), or a flat `{name: value}`
object. The fleet authenticates from a Playwright `storage_state`, so the
cookie-first assign (RS-308) seeds a worker's session snapshot from one of
these.

This is a stdlib-only port of the pool-relevant half of `rs_poster.cookies`.
The coordinator image is deliberately slim and must not pull in Playwright,
which `rs_poster` depends on, so the two cannot share a module — hence the
small duplication. The poster's copy still owns the capture/`rs-session
import` paths (Netscape files, origins/localStorage); this one owns only what
a pool cookie can be.

A session needs `c_user` (the account id) and `xs` (the session token); the
device cookies `datr`/`sb` ride along when present. Attributes a bare header
line cannot carry are synthesised to Facebook's real ones — notably httpOnly on
the bearer cookies, so they are not left readable from JavaScript, which is a
fingerprint tell (`rs_poster.cookies` carries the same note).
"""

import json
from typing import Any, Dict, List, Tuple

# Both must be present for a storage_state to authenticate.
REQUIRED_COOKIES = ("c_user", "xs")
# The Facebook cookies that are httpOnly in a real browser. A pasted header
# line records no flags, so these are marked httpOnly on the way in rather than
# left readable from `document.cookie`.
HTTPONLY_COOKIES = ("xs", "datr", "sb", "fr")
VALID_SAME_SITE = {"Strict", "Lax", "None"}


class CookieError(ValueError):
    """The pasted cookie is not a usable Facebook session."""


def _normalize_same_site(value: Any) -> str:
    """Map the many spellings extensions use onto Playwright's three values."""
    text = str(value or "").strip().lower()
    if text in ("no_restriction", "none"):
        return "None"
    if text == "strict":
        return "Strict"
    return "Lax"


def _normalize_expiry(value: Any) -> float:
    """A POSIX expiry, or -1 for a session cookie (Playwright's rule).

    A session cookie (`xs` among them) carries no expiry; -1 is how Playwright
    records "no expiry" in a storage_state and is kept on restore, whereas 0
    reads as the epoch and is dropped.
    """
    if value is None:
        return -1
    text = str(value).strip()
    if text in ("", "0"):
        return -1
    try:
        expiry = float(text)
    except (TypeError, ValueError):
        return -1
    if expiry <= 0:
        return -1
    # Some exports use milliseconds; anything this far out is not seconds.
    if expiry > 1e11:
        expiry /= 1000.0
    return expiry


def _synthesized(name: str, value: str) -> Dict[str, Any]:
    """A Playwright cookie for a name/value pair that carried no attributes."""
    return {
        "name": name,
        "value": value,
        "domain": ".facebook.com",
        "path": "/",
        "expires": -1,
        "httpOnly": name in HTTPONLY_COOKIES,
        "secure": True,
        "sameSite": "None",
    }


def parse_cookie_header(text: str) -> List[Dict[str, Any]]:
    """Parse a `name=value; name=value` cookie header."""
    cookies: List[Dict[str, Any]] = []
    for part in text.split(";"):
        name, sep, value = part.strip().partition("=")
        name = name.strip()
        if not sep or not name:
            continue
        cookies.append(_synthesized(name, value.strip()))
    return cookies


def parse_mapping(obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse a flat `{name: value}` object, the hand-made export shape."""
    cookies: List[Dict[str, Any]] = []
    for name, value in obj.items():
        if isinstance(value, (str, int)) and str(name).strip():
            cookies.append(_synthesized(str(name).strip(), str(value)))
    return cookies


def parse_json_cookies(data: Any) -> List[Dict[str, Any]]:
    """Cookie-Editor exports an array; some wrap it in `{"cookies": [...]}`; a
    hand-made export is sometimes a flat `{name: value}` object."""
    if isinstance(data, dict):
        if "cookies" in data or "Cookies" in data:
            data = data.get("cookies", data.get("Cookies"))
        else:
            return parse_mapping(data)
    if not isinstance(data, list):
        raise CookieError("Expected a JSON array of cookies or a {name: value} object.")

    cookies: List[Dict[str, Any]] = []
    for entry in data:
        if not isinstance(entry, dict) or "name" not in entry:
            continue
        name = str(entry["name"])
        cookies.append(
            {
                "name": name,
                "value": str(entry.get("value", "")),
                "domain": entry.get("domain") or ".facebook.com",
                "path": entry.get("path") or "/",
                "expires": _normalize_expiry(
                    entry.get("expirationDate", entry.get("expires", entry.get("expiry")))
                ),
                # An export that records the flag wins; otherwise fall back to
                # what the cookie is in a real browser.
                "httpOnly": bool(entry.get("httpOnly", name in HTTPONLY_COOKIES)),
                "secure": bool(entry.get("secure", True)),
                "sameSite": _normalize_same_site(entry.get("sameSite")),
            }
        )
    return cookies


def cookies_from_text(text: str) -> List[Dict[str, Any]]:
    """Cookies from any shape a pool account stores them in."""
    text = (text or "").strip()
    if not text:
        raise CookieError("No cookie to read.")
    if text.startswith(("[", "{")):
        try:
            return parse_json_cookies(json.loads(text))
        except json.JSONDecodeError as e:
            raise CookieError(f"Cookie looks like JSON but does not parse: {e}") from e
    return parse_cookie_header(text)


def filter_facebook(cookies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep Facebook cookies only, so an unfiltered export is safe to hand on."""
    kept: List[Dict[str, Any]] = []
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


def storage_state_from_text(text: str) -> Tuple[Dict[str, Any], str]:
    """Validate a pasted cookie and return `(storage_state, c_user)`.

    Raises `CookieError` when it carries no Facebook session — the one gate
    before a cookie is sealed as a worker's session snapshot.
    """
    cookies = filter_facebook(cookies_from_text(text))
    if not cookies:
        raise CookieError(
            "No facebook.com cookies in this value. Paste the cookie from a logged-in "
            "facebook.com tab."
        )
    present = {str(c.get("name")) for c in cookies}
    missing = [name for name in REQUIRED_COOKIES if name not in present]
    if missing:
        raise CookieError(
            f"The cookie is missing {', '.join(missing)}, which carries the login session. "
            "Re-copy it from a logged-in facebook.com tab, including httpOnly cookies."
        )
    c_user = next(c["value"] for c in cookies if c.get("name") == "c_user")
    return {"cookies": cookies, "origins": []}, str(c_user)
