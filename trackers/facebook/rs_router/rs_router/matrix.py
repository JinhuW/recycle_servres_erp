"""A thin Matrix Client-Server API client — just what the router needs.

Four operations: prove who we are (whoami), long-poll for new events (sync),
read a portal's bridge state (room state), and send a reply into a room. Kept
deliberately small and synchronous, over stdlib urllib, so the container has no
Matrix SDK to track — the bridges do the hard Messenger protocol work, this
only shuttles events.

Authentication is a pre-provisioned access token (MATRIX_ROUTER_TOKEN): the
router bot is created once on the homeserver and its token pasted in, the same
one-time-setup stance mautrix-meta itself uses for the Facebook session.
"""

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class MatrixError(RuntimeError):
    """The homeserver could not be reached, or refused the request."""


class MatrixClient:
    def __init__(
        self: "MatrixClient",
        homeserver: str,
        access_token: str,
        timeout: int = 60,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.homeserver = (homeserver or "").strip().rstrip("/")
        self.access_token = access_token
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen
        self._txn = 0

    @property
    def configured(self: "MatrixClient") -> bool:
        return bool(self.homeserver and self.access_token)

    # -- endpoints ---------------------------------------------------------

    def whoami(self: "MatrixClient") -> str:
        body = self._request("GET", "/_matrix/client/v3/account/whoami")
        user_id = body.get("user_id")
        if not user_id:
            raise MatrixError("whoami returned no user_id; is the access token valid?")
        return str(user_id)

    def sync(
        self: "MatrixClient", since: Optional[str] = None, timeout_ms: int = 30000
    ) -> Dict[str, Any]:
        """One /sync. Pass the previous response's `next_batch` as `since`.

        A first sync (no `since`) returns current room state and a bounded tail
        of each timeline; later syncs long-poll for `timeout_ms` and return only
        what changed.
        """
        params = {"timeout": str(timeout_ms), "full_state": "false"}
        if since:
            params["since"] = since
        return self._request("GET", "/_matrix/client/v3/sync", params=params)

    def room_state(self: "MatrixClient", room_id: str) -> List[Dict[str, Any]]:
        """All state events of a room — where the bridge writes the FB thread id."""
        path = f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id)}/state"
        body = self._request("GET", path)
        # This endpoint returns a bare JSON array; _request wraps a non-dict
        # response as {"_list": [...]}.
        events = body.get("_list", body)
        return events if isinstance(events, list) else []

    def send_text(self: "MatrixClient", room_id: str, body: str) -> str:
        """Send a plain-text message into a room; returns the event id."""
        self._txn += 1
        txn_id = f"rsrouter-{self._txn}"
        path = (
            f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id)}"
            f"/send/m.room.message/{txn_id}"
        )
        result = self._request(
            "PUT", path, payload={"msgtype": "m.text", "body": body}
        )
        return str(result.get("event_id", ""))

    # -- transport ---------------------------------------------------------

    def _request(
        self: "MatrixClient",
        method: str,
        path: str,
        payload: Dict[str, Any] | None = None,
        params: Dict[str, str] | None = None,
    ) -> Dict[str, Any]:
        if not self.configured:
            raise MatrixError("Matrix client is not configured (homeserver / token)")
        url = f"{self.homeserver}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.access_token}",
            },
        )
        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
            raise MatrixError(f"{method} {path} -> HTTP {e.code}: {detail[:200]}") from e
        except (urllib.error.URLError, OSError) as e:
            raise MatrixError(f"{method} {path} failed: {e}") from e
        if not raw:
            return {}
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return {"_list": parsed}
        return parsed if isinstance(parsed, dict) else {}
