"""Parsing and checking the TOTP secret an operator pastes.

Shared by `rsc vault set-account` and the console's account route, so a
mistyped key is caught at the point of entry by both paths, with one set of
rules: the spaced base32 key Facebook prints, or the whole `otpauth://` URI
behind the QR code, are accepted; anything that does not decode is refused
with a message that says where the real key is.
"""

import base64
import binascii
import hashlib
import re
import time
from typing import Tuple

from .vault import VaultError

TOTP_DEFAULTS = (6, 30, "SHA1")
TOTP_ALGORITHMS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}


def parse_totp(raw: str) -> Tuple[str, int, int, str]:
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


def normalize_totp_secret(raw: str) -> str:
    """The validated value to store for `totp_secret`.

    Normally the bare base32 key. A URI carrying non-default parameters is kept
    verbatim instead: the vault has no field for digits/period/algorithm, and
    the code service honours a stored URI, so flattening one here would produce
    codes that are silently wrong.
    """
    secret, digits, period, algorithm = parse_totp(raw)
    if (digits, period, algorithm) != TOTP_DEFAULTS:
        return raw.strip()
    return secret


def totp_code(stored: str) -> Tuple[str, int]:
    """The code a stored secret produces right now, and its seconds remaining.

    Plain RFC 6238 — the same thing an authenticator app computes, which is the
    point: the operator compares the two.
    """
    try:
        import pyotp
    except ImportError as e:
        raise VaultError("pyotp is not installed — `pip install pyotp` to show codes.") from e

    secret, digits, period, algorithm = parse_totp(stored)
    totp = pyotp.TOTP(
        secret + "=" * (-len(secret) % 8),
        digits=digits,
        interval=period,
        digest=TOTP_ALGORITHMS[algorithm],
    )
    return totp.now(), period - int(time.time()) % period
