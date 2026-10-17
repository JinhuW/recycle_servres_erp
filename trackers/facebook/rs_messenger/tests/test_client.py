"""Coordinator client: payload shape, auth, and the tight retry budget."""

import io
import json
import urllib.error

import pytest

from rs_messenger.client import MAX_RETRIES, CoordinatorClient, CoordinatorError
from rs_messenger.inbox import MessageSnapshot, ThreadSnapshot


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status = status
        self._body = json.dumps(body or {}).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeOpener:
    """Records requests; yields each scripted outcome (response or exception)."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def make_client(opener, **kwargs):
    return CoordinatorClient(
        base_url="http://coordinator:8500/",
        token="tok",
        worker_id="homelab-1",
        opener=opener,
        **kwargs,
    )


def test_sync_sends_the_contract_payload_with_auth(monkeypatch):
    opener = FakeOpener([FakeResponse(body={"threads": 1, "new_messages": 2, "queued_replies": 0})])
    client = make_client(opener)
    thread = ThreadSnapshot(
        thread_id="42", messages=[MessageSnapshot(direction="in", text="hi")]
    )

    result = client.sync_threads([thread])

    assert result["new_messages"] == 2
    (request,) = opener.requests
    assert request.full_url == "http://coordinator:8500/v1/messages/sync"
    assert request.get_header("Authorization") == "Bearer tok"
    body = json.loads(request.data.decode())
    assert body["worker_id"] == "homelab-1"
    assert body["threads"][0]["thread_id"] == "42"
    assert body["threads"][0]["messages"][0]["text"] == "hi"


def test_fetch_outbound_parses_the_list():
    opener = FakeOpener(
        [FakeResponse(body={"outbound": [{"id": 7, "thread_id": "42", "text": "x", "origin": "autoreply"}]})]
    )
    outbound = make_client(opener).fetch_outbound(limit=5)
    assert outbound == [{"id": 7, "thread_id": "42", "text": "x", "origin": "autoreply"}]
    assert "limit=5" in opener.requests[0].full_url


def test_ack_posts_status_and_error():
    opener = FakeOpener([FakeResponse()])
    make_client(opener).ack_outbound(7, "failed", "composer not found")
    (request,) = opener.requests
    assert request.full_url.endswith("/v1/messages/outbound/7/ack")
    assert json.loads(request.data.decode()) == {
        "status": "failed",
        "error": "composer not found",
    }


def test_outages_are_retried_then_raised():
    opener = FakeOpener(
        [urllib.error.URLError("down")] * MAX_RETRIES
    )
    import rs_messenger.client as client_module

    # No real sleeping between the scripted failures.
    original_sleep = client_module.time.sleep
    client_module.time.sleep = lambda seconds: None
    try:
        with pytest.raises(CoordinatorError, match="unreachable"):
            make_client(opener).fetch_outbound()
    finally:
        client_module.time.sleep = original_sleep
    assert len(opener.requests) == MAX_RETRIES


def test_a_refusal_is_terminal_not_retried():
    refusal = urllib.error.HTTPError(
        "http://coordinator:8500/v1/messages/sync", 401, "Unauthorized", {}, io.BytesIO(b"")
    )
    opener = FakeOpener([refusal])
    with pytest.raises(CoordinatorError, match="HTTP 401"):
        make_client(opener).sync_threads([])
    # One attempt only: a bad token does not fix itself.
    assert len(opener.requests) == 1


def test_unconfigured_client_refuses_by_name():
    client = CoordinatorClient(base_url="", token=None, worker_id=None, opener=FakeOpener([]))
    assert not client.configured
    assert client.missing() == [
        "RS_COORDINATOR_URL",
        "RS_COORDINATOR_TOKEN",
        "RS_WORKER_ID",
    ]
    with pytest.raises(CoordinatorError, match="RS_COORDINATOR_URL"):
        client.fetch_outbound()
