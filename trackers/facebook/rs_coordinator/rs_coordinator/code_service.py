"""Dispatcher for verification codes.

One entry point for every kind of code a worker might need, so the auth router
does not care whether a code came from a TOTP secret or was scraped out of an
inbox. The per-kind modules are imported lazily: each is owned by a different
work stream, and a missing one degrades to a clear error instead of breaking
the whole service at import time.
"""

from typing import Tuple

from .schemas import CodeKind


class CodeUnavailable(RuntimeError):
    """No code could be produced — expected when an inbox has nothing yet."""


def get_code(account_id: str, kind: str | CodeKind, since: str | None = None) -> Tuple[str, int]:
    """Return (code, seconds_until_it_expires) for an account.

    Raises CodeUnavailable when no code exists yet (a caller should retry) and
    ValueError for an unknown kind.
    """
    kind = CodeKind(kind)

    if kind is CodeKind.TOTP:
        try:
            from .totp_code import generate_for
        except ImportError as e:  # pragma: no cover - stream A not landed yet
            raise CodeUnavailable(f"TOTP code service is unavailable: {e}") from e
        return generate_for(account_id)

    if kind is CodeKind.EMAIL:
        try:
            from .email_codes import latest_code
        except ImportError as e:  # pragma: no cover - stream D not landed yet
            raise CodeUnavailable(f"Email code service is unavailable: {e}") from e
        return latest_code(account_id, since)

    raise ValueError(f"Unknown code kind: {kind}")
