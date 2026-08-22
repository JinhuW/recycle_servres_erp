"""Request and response models shared by every router.

This is the wire contract between the control plane, the workers, and the
admin console. Streams code against these models rather than inventing their
own shapes, so the pieces fit without coordination.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class WorkerState(str, Enum):
    """Where a worker is in its lifecycle. Reported on every heartbeat."""

    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    CHALLENGE_2FA = "CHALLENGE_2FA"
    CHALLENGE_EMAIL = "CHALLENGE_EMAIL"
    CHALLENGE_CAPTCHA = "CHALLENGE_CAPTCHA"
    CHECKPOINT = "CHECKPOINT"
    DEAD = "DEAD"

    @property
    def needs_human(self) -> bool:
        return self in (WorkerState.CHALLENGE_CAPTCHA, WorkerState.CHECKPOINT)

    @property
    def is_bad(self) -> bool:
        return self is not WorkerState.HEALTHY


class CodeKind(str, Enum):
    TOTP = "totp"
    EMAIL = "email"


# -- listings (existing contract, unchanged) --------------------------------


class ListingPayload(BaseModel):
    marketplace: str = "facebook"
    id: str
    name: str | None = None
    title: str | None = None
    price: str | None = None
    location: str | None = None
    post_url: str | None = None
    condition: str | None = None
    seller: str | None = None
    description: str | None = None
    image: str | None = None
    listing_hash: str | None = None
    ai_score: int | None = None
    ai_comment: str | None = None
    # The AI's unit count as a display phrase ("8 sticks"); null from workers
    # that predate the field.
    ai_count: str | None = None
    status: str | None = None

    model_config = {"extra": "ignore"}


class ListingsRequest(BaseModel):
    worker_id: str
    listings: List[ListingPayload] = Field(default_factory=list)


# -- auth / codes -----------------------------------------------------------


class CodeRequest(BaseModel):
    # Both identity fields are advisory only. The bearer token decides which
    # account a code is minted for; these are kept so older workers still parse,
    # and are logged-and-ignored when they disagree with the token.
    worker_id: str | None = None
    account_id: str | None = None
    kind: CodeKind = CodeKind.TOTP
    # Only consider verification emails newer than this ISO timestamp, so a
    # stale code from a previous challenge is never replayed.
    since: str | None = None
    reason: str | None = None


class CodeResponse(BaseModel):
    code: str
    expires_in: int
    kind: CodeKind


class CredentialsRequest(BaseModel):
    worker_id: str | None = None
    reason: str | None = None


class CredentialsResponse(BaseModel):
    username: str
    password: str


# -- escalation -------------------------------------------------------------


class EscalateRequest(BaseModel):
    worker_id: str | None = None
    account_id: str | None = None
    kind: str = "captcha"
    screenshot_b64: str | None = None
    detail: Dict[str, Any] = Field(default_factory=dict)


class EscalateResponse(BaseModel):
    challenge_id: int
    vnc_url: str | None = None


class ChallengeOut(BaseModel):
    id: int
    worker_id: str
    account_id: str | None = None
    kind: str | None = None
    status: str
    vnc_url: str | None = None
    screenshot_url: str | None = None
    detail: Dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    resolved_at: str | None = None
    resolved_by: str | None = None


class ChallengeList(BaseModel):
    challenges: List[ChallengeOut]


class ResolveRequest(BaseModel):
    resolved_by: str | None = None


# -- messenger --------------------------------------------------------------


class MessageIn(BaseModel):
    """One scraped Messenger message. `direction` is from the account's view:
    'in' came from the counterpart, 'out' was sent by us (human or bot)."""

    direction: str = "in"
    sender: str | None = None
    text: str | None = None
    sent_at: str | None = None

    model_config = {"extra": "ignore"}


class ThreadIn(BaseModel):
    thread_id: str
    counterpart: str | None = None
    listing_title: str | None = None
    last_message_at: str | None = None
    messages: List[MessageIn] = Field(default_factory=list)

    model_config = {"extra": "ignore"}


class MessagesSyncRequest(BaseModel):
    worker_id: str | None = None
    threads: List[ThreadIn] = Field(default_factory=list)


class OutboundAck(BaseModel):
    status: str  # 'sent' or 'failed'
    error: str | None = None


class OperatorReply(BaseModel):
    text: str


# -- health -----------------------------------------------------------------


class HeartbeatRequest(BaseModel):
    worker_id: str
    state: WorkerState | None = None
    # Kept for the pre-control-plane workers still sending a free-text status.
    status: str = "ok"
    region: str | None = None
    account_id: str | None = None
    session_expiry: str | None = None
    last_search_at: str | None = None
    last_listing_at: str | None = None
    error_count: int | None = None
    browser_ok: bool | None = None
    proxy_ok: bool | None = None
    vnc_url: str | None = None
    detail: Dict[str, Any] = Field(default_factory=dict)


class HeartbeatResponse(BaseModel):
    status: str = "ok"
    # Reserved for future push-style instructions (pause, rotate proxy, …).
    directives: List[str] = Field(default_factory=list)


class WorkerOut(BaseModel):
    worker_id: str
    state: str | None = None
    status: str | None = None
    region: str | None = None
    account_id: str | None = None
    session_expiry: str | None = None
    session_days_left: float | None = None
    last_heartbeat_at: str | None = None
    last_search_at: str | None = None
    last_listing_at: str | None = None
    error_count: int | None = None
    vnc_url: str | None = None
    # Derived by the control plane, not reported: live / stale / dead.
    liveness: str | None = None
    needs_attention: bool = False


class WorkerList(BaseModel):
    workers: List[WorkerOut]


# -- session backup ---------------------------------------------------------


class SessionBackupRequest(BaseModel):
    worker_id: str | None = None
    account_id: str | None = None
    # The Playwright storage_state document, as JSON.
    storage_state: Dict[str, Any]
    user_agent: str | None = None
    session_expiry: str | None = None


class SessionMeta(BaseModel):
    worker_id: str
    account_id: str | None = None
    user_agent: str | None = None
    session_expiry: str | None = None
    backed_up_at: str | None = None


class StatusResponse(BaseModel):
    status: str = "ok"
