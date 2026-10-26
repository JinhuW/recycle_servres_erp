"""The worker's VNC relay against a fake ERP relay and a fake x11vnc.

The contract: the worker dials the relay with its worker token and parks a
socket that sends nothing until the relay signals a viewer; then it dials
the local VNC server and moves bytes both ways; when either side ends, both
end and a fresh socket is parked. A 409 on the dial stops it for good, and
a stop ends it promptly, parked or mid-session.
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Any, Callable, Iterator, List

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Response
from websockets.sync.server import ServerConnection, serve

from rs_worker.vnc_relay import VIEWER, VncRelay, relay_url

TOKEN = "made-up-worker-token"  # pragma: allowlist secret
GREETING = b"RFB 003.008\n"


def until(check: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


class FakeVnc:
    """x11vnc's first move (the RFB greeting), then an echo."""

    def __init__(self) -> None:
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        self.connections = 0
        self.live: List[socket.socket] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            self.connections += 1
            self.live.append(conn)
            threading.Thread(target=self._echo, args=(conn,), daemon=True).start()

    @staticmethod
    def _echo(conn: socket.socket) -> None:
        try:
            with conn:
                conn.sendall(GREETING)
                while data := conn.recv(4096):
                    conn.sendall(data)
        except OSError:
            pass

    def hang_up(self) -> None:
        for conn in self.live:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self) -> None:
        self.server.close()


class FakeRelay:
    """The ERP's /api/fleet/worker/vnc: checks the token, parks, signals a viewer."""

    def __init__(self, status: int = 101) -> None:
        self.status = status
        self.parked: List[ServerConnection] = []
        self.premature: List[Any] = []
        self.headers: List[Headers] = []

        def check(conn: ServerConnection, request: Any) -> Response | None:
            self.headers.append(request.headers)
            if request.path != "/api/fleet/worker/vnc":
                return conn.respond(404, "")
            if self.status != 101:
                return conn.respond(self.status, '{"error":"stale_epoch"}')
            if request.headers.get("Authorization") != f"Bearer {TOKEN}":
                return conn.respond(401, "")
            return None

        def handler(conn: ServerConnection) -> None:
            self.parked.append(conn)
            # Park until the test plays the viewer; anything the worker
            # sends before that would be refused by the real relay.
            try:
                conn.wait_closed()
            except Exception:
                pass

        self.server = serve(handler, "127.0.0.1", 0, process_request=check, compression=None)
        self.url = f"http://127.0.0.1:{self.server.socket.getsockname()[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


@pytest.fixture
def vnc() -> Iterator[FakeVnc]:
    server = FakeVnc()
    yield server
    server.close()


@pytest.fixture
def relay() -> Iterator[FakeRelay]:
    server = FakeRelay()
    yield server
    server.close()


def test_relay_url() -> None:
    assert relay_url("https://api.example.com/") == "wss://api.example.com/api/fleet/worker/vnc"
    assert relay_url("http://10.0.0.1:8787") == "ws://10.0.0.1:8787/api/fleet/worker/vnc"
    with pytest.raises(ValueError):
        relay_url("ftp://x")


def test_a_parked_socket_says_nothing_then_bridges_a_viewer_and_parks_again(
    relay: FakeRelay, vnc: FakeVnc
) -> None:
    worker = VncRelay(relay.url, TOKEN, ("127.0.0.1", vnc.port), backoff=(0.05, 0.2)).start()
    try:
        until(lambda: len(relay.parked) == 1)
        assert relay.headers[0]["Authorization"] == f"Bearer {TOKEN}"
        parked = relay.parked[0]
        # Parked: nothing from the worker, and the VNC server not yet dialled.
        with pytest.raises(TimeoutError):
            parked.recv(timeout=0.3)
        assert vnc.connections == 0

        parked.send(VIEWER)
        assert parked.recv(timeout=5) == GREETING  # the server speaks first, through the relay
        parked.send(b"RFB 003.008\n")
        assert parked.recv(timeout=5) == b"RFB 003.008\n"
        assert vnc.connections == 1 and worker.sessions == 1

        # The viewer leaves: the pair ends and a fresh socket is parked.
        parked.close()
        until(lambda: len(relay.parked) == 2)
        with pytest.raises(TimeoutError):
            relay.parked[1].recv(timeout=0.3)
    finally:
        worker.stop()
    assert not worker.is_alive()


def test_the_vnc_server_ending_the_session_ends_the_viewer_too(
    relay: FakeRelay, vnc: FakeVnc
) -> None:
    worker = VncRelay(relay.url, TOKEN, ("127.0.0.1", vnc.port), backoff=(0.05, 0.2)).start()
    try:
        until(lambda: len(relay.parked) == 1)
        viewer_end = relay.parked[0]
        viewer_end.send(VIEWER)
        assert viewer_end.recv(timeout=5) == GREETING
        vnc.hang_up()
        viewer_end.wait_closed()
        assert viewer_end.close_code == 1000
        until(lambda: len(relay.parked) == 2)
    finally:
        worker.stop()
    assert not worker.is_alive()


def test_a_stop_mid_session_ends_both_sides(relay: FakeRelay, vnc: FakeVnc) -> None:
    worker = VncRelay(relay.url, TOKEN, ("127.0.0.1", vnc.port), backoff=(5, 5)).start()
    until(lambda: len(relay.parked) == 1)
    relay.parked[0].send(VIEWER)
    assert relay.parked[0].recv(timeout=5) == GREETING
    started = time.monotonic()
    worker.stop(timeout=3)
    assert not worker.is_alive() and time.monotonic() - started < 3
    relay.parked[0].wait_closed()
    assert len(relay.parked) == 1  # no re-dial after a stop


def test_no_vnc_server_closes_the_viewer_with_a_reason(relay: FakeRelay) -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
    worker = VncRelay(relay.url, TOKEN, ("127.0.0.1", dead_port), backoff=(0.05, 0.2)).start()
    try:
        until(lambda: len(relay.parked) == 1)
        relay.parked[0].send(VIEWER)
        relay.parked[0].wait_closed()
        assert relay.parked[0].close_code == 1011
        assert "VNC server is not answering" in (relay.parked[0].close_reason or "")
        until(lambda: len(relay.parked) == 2)  # and it parks again for the next viewer
    finally:
        worker.stop()


def test_a_stale_epoch_stops_the_relay_for_good_and_fences_the_monitor(tmp_path) -> None:
    relay = FakeRelay(status=409)
    fence = tmp_path / "fenced"
    try:
        worker = VncRelay(relay.url, "stale", backoff=(0.05, 0.2), fence_path=str(fence)).start()
        until(lambda: not worker.is_alive())
        assert worker.refused == 409 and worker.dials == 1
        assert fence.read_text() == "409\n"
    finally:
        relay.close()


def test_an_unreachable_relay_is_dialled_again_with_backoff() -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    worker = VncRelay(f"http://127.0.0.1:{port}", TOKEN, backoff=(0.05, 0.1)).start()
    try:
        until(lambda: worker.dials >= 3)
    finally:
        worker.stop()
    assert not worker.is_alive()


def test_a_stop_while_parked_ends_at_once(relay: FakeRelay) -> None:
    worker = VncRelay(relay.url, TOKEN, backoff=(5, 5)).start()
    until(lambda: len(relay.parked) == 1)
    started = time.monotonic()
    worker.stop(timeout=3)
    assert not worker.is_alive() and time.monotonic() - started < 3


def test_the_fake_fleet_relay_sees_the_screen_through_a_worker_token(vnc: FakeVnc) -> None:
    # What a container run against `python -m rs_worker.tests.fake_fleet` does.
    from .fake_fleet import FakeFleet, mint_token

    with FakeFleet() as fleet:
        fleet.epoch = 3
        worker = VncRelay(
            fleet.url, mint_token("lab-1", 12, 3), ("127.0.0.1", vnc.port), backoff=(0.05, 0.2)
        ).start()
        try:
            until(lambda: len(fleet.relay_screens) >= 1)
        finally:
            worker.stop()
        assert fleet.relay_screens[0] == GREETING

        # A token for an older epoch is refused with 409, and the relay stops.
        stale = VncRelay(fleet.url, mint_token("lab-1", 12, 2), backoff=(0.05, 0.2)).start()
        until(lambda: not stale.is_alive())
        assert stale.refused == 409


def test_reconnection_reads_the_renewed_token(relay: FakeRelay, tmp_path) -> None:
    token_file = tmp_path / 'fleet-token'
    token_file.write_text(TOKEN)
    worker = VncRelay(relay.url, TOKEN, token_path=str(token_file), backoff=(0.05, 0.1)).start()
    try:
        until(lambda: len(relay.parked) >= 1)
        token_file.write_text('made-up-renewed-token')
        relay.parked[0].close()
        until(lambda: len(relay.headers) >= 2)
        assert relay.headers[1]['Authorization'] == 'Bearer made-up-renewed-token'
    finally:
        worker.stop()
