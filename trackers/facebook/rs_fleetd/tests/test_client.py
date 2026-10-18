"""The client never raises: every failure is None, which the agent reads as offline."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from rs_fleetd.client import FleetClient


class Coordinator:
    """A tiny coordinator on 127.0.0.1:0 that answers from a script."""

    def __init__(self):
        self.routes = {}
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                owner.requests.append((self.command, self.path, dict(self.headers), body))
                status, payload = owner.routes.get((self.command, self.path), (404, {"detail": "no"}))
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = _answer
            do_POST = _answer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def coordinator():
    server = Coordinator()
    yield server
    server.close()


def client(url):
    return FleetClient(url, "homelab", "host.homelab.sig", timeout=2)


def test_desired_is_fetched_with_the_host_token(coordinator):
    doc = {"host_id": "homelab", "authoritative": True, "workers": []}
    coordinator.routes[("GET", "/v1/fleet/hosts/homelab/desired")] = (200, doc)
    assert client(coordinator.url).desired() == doc
    method, path, headers, _ = coordinator.requests[0]
    assert headers["Authorization"] == "Bearer host.homelab.sig"


def test_a_config_and_a_report(coordinator):
    coordinator.routes[("GET", "/v1/fleet/hosts/homelab/configs/va-1")] = (
        200, {"worker_id": "va-1", "sha256": "ab", "toml": "x = 1\n"})
    coordinator.routes[("POST", "/v1/fleet/hosts/homelab/report")] = (200, {"status": "ok"})
    c = client(coordinator.url)
    assert c.config("va-1")["toml"] == "x = 1\n"
    assert c.report({"workers": []}) is True
    assert json.loads(coordinator.requests[-1][3]) == {"workers": []}


@pytest.mark.parametrize(
    "answer",
    [
        (403, {"detail": "not your host"}),
        (500, {"detail": "boom"}),
        (200, b"<html>not json</html>"),
        (200, ["not", "an", "object"]),
        (200, {"workers": "not a list"}),
    ],
)
def test_every_bad_answer_is_none(coordinator, answer):
    coordinator.routes[("GET", "/v1/fleet/hosts/homelab/desired")] = answer
    assert client(coordinator.url).desired() is None


def test_an_unreachable_coordinator_is_none():
    c = FleetClient("http://127.0.0.1:9", "homelab", "t", timeout=1)
    assert c.desired() is None
    assert c.config("va-1") is None
    assert c.report({}) is False


def test_an_unset_url_is_none_not_a_crash():
    assert FleetClient("", "homelab", "t").desired() is None


def test_a_timeout_is_none(monkeypatch):
    def slow(request, timeout=None):
        raise TimeoutError("timed out")

    assert FleetClient("http://x", "homelab", "t", opener=slow).desired() is None
