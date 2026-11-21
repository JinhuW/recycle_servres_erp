"""Read-only probes tests use to observe the coordinator's tables.

Production code never needs these questions answered, so they live here
rather than on `Database` / `PostgresDatabase`. Each one goes through the
handle's own `cursor()` and works against either backend: both cursors return
rows that index by column name, and only the placeholder differs.
"""

from typing import Any, Dict, List

from rs_coordinator.db import Database


def _ph(db: Any) -> str:
    """The parameter placeholder for this handle's dialect."""
    return "?" if isinstance(db, Database) else "%s"


def count_sightings(db: Any, dedupe_key: str) -> int:
    """How many times any worker has reported this listing."""
    with db.cursor() as cur:
        cur.execute(
            f"SELECT COUNT(*) AS n FROM sightings WHERE dedupe_key = {_ph(db)}", (dedupe_key,)
        )
        return int(cur.fetchone()["n"])


def list_code_audit(db: Any) -> List[Dict[str, Any]]:
    """The code/credential release audit log, newest first."""
    with db.cursor() as cur:
        cur.execute("SELECT * FROM code_audit ORDER BY released_at DESC")
        return [dict(row) for row in cur.fetchall()]
