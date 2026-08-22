"""Local record of what this account has posted, and the pacing rules.

Facebook does not give us a reliable machine-readable view of our own listings,
so the poster keeps its own ledger in ads/state.json. It is also what enforces
the safety limits: how recently we acted, how many ads are live, and how many
group shares we have done today.
"""

import json
import os
import random
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: str | None) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


@dataclass
class PacingRules:
    min_action_interval_minutes: int = 20
    max_active_ads: int = 3
    max_group_shares_per_day: int = 3
    renew_jitter_days: int = 2

    @classmethod
    def from_config(cls: type["PacingRules"], config: Dict[str, Any]) -> "PacingRules":
        known = {f: config[f] for f in cls.__dataclass_fields__ if f in config}
        return cls(**known)


@dataclass
class AdRecord:
    ad_name: str
    city: str
    title: str
    created_at: str
    last_renewed_at: str
    renew_days: int
    active: bool = True
    group_shares: List[str] = field(default_factory=list)

    @property
    def key(self: "AdRecord") -> str:
        return f"{self.ad_name}@{self.city}"

    def due_for_renewal(self: "AdRecord", jitter_days: int = 0) -> bool:
        renewed = parse_ts(self.last_renewed_at)
        if renewed is None:
            return True
        # Jitter keeps a fleet of ads from all refreshing on the same cadence.
        offset = random.uniform(-jitter_days, jitter_days) if jitter_days else 0
        return utcnow() >= renewed + timedelta(days=self.renew_days + offset)


class PosterState:
    def __init__(self: "PosterState", path: str | Path, pacing: PacingRules | None = None) -> None:
        self.path = Path(path)
        self.pacing = pacing or PacingRules()
        self.ads: Dict[str, AdRecord] = {}
        self.last_action_at: Optional[str] = None
        self.share_log: List[str] = []
        self.load()

    def load(self: "PosterState") -> None:
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text())
        self.last_action_at = data.get("last_action_at")
        self.share_log = data.get("share_log", [])
        for key, record in data.get("ads", {}).items():
            self.ads[key] = AdRecord(**record)

    def save(self: "PosterState") -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "last_action_at": self.last_action_at,
            "share_log": self.share_log,
            "ads": {key: asdict(record) for key, record in self.ads.items()},
        }
        # Temp file + rename: this ledger is the only record of what the
        # account has posted, and a write interrupted mid-json would lose it.
        tmp = self.path.parent / f".{self.path.name}.tmp-{os.getpid()}"
        try:
            tmp.write_text(json.dumps(payload, indent=2))
            os.replace(tmp, self.path)
        finally:
            tmp.unlink(missing_ok=True)

    # -- pacing ------------------------------------------------------------

    def seconds_until_next_action(self: "PosterState") -> float:
        last = parse_ts(self.last_action_at)
        if last is None:
            return 0.0
        ready = last + timedelta(minutes=self.pacing.min_action_interval_minutes)
        return max(0.0, (ready - utcnow()).total_seconds())

    def record_action(self: "PosterState") -> None:
        self.last_action_at = utcnow().isoformat(timespec="seconds")

    def active_ads(self: "PosterState") -> List[AdRecord]:
        return [record for record in self.ads.values() if record.active]

    def can_create_ad(self: "PosterState") -> bool:
        return len(self.active_ads()) < self.pacing.max_active_ads

    def shares_today(self: "PosterState") -> int:
        today = utcnow().date().isoformat()
        return sum(1 for stamp in self.share_log if stamp.startswith(today))

    def can_share_to_group(self: "PosterState") -> bool:
        return self.shares_today() < self.pacing.max_group_shares_per_day

    def record_share(self: "PosterState") -> None:
        self.share_log.append(utcnow().isoformat(timespec="seconds"))
        # Keep the log from growing without bound; only today's entries matter.
        cutoff = (utcnow() - timedelta(days=7)).isoformat(timespec="seconds")
        self.share_log = [stamp for stamp in self.share_log if stamp >= cutoff]

    # -- ad records --------------------------------------------------------

    def get(self: "PosterState", ad_name: str, city: str) -> Optional[AdRecord]:
        return self.ads.get(f"{ad_name}@{city}")

    def upsert(self: "PosterState", record: AdRecord) -> None:
        self.ads[record.key] = record

    def mark_inactive(self: "PosterState", ad_name: str, city: str) -> None:
        record = self.get(ad_name, city)
        if record:
            record.active = False

    def due_for_renewal(self: "PosterState") -> List[AdRecord]:
        return [
            record
            for record in self.active_ads()
            if record.due_for_renewal(self.pacing.renew_jitter_days)
        ]
