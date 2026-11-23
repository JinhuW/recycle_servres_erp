"""Playwright proxy settings from a proxy URL, shared by rs-session and PosterSession."""

from typing import Any, Dict, Optional
from urllib.parse import unquote, urlsplit, urlunsplit


def proxy_settings(proxy: Optional[str]) -> Optional[Dict[str, Any]]:
    """Split `http://user:pass@host:port` into Playwright's proxy fields.

    Chromium does NOT authenticate from credentials embedded in the proxy URL.
    Passing the whole string as `server`, which rs-session and PosterSession
    both used to do, gets a 407 the browser never answers, and the symptom is a
    page-load TIMEOUT rather than an auth error, so it reads as "the proxy is
    down". Measured against a
    live authenticated proxy: the embedded form times out both raw and
    percent-encoded, while the split form connects immediately.

    That form is the one deploy/README.md tells you to use when onboarding a
    worker (`--proxy "$PROXY_SOUTH_CENTRAL"`), so every fleet capture through an
    authenticated proxy would have failed this way.

    unquote, not unquote_plus: `+` is a legal literal in userinfo and is a real
    character in at least one live password. unquote_plus would turn it into a
    space and produce a wrong password that still looks plausible.
    """
    if not proxy:
        return None
    parts = urlsplit(proxy)
    if not parts.username:
        return {"server": proxy}
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    settings: Dict[str, Any] = {
        "server": urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
    }
    settings["username"] = unquote(parts.username)
    settings["password"] = unquote(parts.password or "")
    return settings
