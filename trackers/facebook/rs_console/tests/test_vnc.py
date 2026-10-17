"""The VNC bridge: ticketed, allowlisted, and a faithful byte pump.

What must stay true: a worker outside RS_VNC_TARGETS cannot be reached (no
page, no ticket, no socket); a ticket needs the console token to mint, is
good for one connection, and only for the worker it names; the bearer token
itself is never part of the socket URL; and once accepted, bytes cross the
bridge unchanged in both directions.
"""

import socket
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import rs_console.app as console
from rs_console import vnc

AUTH = {"Authorization": "Bearer console-token"}


@pytest.fixture()
def echo_server():
    """A TCP echo on 127.0.0.1 standing in for a worker's x11vnc."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    server.settimeout(0.2)
    port = server.getsockname()[1]
    stop = threading.Event()

    def serve():
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            with conn:
                # Greet like a VNC server would, then echo.
                conn.sendall(b"RFB 003.008\n")
                while True:
                    data = conn.recv(65536)
                    if not data:
                        break
                    conn.sendall(data)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    yield port
    stop.set()
    thread.join(timeout=2)
    server.close()


@pytest.fixture()
def client(monkeypatch, echo_server):
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")
    monkeypatch.setenv(
        "RS_VNC_TARGETS",
        f"homelab-1=127.0.0.1:{echo_server}, homelab-ne=127.0.0.1:1, broken=nowhere",
    )
    monkeypatch.delenv("RS_CONSOLE_PUBLIC_URL", raising=False)
    return TestClient(console.app)


# ── Config parsing ────────────────────────────────────────────────────────────


def test_targets_parse_and_skip_malformed_entries():
    parsed = vnc.parse_targets(
        "homelab-1=rs-monitor:5900,\n homelab-ne=rs-monitor-ne:5900, junk, x=host:notaport, y=:5900"
    )
    assert parsed == {"homelab-1": ("rs-monitor", 5900), "homelab-ne": ("rs-monitor-ne", 5900)}
    assert vnc.parse_targets(None) == {}


def test_page_url_is_relative_unless_a_public_base_is_set():
    assert vnc.page_url("homelab-1", None) == "/vnc/homelab-1"
    assert vnc.page_url("homelab-1", "https://fbc.example.com/") == "https://fbc.example.com/vnc/homelab-1"


# ── Tickets ───────────────────────────────────────────────────────────────────


def test_ticket_is_single_use_worker_bound_and_expiring():
    store = vnc.TicketStore(ttl_s=10)
    ticket = store.issue("homelab-1", now=100.0)
    assert not store.redeem(ticket, "homelab-ne", now=101.0)  # wrong worker burns it
    ticket = store.issue("homelab-1", now=100.0)
    assert store.redeem(ticket, "homelab-1", now=105.0)
    assert not store.redeem(ticket, "homelab-1", now=105.0)  # second use
    ticket = store.issue("homelab-1", now=100.0)
    assert not store.redeem(ticket, "homelab-1", now=111.0)  # expired
    assert not store.redeem("never-issued", "homelab-1")


def test_expired_tickets_are_pruned_on_issue():
    store = vnc.TicketStore(ttl_s=10)
    for _ in range(5):
        store.issue("homelab-1", now=0.0)
    assert len(store) == 5
    store.issue("homelab-1", now=100.0)
    assert len(store) == 1


def test_ticket_route_needs_the_console_token(client):
    assert client.post("/v1/vnc/homelab-1/ticket").status_code == 401
    res = client.post("/v1/vnc/homelab-1/ticket", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["worker_id"] == "homelab-1"
    assert body["path"] == f"/v1/vnc/homelab-1/ws?ticket={body['ticket']}"
    assert "console-token" not in body["path"]


def test_unlisted_worker_has_no_page_and_no_ticket(client):
    assert client.get("/vnc/unknown").status_code == 404
    assert client.post("/v1/vnc/unknown/ticket", headers=AUTH).status_code == 404
    # Malformed entry never became a target.
    assert client.post("/v1/vnc/broken/ticket", headers=AUTH).status_code == 404


def test_page_is_served_for_a_listed_worker(client):
    res = client.get("/vnc/homelab-1")
    assert res.status_code == 200
    assert "/static/vnc.js" in res.text
    # The viewer library ships with the package.
    assert client.get("/static/novnc/core/rfb.js").status_code == 200


# ── The socket ────────────────────────────────────────────────────────────────


def test_socket_refuses_without_a_valid_ticket(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/v1/vnc/homelab-1/ws"):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/v1/vnc/homelab-1/ws?ticket=forged"):
            pass
    # The console token is not a ticket.
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/v1/vnc/homelab-1/ws?ticket=console-token"):
            pass


def test_ticket_for_one_worker_does_not_open_another(client):
    ticket = client.post("/v1/vnc/homelab-1/ticket", headers=AUTH).json()["ticket"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/v1/vnc/homelab-ne/ws?ticket={ticket}"):
            pass


def test_bridge_pumps_bytes_both_ways_with_the_binary_subprotocol(client):
    grant = client.post("/v1/vnc/homelab-1/ticket", headers=AUTH).json()
    with client.websocket_connect(grant["path"], subprotocols=["binary"]) as ws:
        assert ws.accepted_subprotocol == "binary"
        assert ws.receive_bytes() == b"RFB 003.008\n"
        ws.send_bytes(b"RFB 003.008\n")
        assert ws.receive_bytes() == b"RFB 003.008\n"
        payload = bytes(range(256)) * 300
        ws.send_bytes(payload)
        got = b""
        while len(got) < len(payload):
            got += ws.receive_bytes()
        assert got == payload

    # The ticket was consumed by that connection.
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(grant["path"]):
            pass


def test_bridge_names_no_subprotocol_unless_the_client_offered_one(client):
    # noVNC 1.7 offers none; naming one anyway makes browsers fail the
    # handshake ("Response must not include 'Sec-WebSocket-Protocol'").
    grant = client.post("/v1/vnc/homelab-1/ticket", headers=AUTH).json()
    with client.websocket_connect(grant["path"]) as ws:
        assert ws.accepted_subprotocol is None
        assert ws.receive_bytes() == b"RFB 003.008\n"


def test_unreachable_worker_closes_with_a_reason(client):
    grant = client.post("/v1/vnc/homelab-ne/ticket", headers=AUTH).json()
    with client.websocket_connect(grant["path"]) as ws:
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_bytes()
    assert info.value.code == 1011
    assert "127.0.0.1:1" in (info.value.reason or "")


# ── Fleet document ────────────────────────────────────────────────────────────


def test_fleet_document_links_listed_workers_to_the_viewer(client, monkeypatch, tmp_path):
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(tmp_path / "monitor.toml"))
    monkeypatch.setenv("RS_FLEET_CONFIG", str(tmp_path / "fleet.toml"))
    monkeypatch.setenv("RS_MASTER_CONFIG", str(tmp_path / "missing.toml"))
    monkeypatch.setenv("RS_WORKER_ID", "homelab-1")
    (tmp_path / "monitor.toml").write_text(
        '[marketplace.facebook]\nsearch_city = ["dc"]\nvnc_url = "vnc://old-note"\n'
    )
    (tmp_path / "fleet.toml").write_text(
        '[worker.homelab-ne]\nregion = "rs_northeast"\n\n'
        '[worker.wc-1]\nregion = "rs_west"\nvnc_url = "https://elsewhere.example/wc"\n'
    )

    import httpx

    async def upstream(request):
        return httpx.Response(200, json={"workers": [], "accounts": []})

    real = httpx.AsyncClient

    class Fake(real):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(upstream)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", Fake)

    doc = client.get("/v1/fleet", headers=AUTH).json()
    by_id = {w["worker_id"]: w for w in doc["workers"]}
    # The console's own page wins over a note in config.
    assert by_id["homelab-1"]["vnc_url"] == "/vnc/homelab-1"
    assert by_id["homelab-1"]["vnc_live"] is True
    assert by_id["homelab-ne"]["vnc_url"] == "/vnc/homelab-ne"
    # A worker the console cannot reach keeps whatever config said.
    assert by_id["wc-1"]["vnc_url"] == "https://elsewhere.example/wc"
    assert by_id["wc-1"]["vnc_live"] is False

    monkeypatch.setenv("RS_CONSOLE_PUBLIC_URL", "https://fbc.example.com")
    doc = client.get("/v1/fleet", headers=AUTH).json()
    by_id = {w["worker_id"]: w for w in doc["workers"]}
    assert by_id["homelab-1"]["vnc_url"] == "https://fbc.example.com/vnc/homelab-1"
