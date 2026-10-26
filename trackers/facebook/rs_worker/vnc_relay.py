"""Let a manager watch this worker's browser from the ERP, with no port open here.

The worker dials *out* to `GET {fleet}/api/fleet/worker/vnc` with its worker
token and parks the socket there. RFB is one session per connection and its
server speaks first, so nothing is sent until the relay says a viewer is on
the other end: one text frame, `viewer`. Only then is the local x11vnc
dialled and bytes moved both ways, as binary frames. When either side ends,
both end, and a fresh socket is parked for the next viewer.

Never touches the browser or the session. A `409` on the dial (the slot's
epoch moved on) stops the relay for good; the monitor exits on the same 409.
"""

from __future__ import annotations

import socket
from pathlib import Path
import threading
import time
from typing import Callable, Tuple

from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus
from websockets.sync.client import ClientConnection, connect

PATH = "/api/fleet/worker/vnc"
VIEWER = "viewer"
CHUNK = 64 * 1024
HEALTHY_PARK_S = 30


def relay_url(fleet_url: str) -> str:
    base = fleet_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + PATH
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + PATH
    raise ValueError(f"not an http(s) URL: {fleet_url!r}")


class VncRelay:
    """A daemon thread that keeps one socket parked at the ERP's relay."""

    def __init__(
        self,
        fleet_url: str,
        worker_token: str,
        vnc_addr: Tuple[str, int] = ("127.0.0.1", 5900),
        log: Callable[[str], None] = lambda message: None,
        backoff: Tuple[float, float] = (1.0, 60.0),
        token_path: str | None = None,
    ) -> None:
        self.url = relay_url(fleet_url)
        self.worker_token = worker_token
        self.token_path = token_path
        self.vnc_addr = vnc_addr
        self.log = log
        self.backoff = backoff
        self.dials = 0
        self.sessions = 0
        self.refused: int | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._open: list[socket.socket] = []
        self._thread = threading.Thread(target=self._run, name="vnc-relay", daemon=True)

    def start(self) -> "VncRelay":
        self._thread.start()
        return self

    def request_stop(self) -> None:
        """Stop without blocking; safe from a signal handler."""
        self._stop.set()
        with self._lock:
            sockets = list(self._open)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def stop(self, timeout: float = 1.0) -> None:
        self.request_stop()
        if self._thread.is_alive():
            self._thread.join(timeout)

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    # -- the loop ----------------------------------------------------------
    def _run(self) -> None:
        delay = self.backoff[0]
        while not self._stop.is_set():
            self.dials += 1
            served = False
            dialled_at = time.monotonic()
            try:
                token = Path(self.token_path).read_text().strip() if self.token_path else self.worker_token
                with connect(
                    self.url,
                    additional_headers={"Authorization": f"Bearer {token}"},
                    proxy=None,  # straight to the ERP, never the account's proxy
                    compression=None,
                    open_timeout=10,
                    close_timeout=2,
                    max_size=None,
                ) as ws:
                    served = self._session(ws)
            except InvalidStatus as e:
                status = e.response.status_code
                if status in (401, 409):
                    self.refused = status
                    self.log("VNC relay: the fleet refuses this worker's epoch; not dialling again")
                    return
                self.log(f"VNC relay: dial refused with HTTP {status}")
            except (OSError, TimeoutError, InvalidHandshake) as e:
                self.log(f"VNC relay: dial failed: {e}")
            if served or time.monotonic() - dialled_at > HEALTHY_PARK_S:
                # A viewer served, or a socket that stayed parked a while (a
                # proxy's idle cut): the next viewer must not wait long.
                delay = self.backoff[0]
            if self._stop.wait(delay):
                return
            delay = min(delay * 2, self.backoff[1])

    def _track(self, sock: socket.socket | None, add: bool) -> None:
        if sock is None:
            return
        with self._lock:
            if add:
                self._open.append(sock)
            elif sock in self._open:
                self._open.remove(sock)

    def _session(self, ws: ClientConnection) -> bool:
        """One parked socket, to its end. True when a viewer was served."""
        self._track(ws.socket, True)
        vnc: socket.socket | None = None
        try:
            if self._stop.is_set():
                return False
            try:
                first = ws.recv()
            except ConnectionClosed:
                return False
            if first != VIEWER:
                ws.close(1008, "expected the relay's viewer signal")
                return False
            try:
                vnc = socket.create_connection(self.vnc_addr, timeout=5)
            except OSError as e:
                ws.close(1011, f"the worker's VNC server is not answering: {e}"[:120])
                return True
            vnc.settimeout(None)
            self._track(vnc, True)
            self.sessions += 1
            self.log("VNC relay: a viewer is watching")
            to_vnc = threading.Thread(target=self._pump_ws_to_vnc, args=(ws, vnc), daemon=True)
            to_vnc.start()
            self._pump_vnc_to_ws(vnc, ws)
            to_vnc.join(timeout=2)
            return True
        finally:
            self._track(ws.socket, False)
            self._track(vnc, False)
            if vnc is not None:
                vnc.close()
            try:
                ws.close(1000)
            except Exception:
                pass

    def _pump_vnc_to_ws(self, vnc: socket.socket, ws: ClientConnection) -> None:
        try:
            while True:
                data = vnc.recv(CHUNK)
                if not data:
                    break
                ws.send(data)
        except (OSError, ConnectionClosed):
            pass
        finally:
            try:
                ws.close(1000, "the worker's VNC session ended")
            except Exception:
                pass

    def _pump_ws_to_vnc(self, ws: ClientConnection, vnc: socket.socket) -> None:
        try:
            for message in ws:
                if isinstance(message, str):
                    continue
                vnc.sendall(message)
        except (OSError, ConnectionClosed):
            pass
        finally:
            try:
                vnc.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
