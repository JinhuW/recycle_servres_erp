"""HTTP client for the coordinator's Messenger endpoints.

Same retry stance as the monitor's coordinator channel, for the same reason:
this runs with a live Playwright page parked on Facebook, so a generous retry
budget freezes the browser, not just the caller. Three attempts with a short
doubling backoff, and a 4xx is an answer — retrying a refused token cannot
help and hides the misconfiguration.
"""

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from .inbox import ThreadSnapshot

logger = logging.getLogger(__name__)

# Statuses that are an answer, not an outage — never retried.
_TERMINAL_STATUSES = (400, 401, 403, 404, 409, 422)

MAX_RETRIES = 3
RETRY_DELAY = 2.0


class CoordinatorError(RuntimeError):
    """The coordinator could not be reached, or refused the request."""


class CoordinatorClient:
    def __init__(
        self: "CoordinatorClient",
        base_url: str | None = None,
        token: str | None = None,
        worker_id: str | None = None,
        timeout: int = 10,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("RS_COORDINATOR_URL") or "").strip().rstrip("/")
        self.token = token or os.environ.get("RS_COORDINATOR_TOKEN")
        self.worker_id = worker_id or os.environ.get("RS_WORKER_ID")
        self.timeout = timeout
        # Injected in tests; urlopen in production.
        self._opener = opener or urllib.request.urlopen

    @property
    def configured(self: "CoordinatorClient") -> bool:
        # The token is as required as the URL: the coordinator 401s a bare
        # request, so a configured URL with no token fails every call forever.
        return bool(self.base_url and self.token and self.worker_id)

    def missing(self: "CoordinatorClient") -> List[str]:
        """Which of the three settings are absent, by env-var name."""
        return [
            name
            for name, value in (
                ("RS_COORDINATOR_URL", self.base_url),
                ("RS_COORDINATOR_TOKEN", self.token),
                ("RS_WORKER_ID", self.worker_id),
            )
            if not value
        ]

    # -- endpoints ---------------------------------------------------------

    def sync_threads(self: "CoordinatorClient", threads: List[ThreadSnapshot]) -> Dict[str, Any]:
        payload = {
            "worker_id": self.worker_id,
            "threads": [thread.to_payload() for thread in threads],
        }
        return self._request("POST", "/v1/messages/sync", payload)

    def fetch_outbound(self: "CoordinatorClient", limit: int = 10) -> List[Dict[str, Any]]:
        body = self._request("GET", f"/v1/messages/outbound?limit={int(limit)}")
        outbound = body.get("outbound", [])
        return outbound if isinstance(outbound, list) else []

    def ack_outbound(
        self: "CoordinatorClient",
        outbound_id: int,
        status: str,
        error: Optional[str] = None,
    ) -> None:
        self._request(
            "POST",
            f"/v1/messages/outbound/{int(outbound_id)}/ack",
            {"status": status, "error": error},
        )

    # -- transport ---------------------------------------------------------

    def _request(
        self: "CoordinatorClient",
        method: str,
        path: str,
        payload: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        if not self.configured:
            raise CoordinatorError(
                "Coordinator is not configured; set " + ", ".join(self.missing())
            )
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
        )

        delay = RETRY_DELAY
        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                with self._opener(request, timeout=self.timeout) as response:
                    body = response.read().decode("utf-8", errors="replace")
                    if 200 <= response.status < 300:
                        try:
                            parsed = json.loads(body) if body else {}
                        except json.JSONDecodeError:
                            parsed = {}
                        return parsed if isinstance(parsed, dict) else {}
                    last_error = CoordinatorError(f"HTTP {response.status} from {url}")
            except urllib.error.HTTPError as e:
                if e.code in _TERMINAL_STATUSES:
                    raise CoordinatorError(
                        f"Coordinator refused {method} {path} with HTTP {e.code} "
                        f"({e.reason}). This will not resolve on its own — check "
                        "RS_COORDINATOR_TOKEN and RS_WORKER_ID."
                    ) from e
                last_error = e
            except (urllib.error.URLError, OSError, ValueError) as e:
                last_error = e

            if attempt < MAX_RETRIES - 1:
                logger.warning(
                    "Coordinator %s %s failed (attempt %d/%d): %s",
                    method,
                    path,
                    attempt + 1,
                    MAX_RETRIES,
                    last_error,
                )
                time.sleep(delay)
                delay *= 2
        raise CoordinatorError(
            f"Coordinator unreachable after {MAX_RETRIES} attempts: {last_error}"
        )
