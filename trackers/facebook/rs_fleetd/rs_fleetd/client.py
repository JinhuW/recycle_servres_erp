"""The agent's three calls to the coordinator: desired state, a config, a report.

Every method answers None (or False) on any failure — refused, unreachable,
slow, malformed — and never raises. The agent reads None as "offline" and
falls back to what it cached; a coordinator outage must never reach the
workers. One attempt each with a short timeout: the loop comes round again in
seconds, so a retry here would only delay the containers' own care.
"""

import http.client
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

TIMEOUT_S = 10


class FleetClient:
    def __init__(
        self: "FleetClient",
        base_url: str,
        host_id: str,
        token: str,
        timeout: float = TIMEOUT_S,
        opener: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.base_url = base_url.strip().rstrip("/")
        self.host_id = host_id
        self.token = token
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    def _host_path(self: "FleetClient", *parts: str) -> str:
        quoted = "/".join(urllib.parse.quote(p, safe="") for p in (self.host_id, *parts))
        return f"/v1/fleet/hosts/{quoted}"

    def desired(self: "FleetClient") -> Optional[Dict[str, Any]]:
        body = self._request("GET", self._host_path("desired"))
        if body is None or not isinstance(body.get("workers"), list):
            return None
        return body

    def config(self: "FleetClient", worker_id: str) -> Optional[Dict[str, Any]]:
        body = self._request("GET", self._host_path("configs", worker_id))
        if body is None or not isinstance(body.get("toml"), str) or not isinstance(body.get("sha256"), str):
            return None
        return body

    def report(self: "FleetClient", payload: Dict[str, Any]) -> bool:
        return self._request("POST", self._host_path("report"), payload) is not None

    def _request(
        self: "FleetClient", method: str, path: str, payload: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
            with self._opener(request, timeout=self.timeout) as response:
                status = int(getattr(response, "status", None) or response.getcode())
                raw = response.read()
        except urllib.error.HTTPError as e:
            logger.warning("%s %s answered HTTP %s", method, path, e.code)
            return None
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
            logger.warning("%s %s failed: %s", method, path, e)
            return None
        if not 200 <= status < 300:
            logger.warning("%s %s answered HTTP %s", method, path, status)
            return None
        try:
            body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except ValueError:
            logger.warning("%s %s answered a body that is not JSON", method, path)
            return None
        return body if isinstance(body, dict) else None
