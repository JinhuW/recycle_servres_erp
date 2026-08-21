"""Two-factor codes for the fleet's Facebook accounts.

Every worker account has two-factor authentication on, so every login needs a
six-digit code: `rs-session capture` when a session is first created or has
lapsed, and the poster's password fallback. Fetching each account's code from a
web authenticator by hand is the manual step this module removes.

A code is plain RFC 6238 — base32 secret, SHA-1, 30-second step, 6 digits.
There is no service to call and nothing leaves the machine; a web authenticator
computes exactly this in the page.

Where the secret lives
----------------------
Per session, in the same `<session>.json.meta.json` sidecar that already records
the user agent and proxy the session was born on. That keeps one account's
secret with that account's cookies: the sidecar is 0600 and gitignored, the same
handling the cookies get, and the cookies are an equally live credential.

Resolution order, most specific first:

  1. an explicit secret passed in (`--secret`, or the constructor argument)
  2. ``FB_TOTP_SECRET_<SESSION>`` — e.g. ``FB_TOTP_SECRET_TX_1`` for
     ``configs/sessions/tx-1.json``. Lets an operator override per account
     without editing files.
  3. ``totp_secret`` in the session's sidecar — the normal case, and the one
     that travels with the session into a worker.
  4. ``FB_TOTP_SECRET`` — the single-account fallback. Inside a worker
     container every session is ``/data/fb_state.json``, so the unsuffixed
     variable is the one that makes sense there.

Note that a stored secret is strictly stronger than the cookies beside it: a
session expires in weeks, a TOTP secret mints codes until the account re-enrolls.
Workers only need it if you configure the password fallback (`FB_USERNAME` /
`FB_PASSWORD`), which is not the intended setup — the sidecar is mounted
read-only there. Operators running `rs-session` are the real consumer.
"""

import base64
import binascii
import hashlib
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, unquote, urlparse

from .cookies import read_session_meta, write_session_meta

DEFAULT_DIGITS = 6
DEFAULT_PERIOD = 30
DEFAULT_ALGORITHM = "SHA1"

ENV_PREFIX = "FB_TOTP_SECRET"

_ALGORITHMS = {
    "SHA1": hashlib.sha1,
    "SHA256": hashlib.sha256,
    "SHA512": hashlib.sha512,
}

# Everything a human might paste around a base32 secret: Facebook prints the key
# in space-separated groups, other sites use dashes, and some copy with padding.
_JUNK = re.compile(r"[\s\-_]+")


class TotpError(RuntimeError):
    pass


@dataclass(frozen=True)
class TotpConfig:
    """A validated TOTP secret plus the parameters it is used with."""

    secret: str
    digits: int = DEFAULT_DIGITS
    period: int = DEFAULT_PERIOD
    algorithm: str = DEFAULT_ALGORITHM
    label: Optional[str] = None

    @property
    def is_default(self) -> bool:
        """True when the parameters are the ones Facebook (and everyone) uses."""
        return (
            self.digits == DEFAULT_DIGITS
            and self.period == DEFAULT_PERIOD
            and self.algorithm == DEFAULT_ALGORITHM
        )


def _pad(secret: str) -> str:
    return secret + "=" * (-len(secret) % 8)


def _decode(secret: str) -> bytes:
    try:
        return base64.b32decode(_pad(secret), casefold=True)
    except (binascii.Error, ValueError) as e:
        raise TotpError(
            "That does not decode as a base32 secret. Copy the key Facebook shows "
            "under Settings -> Security -> Two-factor -> Authentication app -> "
            '"Set up another way" (letters A-Z and digits 2-7 only), or paste the '
            "whole otpauth:// URI from the QR code."
        ) from e


def parse_secret(raw: str) -> TotpConfig:
    """Accept a bare base32 secret or a full ``otpauth://`` URI.

    The URI form is what a QR-code reader hands back, and it carries the digit
    count and period, so honour those rather than assuming 6/30.
    """
    if not raw or not raw.strip():
        raise TotpError("No secret given.")

    text = raw.strip()
    if text.lower().startswith("otpauth://"):
        return _parse_otpauth(text)

    secret = _JUNK.sub("", text).rstrip("=").upper()
    if not secret:
        raise TotpError("No secret given.")
    _decode(secret)
    return TotpConfig(secret=secret)


def _parse_otpauth(uri: str) -> TotpConfig:
    parsed = urlparse(uri)
    if parsed.netloc.lower() not in ("totp", ""):
        raise TotpError(
            f"Only time-based (totp) URIs are supported, got '{parsed.netloc}'. "
            "Counter-based HOTP cannot be used unattended."
        )

    params = parse_qs(parsed.query)

    def one(name: str) -> Optional[str]:
        values = params.get(name)
        return values[0] if values else None

    raw_secret = one("secret")
    if not raw_secret:
        raise TotpError("otpauth URI has no 'secret' parameter.")
    secret = _JUNK.sub("", raw_secret).rstrip("=").upper()
    _decode(secret)

    algorithm = (one("algorithm") or DEFAULT_ALGORITHM).upper()
    if algorithm not in _ALGORITHMS:
        raise TotpError(
            f"Unsupported algorithm '{algorithm}'. Supported: "
            f"{', '.join(sorted(_ALGORITHMS))}."
        )

    def positive_int(name: str, default: int) -> int:
        value = one(name)
        if value is None:
            return default
        try:
            number = int(value)
        except ValueError as e:
            raise TotpError(f"otpauth URI has a non-numeric '{name}': {value}") from e
        if number <= 0:
            raise TotpError(f"otpauth URI has a non-positive '{name}': {value}")
        return number

    return TotpConfig(
        secret=secret,
        digits=positive_int("digits", DEFAULT_DIGITS),
        period=positive_int("period", DEFAULT_PERIOD),
        algorithm=algorithm,
        label=unquote(parsed.path.lstrip("/")) or one("issuer"),
    )


def generate(config: TotpConfig, at: Optional[float] = None) -> str:
    """The code valid at ``at`` (default: now)."""
    import pyotp

    totp = pyotp.TOTP(
        _pad(config.secret),
        digits=config.digits,
        interval=config.period,
        digest=_ALGORITHMS[config.algorithm],
    )
    return totp.at(int(at if at is not None else time.time()))


def seconds_remaining(config: TotpConfig, at: Optional[float] = None) -> int:
    """Seconds the current code stays valid. Below ~5, wait for the next one."""
    now = int(at if at is not None else time.time())
    return config.period - (now % config.period)


def env_var_for(state_path: str | Path) -> str:
    """``configs/sessions/tx-1.json`` -> ``FB_TOTP_SECRET_TX_1``."""
    stem = Path(str(state_path)).name
    # Ordered longest first, and applied in sequence: a sidecar is named
    # "tx-1.json.meta.json", so both suffixes come off to reach "tx-1".
    for suffix in (".meta.json", ".json"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    slug = re.sub(r"[^A-Za-z0-9]+", "_", stem).strip("_").upper()
    return f"{ENV_PREFIX}_{slug}" if slug else ENV_PREFIX


def from_meta(meta: Dict[str, Any]) -> Optional[TotpConfig]:
    """Rebuild a config from a sidecar dict, or None if no secret is stored."""
    secret = meta.get("totp_secret")
    if not secret:
        return None
    config = parse_secret(str(secret))
    return TotpConfig(
        secret=config.secret,
        digits=int(meta.get("totp_digits", config.digits)),
        period=int(meta.get("totp_period", config.period)),
        algorithm=str(meta.get("totp_algorithm", config.algorithm)).upper(),
        label=meta.get("totp_label", config.label),
    )


def resolve(
    state_path: str | Path | None = None, explicit: str | None = None
) -> Optional[TotpConfig]:
    """Find this session's secret. See the module docstring for the order."""
    if explicit:
        return parse_secret(explicit)

    if state_path is not None:
        from_env = os.environ.get(env_var_for(state_path))
        if from_env:
            return parse_secret(from_env)

        stored = from_meta(read_session_meta(state_path))
        if stored is not None:
            return stored

    shared = os.environ.get(ENV_PREFIX)
    return parse_secret(shared) if shared else None


def store(state_path: str | Path, config: TotpConfig) -> Path:
    """Write the secret into the session's sidecar (0600, gitignored)."""
    extra: Dict[str, Any] = {"totp_secret": config.secret}
    # Only record parameters that differ from the universal defaults, so a
    # sidecar stays readable and the common case has one extra line.
    if not config.is_default:
        extra["totp_digits"] = config.digits
        extra["totp_period"] = config.period
        extra["totp_algorithm"] = config.algorithm
    if config.label:
        extra["totp_label"] = config.label
    return write_session_meta(state_path, extra=extra)


def clear(state_path: str | Path) -> bool:
    """Remove a stored secret. True if there was one."""
    meta = read_session_meta(state_path)
    keys = [k for k in meta if k.startswith("totp_")]
    if not keys:
        return False
    write_session_meta(state_path, extra={k: None for k in keys})
    return True
