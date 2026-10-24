r"""A stand-in for the ERP's fleet worker API, for tests and local runs.

Implements `/api/fleet/worker/*` as CONTRACTS.md §5 describes it: `claim`
(host scope), `heartbeat`, `next-task` with the hold, `events` and `session`
(worker scope), with made-up account data. The worker token has the real
shape (`base64url(json{worker_id, account_no, epoch, exp}) . hmac`) under a
made-up key, and a token whose epoch is not the slot's current one gets
`409 stale_epoch` on every worker route, as the real server answers.

    python -m rs_worker.tests.fake_fleet [port]

runs it on its own (port 8790 by default) with one manual task queued, for a
container run against it:

    docker run --rm -e RS_FLEET_URL=http://host.docker.internal:8790 \\
        -e RS_FLEET_HOST_ID=lab -e RS_FLEET_HOST_TOKEN=made-up-host-token \\
        -e RS_FLEET_WORKER_ID=lab-1 --add-host host.docker.internal:host-gateway \\
        aimm-recycle:fleet

Nothing here is real: the account, the proxy (which does not resolve) and
the tokens are invented, so a worker pointed at it cannot reach Facebook
with real data.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.server
import json
import sys
import threading
import time
from typing import Any, Dict, List, Tuple

HOST_TOKEN = "made-up-host-token"  # pragma: allowlist secret
TOKEN_KEY = b"made-up-fleet-token-key"  # pragma: allowlist secret

# The slot a claim hands out. Every value is invented; the cookies have the
# names Playwright and the monitor look for and nothing else.
ACCOUNT = {
    "no": 12,
    "uid": "100000000000012",
    "password": "made-up-password",  # pragma: allowlist secret
    "totp_secret": "JBSWY3DPEHPK3PXP",
    "cookies": [
        {"name": "c_user", "value": "100000000000012", "domain": ".facebook.com", "path": "/",
         "expires": 4102444800, "httpOnly": False, "secure": True, "sameSite": "None"},
        {"name": "xs", "value": "made-up-xs", "domain": ".facebook.com", "path": "/",
         "expires": 4102444800, "httpOnly": True, "secure": True, "sameSite": "None"},
        {"name": "datr", "value": "made-up-datr", "domain": ".facebook.com", "path": "/",
         "expires": 4102444800, "httpOnly": True, "secure": True, "sameSite": "None"},
    ],
    "token": None,
}
PROXY = {"url": "http://proxy-user:proxy-pass@proxy.invalid:10007"}
DEVICE = {
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "viewport": [1366, 768],
    "timezone": "America/New_York",
    "locale": "en-US",
}
ITEMS = [
    {
        "name": "server_ram",
        "phrases": ["server ram memory ddr4 ddr5 ecc"],
        "filters": {"keywords": ["ram OR memory"], "antikeywords": ["single stick"],
                    "description": "Bulk lots of DDR4/DDR5 memory."},
    },
    {"name": "enterprise_ssd", "phrases": ["ssd lot server ssd"], "filters": {}},
]
SETTINGS = {
    "search": {"date_listed": ["last 7 days", "last 7 days"], "delivery_method": "local_pick_up",
               "max_results": 120},
    "coordinator_url": "http://coordinator.invalid:8500",
    "lease_minutes": 30,
    "poll_hold_seconds": 2,
}


def mint_token(worker_id: str, account_no: int, epoch: int, exp: int | None = None) -> str:
    claims = {
        "worker_id": worker_id,
        "account_no": account_no,
        "epoch": epoch,
        "exp": exp or int(time.time()) + 7 * 86400,
    }
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    mac = hmac.new(TOKEN_KEY, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def read_token(token: str) -> Dict[str, Any] | None:
    try:
        body, mac = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(mac, hmac.new(TOKEN_KEY, body.encode(), hashlib.sha256).hexdigest()):
        return None
    padded = body + "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))


class FakeFleet:
    """The server, with knobs a test turns: `claim_answer`, `tasks`, `bump_epoch`."""

    def __init__(self, port: int = 0, hold_seconds: float = 2.0, bind: str = "127.0.0.1") -> None:
        self.epoch = 6
        self.hold_seconds = hold_seconds
        # "ok", or one of "no_slot", "error", to make the claim fail that way.
        self.claim_answer = "ok"
        self.tasks: List[Dict[str, Any]] = []
        self.requests: List[Tuple[str, str, Dict[str, Any] | None, Dict[str, str]]] = []
        self.done: List[Dict[str, Any]] = []
        self.events: List[Dict[str, Any]] = []
        self.heartbeats: List[Dict[str, Any]] = []
        self.sessions: List[Dict[str, Any]] = []
        self._wake = threading.Condition()
        self._next_task_id = 124
        fleet = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                fleet.handle(self, "POST")

            def do_PUT(self) -> None:
                fleet.handle(self, "PUT")

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

        self.server = http.server.ThreadingHTTPServer((bind, port), Handler)
        self.url = f"http://{bind}:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> "FakeFleet":
        self._thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self) -> "FakeFleet":
        """Start on entry, stop on exit."""
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        """See `__enter__`."""
        self.stop()

    # -- knobs ------------------------------------------------------------
    def add_task(self, city: str = "houston", item: str = "server_ram", kind: str = "search",
                 name: str | None = None, radius_km: int = 500, why: str = "manual") -> Dict[str, Any]:
        task = {
            "id": self._next_task_id,
            "kind": kind,
            "city": {"slug": city, "name": name or city.title(), "radius_km": radius_km},
            "item": item,
            "lease_expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1800)),
            "why": why,
        }
        self._next_task_id += 1
        with self._wake:
            self.tasks.append(task)
            self._wake.notify_all()
        return task

    def bump_epoch(self) -> int:
        """Another claim moved the slot on: every token minted before is stale."""
        self.epoch += 1
        return self.epoch

    # -- the routes -------------------------------------------------------
    def handle(self, request: http.server.BaseHTTPRequestHandler, method: str) -> None:
        length = int(request.headers.get("Content-Length") or 0)
        raw = request.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except ValueError:
            body = None
        headers = {k.lower(): v for k, v in request.headers.items()}
        path = request.path.split("?", 1)[0]
        self.requests.append((method, path, body, headers))
        try:
            status, answer = self.route(method, path, body, headers)
        except Exception as e:
            status, answer = 500, {"error": "internal", "detail": str(e)}
        payload = json.dumps(answer).encode()
        request.send_response(status)
        request.send_header("Content-Type", "application/json")
        request.send_header("Content-Length", str(len(payload)))
        request.end_headers()
        request.wfile.write(payload)

    def route(self, method: str, path: str, body: Any, headers: Dict[str, str]) -> Tuple[int, Any]:
        bearer = headers.get("authorization", "")
        token = bearer[7:] if bearer.startswith("Bearer ") else ""
        if (method, path) == ("POST", "/api/fleet/worker/claim"):
            return self.claim(body, token)
        claims = read_token(token)
        if claims is None:
            return 401, {"error": "unauthorized"}
        if claims["epoch"] != self.epoch:
            return 409, {"error": "stale_epoch"}
        if (method, path) == ("POST", "/api/fleet/worker/heartbeat"):
            self.heartbeats.append(body)
            return 200, {"ok": True, "directives": []}
        if (method, path) == ("POST", "/api/fleet/worker/next-task"):
            return self.next_task(body or {})
        if (method, path) == ("POST", "/api/fleet/worker/events"):
            self.events.append(body)
            return 200, {"ok": True}
        if (method, path) == ("PUT", "/api/fleet/worker/session"):
            self.sessions.append(body)
            return 200, {"ok": True}
        return 404, {"error": "not_found"}

    def claim(self, body: Any, token: str) -> Tuple[int, Any]:
        if token != HOST_TOKEN:
            return 401, {"error": "unauthorized"}
        if not isinstance(body, dict) or not body.get("worker_id") or not body.get("host_id"):
            return 422, {"error": "bad_request"}
        if self.claim_answer == "no_slot":
            return 409, {"error": "no_slot"}
        if self.claim_answer == "error":
            return 500, {"error": "internal"}
        self.epoch += 1
        return 200, {
            "worker_token": mint_token(str(body["worker_id"]), ACCOUNT["no"], self.epoch),
            "epoch": self.epoch,
            "account": ACCOUNT,
            "proxy": PROXY,
            "device": DEVICE,
            "home_cities": ["nyc", "philly"],
            "items": ITEMS,
            "settings": SETTINGS,
        }

    def next_task(self, body: Dict[str, Any]) -> Tuple[int, Any]:
        if body.get("done"):
            self.done.append(body["done"])
        wait = min(float(body.get("wait") or 0), self.hold_seconds)
        deadline = time.monotonic() + wait
        with self._wake:
            while not self.tasks and time.monotonic() < deadline:
                self._wake.wait(timeout=max(0.0, deadline - time.monotonic()))
            if self.tasks:
                return 200, {"task": self.tasks.pop(0)}
        return 200, {"task": None, "retry_after": 30, "reason": "nothing_due"}


def main(argv: List[str]) -> int:
    port = int(argv[0]) if argv else 8790
    # All interfaces: a container reaches the host over its gateway address.
    fleet = FakeFleet(port=port, hold_seconds=50, bind="0.0.0.0").start()  # noqa: S104
    fleet.add_task()
    print(f"fake fleet on {fleet.url}; host token {HOST_TOKEN}; one task queued", flush=True)
    try:
        while True:
            time.sleep(5)
            if fleet.done:
                print(f"done so far: {fleet.done}", flush=True)
                fleet.done.clear()
    except KeyboardInterrupt:
        fleet.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
