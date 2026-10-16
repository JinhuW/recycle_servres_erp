"""TOTP codes minted from the vault.

The whole point of the control plane is that the TOTP secret never leaves it:
a session expires in weeks, a TOTP secret mints codes until the account
re-enrols, so a worker VM must never hold one. Workers ask for a code at the
moment Facebook prompts for it and get a six-digit string with a TTL.

The maths is plain RFC 6238 (base32 secret, SHA-1, 30-second step, 6 digits) —
the same thing a phone authenticator computes, nothing to call out to. The
stored secret may also be a full ``otpauth://`` URI, which is what a QR reader
hands back; it carries digits/period/algorithm, so those are honoured rather
than assumed. Non-default parameters have no home of their own in the vault
(`SECRET_FIELDS` is a fixed list), so the URI form is the only way to express
them, and that is deliberate — one field to store, one thing to paste.
"""

import base64
import binascii
import hashlib
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# Imported at module scope on purpose: the dispatcher in code_service imports
# this module lazily and turns an ImportError into a clean CodeUnavailable, so
# a deployment without pyotp degrades to one bad endpoint, not a dead service.
import pyotp

from . import deps
from .code_service import CodeUnavailable

DEFAULT_DIGITS = 6
DEFAULT_PERIOD = 30
DEFAULT_ALGORITHM = "SHA1"

# A code with a couple of seconds left is useless: the worker still has to type
# it into a form. Below this, hand out the *next* window's code instead, so what
# we return is always usable for at least a full period.
MIN_USEFUL_SECONDS = 3

_ALGORITHMS = {
    "SHA1": hashlib.sha1,
    "SHA256": hashlib.sha256,
    "SHA512": hashlib.sha512,
}

# Everything a human might paste around a base32 secret: Facebook prints the key
# in space-separated groups, other sites use dashes, and some copy with padding.
_JUNK = re.compile(r"[\s\-_]+")

_FIX_IT = (
    "Store one with `rsc vault set-account <account> --totp-secret <base32-or-otpauth-uri>`."
)


@dataclass(frozen=True)
class TotpConfig:
    """A validated base32 secret plus the parameters it is used with."""

    secret: str
    digits: int = DEFAULT_DIGITS
    period: int = DEFAULT_PERIOD
    algorithm: str = DEFAULT_ALGORITHM
    label: Optional[str] = None


def _pad(secret: str) -> str:
    return secret + "=" * (-len(secret) % 8)


def _clean(raw: str) -> str:
    return _JUNK.sub("", raw).rstrip("=").upper()


def _decode(secret: str, account_id: str) -> None:
    """Reject a malformed secret here, where the message can name the fix."""
    try:
        base64.b32decode(_pad(secret), casefold=True)
    except (binascii.Error, ValueError) as e:
        raise CodeUnavailable(
            f"The TOTP secret stored for account '{account_id}' is not valid base32 "
            f"(letters A-Z and digits 2-7, or a whole otpauth:// URI). {_FIX_IT}"
        ) from e


def parse_secret(raw: str, account_id: str) -> TotpConfig:
    """Accept a bare base32 secret or a full ``otpauth://`` URI."""
    text = (raw or "").strip()
    if not text:
        raise CodeUnavailable(f"No TOTP secret is stored for account '{account_id}'. {_FIX_IT}")

    if not text.lower().startswith("otpauth://"):
        secret = _clean(text)
        if not secret:
            # `_clean` strips separators, so a vault entry of "----" or "  -  "
            # survives the empty check above and comes out as "". base32 decodes
            # "" happily, and HMAC over an empty key produces a perfectly
            # plausible six digits — a code that will never work, indistinguishable
            # from one that should. rs_poster/totp.py has always guarded this.
            raise CodeUnavailable(
                f"The TOTP secret stored for account '{account_id}' is only separators, "
                f"with no base32 characters in it. {_FIX_IT}"
            )
        _decode(secret, account_id)
        return TotpConfig(secret=secret)

    parsed = urlparse(text)
    if parsed.netloc.lower() not in ("totp", ""):
        raise CodeUnavailable(
            f"Account '{account_id}' has a '{parsed.netloc}' URI stored; only time-based "
            "(totp) secrets can be used unattended."
        )
    params = parse_qs(parsed.query)

    def one(name: str) -> Optional[str]:
        values = params.get(name)
        return values[0] if values else None

    raw_secret = one("secret")
    if not raw_secret:
        raise CodeUnavailable(
            f"The otpauth URI stored for account '{account_id}' has no 'secret'. {_FIX_IT}"
        )
    secret = _clean(raw_secret)
    _decode(secret, account_id)

    algorithm = (one("algorithm") or DEFAULT_ALGORITHM).upper()
    if algorithm not in _ALGORITHMS:
        raise CodeUnavailable(
            f"Account '{account_id}' asks for algorithm '{algorithm}'; supported: "
            f"{', '.join(sorted(_ALGORITHMS))}."
        )

    def positive_int(name: str, default: int) -> int:
        value = one(name)
        if value is None:
            return default
        try:
            number = int(value)
        except ValueError as e:
            raise CodeUnavailable(
                f"The otpauth URI for account '{account_id}' has a non-numeric "
                f"'{name}': {value}."
            ) from e
        if number <= 0:
            raise CodeUnavailable(
                f"The otpauth URI for account '{account_id}' has a non-positive "
                f"'{name}': {value}."
            )
        return number

    return TotpConfig(
        secret=secret,
        digits=positive_int("digits", DEFAULT_DIGITS),
        period=positive_int("period", DEFAULT_PERIOD),
        algorithm=algorithm,
        label=parsed.path.lstrip("/") or one("issuer") or None,
    )


def normalize_totp_secret(raw: str) -> str:
    """The value to store for a pasted TOTP key.

    Normally the bare base32 key. A URI carrying non-default parameters is kept
    verbatim instead: the vault has no field for digits/period/algorithm, and
    `parse_secret` honours a stored URI, so flattening one would produce codes
    that are silently wrong. Raises CodeUnavailable for a key that cannot mint
    codes, so nothing unusable is ever stored.
    """
    config = parse_secret(raw, "(new)")
    if (config.digits, config.period, config.algorithm) != (
        DEFAULT_DIGITS,
        DEFAULT_PERIOD,
        DEFAULT_ALGORITHM,
    ):
        return raw.strip()
    return config.secret


def config_for(account_id: str) -> TotpConfig:
    """The account's TOTP parameters, straight from the vault."""
    secrets: Dict[str, Any] = deps.get_account_store().get_secret(account_id)
    return parse_secret(str(secrets.get("totp_secret") or ""), account_id)


def generate_for(account_id: str, at: Optional[float] = None) -> Tuple[str, int]:
    """Return (code, seconds_it_stays_valid) for an account.

    When the current window is nearly over the next window's code is returned
    instead, so a worker never receives a code that expires while it is being
    typed. `expires_in` therefore describes the code returned, not the clock.

    Raises CodeUnavailable when the account has no usable secret.
    """
    config = config_for(account_id)
    now = int(at if at is not None else time.time())
    remaining = config.period - (now % config.period)
    if remaining <= MIN_USEFUL_SECONDS:
        now += remaining
        remaining = config.period

    totp = pyotp.TOTP(
        _pad(config.secret),
        digits=config.digits,
        interval=config.period,
        digest=_ALGORITHMS[config.algorithm],
    )
    return totp.at(now), remaining
