"""Per-worker bearer tokens.

Each worker gets a token that identifies exactly one worker, so a compromised
VM can only ever reach its own account's codes — not the whole vault. Tokens
are stateless HMACs of the worker id, which means no token table to keep in
sync and revocation is a secret rotation.
"""

import hashlib
import hmac
import os
import secrets
from typing import Optional

ENV_SECRET = "RS_WORKER_TOKEN_SECRET"


class TokenError(RuntimeError):
    pass


def _secret(explicit: str | None = None) -> bytes:
    raw = explicit or os.environ.get(ENV_SECRET)
    if not raw:
        raise TokenError(
            f"{ENV_SECRET} is not set. Generate one (`openssl rand -hex 32`) and put it in "
            "the control plane's environment; worker tokens are derived from it."
        )
    return raw.encode()


def _signature(worker_id: str, secret: bytes) -> str:
    return hmac.new(secret, worker_id.encode(), hashlib.sha256).hexdigest()


def mint_worker_token(worker_id: str, secret: str | None = None) -> str:
    """The token to hand a worker. Safe to print — it is not the shared secret."""
    if not worker_id or "." in worker_id:
        raise TokenError("worker_id must be non-empty and contain no '.'")
    return f"{worker_id}.{_signature(worker_id, _secret(secret))}"


def verify_worker_token(token: str | None, secret: str | None = None) -> Optional[str]:
    """Return the worker id a token authenticates, or None."""
    if not token or "." not in token:
        return None
    worker_id, _, provided = token.rpartition(".")
    if not worker_id:
        return None
    try:
        expected = _signature(worker_id, _secret(secret))
    except TokenError:
        return None
    return worker_id if hmac.compare_digest(provided, expected) else None


# Host tokens are signed over this prefix, so no signature made for a worker id
# can ever verify as a host's, or the reverse, though both use one secret.
HOST_TOKEN_PREFIX = "host."
_HOST_DOMAIN = b"rs-fleet-host\x00"


def mint_host_token(host_id: str, secret: str | None = None) -> str:
    """The bearer token of a Docker host's fleet agent (rs-fleetd)."""
    if not host_id or "." in host_id:
        raise TokenError("host_id must be non-empty and contain no '.'")
    signature = hmac.new(_secret(secret), _HOST_DOMAIN + host_id.encode(), hashlib.sha256)
    return f"{HOST_TOKEN_PREFIX}{host_id}.{signature.hexdigest()}"


def verify_host_token(token: str | None, secret: str | None = None) -> Optional[str]:
    """Return the host id a token authenticates, or None."""
    if not token or not token.startswith(HOST_TOKEN_PREFIX):
        return None
    host_id, _, provided = token[len(HOST_TOKEN_PREFIX) :].rpartition(".")
    if not host_id or "." in host_id:
        return None
    try:
        expected = hmac.new(_secret(secret), _HOST_DOMAIN + host_id.encode(), hashlib.sha256)
    except TokenError:
        return None
    return host_id if hmac.compare_digest(provided, expected.hexdigest()) else None


def generate_secret() -> str:
    """A fresh HMAC secret, for first-time setup."""
    return secrets.token_hex(32)
