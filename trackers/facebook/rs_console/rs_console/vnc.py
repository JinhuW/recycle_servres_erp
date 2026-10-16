"""Watch a worker's browser from the dashboard: VNC over a WebSocket.

Every monitor container runs x11vnc on its own port 5900 — unauthenticated,
because it is a logged-in Facebook browser and the only thing that was ever
meant to reach it is an ssh tunnel to the docker bridge. That works for one
operator with a terminal; it does not work for "click the worker's row and
see what it is doing". This module is the second route in.

The console container is on the same `rs-fleet` network as the workers, so
it can open a plain TCP connection to `rs-monitor-ne:5900` by container
name. It bridges that socket to a WebSocket the vendored noVNC client speaks
(`static/novnc`), and serves the page that hosts the client at
`/vnc/<worker_id>`.

What must stay true:

  * **No VNC port is published anywhere.** The bridge is the only path, and
    it is behind the console token. A worker whose id is not in
    `RS_VNC_TARGETS` cannot be reached at all.
  * **The bearer token never appears in a URL.** Browsers cannot set headers
    on a WebSocket, so the page first POSTs (with the token) for a
    short-lived, single-use *ticket* and opens the socket with that. A ticket
    in an access log is worthless seconds later.
  * **View-only is the default.** The page opens without keyboard or mouse
    forwarding, and taking control is an explicit toggle, because the
    session is shared: a stray click lands in the same browser the scraper
    is driving mid-sweep.

Configuration (env):
    RS_VNC_TARGETS   `worker_id=host:port` pairs, comma separated, e.g.
                     `homelab-1=rs-monitor:5900,homelab-ne=rs-monitor-ne:5900`
                     The worker id is what the worker heartbeats as
                     (RS_WORKER_ID); the host is its container name.
    RS_CONSOLE_PUBLIC_URL
                     Optional. When set, `vnc_url` in the fleet document is
                     absolute (for the ERP page, which is on another origin);
                     otherwise it is a path on this host.
"""

import asyncio
import secrets
import time
from typing import Dict, Optional, Tuple

from fastapi import WebSocket

# A ticket outlives the round trip from "issue" to "connect" and nothing
# more. A minute covers a slow tunnel; single use covers a replay.
TICKET_TTL_S = 60.0
CONNECT_TIMEOUT_S = 5.0
# One RFB framebuffer update for a 1280x800 screen can run to a few hundred
# KB; read in large chunks so the pump is not the bottleneck.
CHUNK = 64 * 1024

Target = Tuple[str, int]


def parse_targets(spec: Optional[str]) -> Dict[str, Target]:
    """`a=host:1,b=host:2` -> {"a": ("host", 1), "b": ("host", 2)}.

    Malformed entries are skipped rather than fatal: a typo in one worker's
    line must not take the whole dashboard down with it.
    """
    out: Dict[str, Target] = {}
    for entry in (spec or "").split(","):
        entry = entry.strip()
        if not entry or "=" not in entry:
            continue
        worker_id, _, address = entry.partition("=")
        host, _, port = address.strip().rpartition(":")
        try:
            port_no = int(port)
        except ValueError:
            continue
        if not worker_id.strip() or not host or not (0 < port_no < 65536):
            continue
        out[worker_id.strip()] = (host, port_no)
    return out


def page_url(worker_id: str, public_base: Optional[str]) -> str:
    path = f"/vnc/{worker_id}"
    base = (public_base or "").strip().rstrip("/")
    return f"{base}{path}" if base else path


class TicketStore:
    """Single-use, expiring tickets binding one WebSocket to one worker.

    In memory on purpose: a ticket is good for a minute on the process that
    issued it, and the console is one process. A restart invalidates every
    outstanding ticket, which is the right failure mode.
    """

    def __init__(self, ttl_s: float = TICKET_TTL_S) -> None:
        self._ttl = ttl_s
        self._tickets: Dict[str, Tuple[str, float]] = {}

    def issue(self, worker_id: str, now: Optional[float] = None) -> str:
        moment = time.monotonic() if now is None else now
        self._prune(moment)
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = (worker_id, moment + self._ttl)
        return ticket

    def redeem(self, ticket: str, worker_id: str, now: Optional[float] = None) -> bool:
        """True exactly once per ticket, and only for the worker it names."""
        moment = time.monotonic() if now is None else now
        entry = self._tickets.pop(ticket, None)
        if entry is None:
            return False
        owner, expires_at = entry
        return owner == worker_id and moment <= expires_at

    def _prune(self, now: float) -> None:
        stale = [t for t, (_, expires_at) in self._tickets.items() if expires_at < now]
        for ticket in stale:
            del self._tickets[ticket]

    def __len__(self) -> int:
        return len(self._tickets)


async def bridge(websocket: WebSocket, target: Target) -> None:
    """Pump bytes between an accepted WebSocket and the worker's VNC port.

    Runs until either side closes. The caller has already accepted the
    socket (with the `binary` subprotocol noVNC asks for) and verified the
    ticket; this only moves bytes and tears down.
    """
    host, port = target
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=CONNECT_TIMEOUT_S
        )
    except (OSError, asyncio.TimeoutError):
        # 1011: "server encountered an unexpected condition". The page shows
        # the reason string, so name the fix.
        await websocket.close(code=1011, reason=f"{host}:{port} is not answering")
        return

    async def ws_to_vnc() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is None and message.get("text") is not None:
                data = message["text"].encode("latin-1", "ignore")
            if data:
                writer.write(data)
                await writer.drain()

    async def vnc_to_ws() -> None:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                return
            await websocket.send_bytes(data)

    tasks = [asyncio.create_task(ws_to_vnc()), asyncio.create_task(vnc_to_ws())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        writer.close()
        try:
            await websocket.close()
        except Exception:
            # Already gone from the other side; nothing to tell it.
            pass
