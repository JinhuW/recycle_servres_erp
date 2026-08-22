"""The Messenger bridge: inbox snapshots in, Telegram alerts and replies out.

`rs-messenger` workers scrape each account's Marketplace inbox and report
whole thread snapshots here. This router makes re-reporting idempotent
(`claim_message`, the same atomic pattern as listings), routes every *new*
inbound message to Telegram through the durable outbox, asks the auto-reply
policy whether the thread earns an automatic answer, and holds the queue of
replies a worker types back into Facebook.

Nothing here touches Facebook. The coordinator decides; workers act.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import autoreply, deps
from ..db import utcnow
from ..dedupe import message_fingerprint
from ..deps import require_admin, require_worker
from ..schemas import MessagesSyncRequest, OperatorReply, OutboundAck, ThreadIn
from ..telegram_notify import escape_markdown, format_message

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/v1/messages/sync")
def sync_messages(
    payload: MessagesSyncRequest, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    worker_id = worker or payload.worker_id
    db = deps.db
    policy = autoreply.policy_from_env()
    new_messages = 0
    queued_replies = 0
    failed = 0

    for thread in payload.threads:
        try:
            fresh_in, reply_queued = _ingest_thread(db, thread, worker_id, policy)
        except Exception:
            # Same batch-isolation stance as listings: one broken thread must
            # not cost the worker the rest of its inbox report.
            logger.exception("Could not ingest thread %s; skipping it", thread.thread_id)
            failed += 1
            continue
        new_messages += fresh_in
        queued_replies += reply_queued

    result = {
        "threads": len(payload.threads),
        "new_messages": new_messages,
        "queued_replies": queued_replies,
    }
    if failed:
        result["failed"] = failed
    return result


def _ingest_thread(
    db: Any, thread: ThreadIn, worker_id: str | None, policy: autoreply.AutoReplyPolicy
) -> tuple:
    """Record one thread snapshot; returns (new messages, replies queued)."""
    db.upsert_thread(
        thread.thread_id,
        {
            "worker_id": worker_id,
            "counterpart": thread.counterpart,
            "listing_title": thread.listing_title,
            "last_message_at": thread.last_message_at,
        },
    )

    fresh_inbound = 0
    for message in thread.messages:
        direction = "out" if message.direction == "out" else "in"
        record = {
            "fingerprint": message_fingerprint(
                thread.thread_id, direction, message.sender, message.text, message.sent_at
            ),
            "thread_id": thread.thread_id,
            "direction": direction,
            "sender": message.sender,
            "text": message.text,
            "sent_at": message.sent_at,
        }
        if not db.claim_message(record):
            continue
        if direction != "in":
            continue
        fresh_inbound += 1
        row = db.get_thread(thread.thread_id) or {"thread_id": thread.thread_id}
        # Through the outbox, like every alert: a Telegram outage delays the
        # message notification, it does not lose it.
        db.enqueue_alert("message_in", format_message(row, record))

    replies = 0
    if fresh_inbound:
        row = db.get_thread(thread.thread_id) or {}
        reply = policy.decide(
            row,
            db.list_messages(thread.thread_id),
            db.count_autoreplies_since(autoreply.day_window_start()),
        )
        if reply:
            db.enqueue_outbound(thread.thread_id, worker_id, reply, "autoreply")
            # Stamped at queue time so a second sync of the same thread cannot
            # queue a second reply while the first waits for a worker.
            db.set_thread_fields(thread.thread_id, {"autoreplied_at": utcnow()})
            # Tell the operator what the bot just did, in the same chat that
            # carried the message itself. Silent automation is how a bot says
            # something regrettable to a seller for a week before anyone knows.
            name = escape_markdown(str(row.get("counterpart") or thread.thread_id))
            db.enqueue_alert(
                "message_autoreply",
                f"_Auto\\-reply queued to {name}_\n{escape_markdown(reply)}",
            )
            replies = 1

    return fresh_inbound, replies


@router.get("/v1/messages/outbound")
def fetch_outbound(
    limit: int = Query(default=10, ge=1, le=50),
    worker_id: str | None = Query(default=None),
    worker: Optional[str] = Depends(require_worker),
) -> Dict[str, Any]:
    """The replies this worker should type into Facebook, oldest first."""
    identity = worker or worker_id
    rows = deps.db.pending_outbound(worker_id=identity, limit=limit)
    return {
        "outbound": [
            {"id": row["id"], "thread_id": row["thread_id"], "text": row["text"],
             "origin": row["origin"]}
            for row in rows
        ]
    }


@router.post("/v1/messages/outbound/{outbound_id}/ack")
def ack_outbound(
    outbound_id: int, payload: OutboundAck, _worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    if payload.status not in ("sent", "failed"):
        raise HTTPException(status_code=422, detail="status must be 'sent' or 'failed'")
    if deps.db.get_outbound(outbound_id) is None:
        raise HTTPException(status_code=404, detail=f"No outbound message {outbound_id}")
    deps.db.mark_outbound(outbound_id, payload.status, payload.error)
    return {"status": "ok"}


# -- operator console --------------------------------------------------------


@router.get("/v1/threads", dependencies=[Depends(require_admin)])
def list_threads(limit: int = Query(default=50, ge=1, le=500)) -> Dict[str, Any]:
    return {"threads": deps.db.list_threads(limit=limit)}


@router.get("/v1/threads/{thread_id}/messages", dependencies=[Depends(require_admin)])
def thread_messages(thread_id: str) -> Dict[str, Any]:
    if deps.db.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail=f"No thread {thread_id}")
    return {"messages": deps.db.list_messages(thread_id)}


@router.post("/v1/threads/{thread_id}/claim", dependencies=[Depends(require_admin)])
def claim_thread(thread_id: str) -> Dict[str, Any]:
    """Mark a thread as human-handled; auto-reply never touches it again."""
    if deps.db.get_thread(thread_id) is None:
        raise HTTPException(status_code=404, detail=f"No thread {thread_id}")
    deps.db.set_thread_fields(thread_id, {"human_claimed": 1})
    return {"status": "ok"}


@router.post("/v1/threads/{thread_id}/reply", dependencies=[Depends(require_admin)])
def operator_reply(thread_id: str, payload: OperatorReply) -> Dict[str, Any]:
    """Queue a human-written reply; the thread's worker sends it next poll.

    Claims the thread as a side effect: an operator who answered is now the
    one holding the conversation.
    """
    row = deps.db.get_thread(thread_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No thread {thread_id}")
    if not payload.text.strip():
        raise HTTPException(status_code=422, detail="Reply text is empty")
    outbound_id = deps.db.enqueue_outbound(
        thread_id, row.get("worker_id"), payload.text.strip(), "operator"
    )
    deps.db.set_thread_fields(thread_id, {"human_claimed": 1})
    return {"status": "ok", "outbound_id": outbound_id}
