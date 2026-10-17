"""Request and response models shared by every router.

This is the wire contract between the control plane, the workers, and the
admin console. Streams code against these models rather than inventing their
own shapes, so the pieces fit without coordination.
"""

from enum import Enum
from typing import Any, Dict, List, Literal, Optional

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
    # The mautrix-meta portal room this thread arrives from, when the reporter
    # is the router. The Playwright scraper does not set it; None never blanks a
    # room id an earlier router report already recorded (upsert COALESCEs).
    matrix_room_id: str | None = None
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
    # Which bridge delivers it: 'matrix' (mautrix-meta, the default) or
    # 'playwright' (the legacy scraper, the fallback when the bridge is down).
    transport: str = "matrix"


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
    # The build the worker runs ("0.5.6 (d3e9a30)"); absent from workers on
    # images that predate it.
    version: str | None = None
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
    version: str | None = None
    # Derived by the control plane, not reported: live / stale / dead.
    liveness: str | None = None
    needs_attention: bool = False


class WorkerList(BaseModel):
    workers: List[WorkerOut]


# -- review stats ------------------------------------------------------------


class ReviewStatsReport(BaseModel):
    """One search page's funnel deltas, in pipeline order.

    Older workers send only `reviewed` and `alerted`; the rest default to 0.
    """

    worker_id: str | None = None
    searches: int = Field(default=0, ge=0)
    cards: int = Field(default=0, ge=0)
    title_pass: int = Field(default=0, ge=0)
    opened: int = Field(default=0, ge=0)
    keyword_pass: int = Field(default=0, ge=0)
    fresh: int = Field(default=0, ge=0)
    reviewed: int = Field(default=0, ge=0)
    alerted: int = Field(default=0, ge=0)


class ReviewStatsDay(BaseModel):
    day: str
    searches: int = 0
    cards: int = 0
    title_pass: int = 0
    opened: int = 0
    keyword_pass: int = 0
    fresh: int = 0
    reviewed: int
    alerted: int
    # Counted by the coordinator itself, at ingest and at Telegram delivery.
    coordinated: int = 0
    sent: int = 0


class ReviewStatsList(BaseModel):
    days: List[ReviewStatsDay]


# -- alert hit tracking ------------------------------------------------------


class AlertMessageReport(BaseModel):
    """One delivered Telegram alert message, reported by the monitor after the
    send so partner reactions can be joined back to the listing."""

    worker_id: str | None = None
    chat_id: str
    message_id: int
    part: int = Field(default=1, ge=1)
    parts: int = Field(default=1, ge=1)
    topic_id: int | None = None
    priority: str | None = None
    listing_id: str | None = None
    post_url: str | None = None
    item_name: str | None = None
    search_city: str | None = None
    search_phrase: str | None = None
    ai_score: int | None = None
    unit_count: int | None = None
    prompt_hash: str | None = None


class IncidentReport(BaseModel):
    """A worker's view of one system fault: it is down, or working again.

    `key` names the fault ("ai_unavailable"); the coordinator decides whether
    the report is news (see incidents.py). `detail` is the last error, shown
    only in the note that opens the incident.
    """

    worker_id: str | None = None
    key: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_.-]+$")
    state: Literal["down", "up"]
    detail: str | None = Field(default=None, max_length=1000)


class IncidentResponse(BaseModel):
    status: str = "ok"
    open: bool
    # True when this report is the one that paged ops (or closed the loop).
    alerted: bool


class AlertHitRow(BaseModel):
    """Sent vs reacted counts for one (day, priority, item, city) bucket."""

    day: str
    priority: str | None = None
    item_name: str | None = None
    search_city: str | None = None
    sent: int
    hit: int


class AlertHitList(BaseModel):
    rows: List[AlertHitRow]
    # Live reactions on messages with no recorded alert (sent before the
    # ledger existed, or on a timed-out send) — the denominator's blind spot.
    unmatched_reactions: int = 0


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
    # The session's Facebook numeric user id (`c_user` cookie): the public
    # profile identity, never a credential.
    fb_user_id: str | None = None
    user_agent: str | None = None
    session_expiry: str | None = None
    backed_up_at: str | None = None


# -- accounts (vault, non-secret view) ----------------------------------------


class AccountOut(BaseModel):
    """One vault account as the console may see it: identity and *which*
    secrets are stored, never a secret value."""

    account_id: str
    worker_id: str | None = None
    fb_username: str | None = None
    region: str | None = None
    vnc_url: str | None = None
    allow_password_login: bool = False
    # Whether a proxy is registered — the value itself carries credentials.
    proxy_configured: bool = False
    # secret field name -> stored or not.
    secrets: Dict[str, bool] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None


class AccountList(BaseModel):
    accounts: List[AccountOut]


# What a vault account or worker may be called: what fleet.toml, RS_WORKER_ID
# and `rsc vault set-account --account-id` already use. Keeps a label out of
# the URL space and the audit log that could not be typed on a command line.
ACCOUNT_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$"
WORKER_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"


class AccountUpsert(BaseModel):
    """What the console may write to a vault account (PUT /v1/accounts/{id}).

    Everything is optional so the ERP can change one thing at a time: a field
    left out keeps its stored value. `secrets` is write-only — a value is
    stored, `null` clears the field, and an empty string keeps whatever is
    there (what a password box left blank in a form means). Nothing in the
    response ever echoes a secret back; the caller sees presence flags only.
    """

    worker_id: str | None = Field(default=None, pattern=WORKER_ID_PATTERN)
    fb_username: str | None = Field(default=None, max_length=200)
    region: str | None = Field(default=None, max_length=64)
    allow_password_login: bool | None = None
    secrets: Dict[str, Optional[str]] = Field(default_factory=dict)


class StatusResponse(BaseModel):
    status: str = "ok"
