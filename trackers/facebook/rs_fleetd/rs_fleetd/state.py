"""What the agent keeps on the host, under RS_FLEET_ROOT.

    desired.json              the last desired state the coordinator served
    adopt.toml                compose containers this agent takes over
    healthcheck.sh            the worker healthcheck, installed for mounting
    workers/<id>/config.toml  each worker's config, bind-mounted into it
    sessions/<id>/            each worker's /data (its Facebook session)

RS_FLEET_ROOT is mounted at the same path in the agent's container as on the
host, because the paths written here are handed to the Docker daemon as bind
mount sources, and the daemon resolves them on the host.
"""

import hashlib
import json
import os
import tomllib
from pathlib import Path
from typing import Any, Dict, Optional

DESIRED_FILE = "desired.json"
ADOPT_FILE = "adopt.toml"
HEALTHCHECK_FILE = "healthcheck.sh"
EMPTY_DESIRED: Dict[str, Any] = {"authoritative": False, "workers": []}


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private(path: Path, text: str, mode: int = 0o600) -> None:
    """Write beside `path` and rename over it, synced on both sides.

    For files nothing has bind-mounted: a reader sees the old file or the new
    one, never half of either, and a power cut cannot leave the name pointing
    at data that never reached the disk. `desired.json` holds every worker's
    bearer token, hence 0600 from the first byte.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.writing")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def write_in_place(path: Path, text: str, mode: int = 0o600) -> bool:
    """Rewrite `path` keeping its inode; False when it already says `text`.

    For a file a running container bind-mounts: Docker binds the inode, so a
    file replaced by rename stays invisible inside the container. The monitor
    hashes its config between jobs and restarts on a change.
    """
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        return True
    with open(path, "r+", encoding="utf-8") as handle:
        if handle.read() == text:
            return False
        handle.seek(0)
        handle.write(text)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())
    return True


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> Optional[str]:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


# -- desired state --------------------------------------------------------------


def save_desired(root: Path, desired: Dict[str, Any]) -> None:
    write_private(root / DESIRED_FILE, json.dumps(desired, indent=1, sort_keys=True))


def load_desired(root: Path) -> Dict[str, Any]:
    """The cached desired state, or an empty non-authoritative one.

    Empty and non-authoritative is the safe reading of "nothing usable": the
    plan then starts nothing new and removes nothing.
    """
    try:
        desired = json.loads((root / DESIRED_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(EMPTY_DESIRED)
    if not isinstance(desired, dict) or not isinstance(desired.get("workers"), list):
        return dict(EMPTY_DESIRED)
    return desired


# -- per-worker paths -----------------------------------------------------------


def config_path(root: Path, worker_id: str) -> Path:
    return root / "workers" / worker_id / "config.toml"


def default_data_dir(root: Path, worker_id: str) -> Path:
    return root / "sessions" / worker_id


def default_cache_volume(worker_id: str) -> str:
    return f"aimm-home-{worker_id}"


# -- adoption -------------------------------------------------------------------

ADOPT_KEYS = ("container", "data_dir", "cache_volume")


def load_adopted(root: Path) -> Dict[str, Dict[str, str]]:
    """`adopt.toml` as {worker_id: {container, data_dir, cache_volume}}.

    An unreadable file adopts nothing rather than failing the tick: the
    workers it named keep running in their compose containers, untouched.
    """
    try:
        with open(root / ADOPT_FILE, "rb") as handle:
            doc = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    out: Dict[str, Dict[str, str]] = {}
    for worker_id, entry in (doc.get("workers") or {}).items():
        if isinstance(entry, dict) and all(isinstance(entry.get(k), str) and entry[k] for k in ADOPT_KEYS):
            out[str(worker_id)] = {k: entry[k] for k in ADOPT_KEYS}
    return out


def save_adopted(root: Path, adopted: Dict[str, Dict[str, str]]) -> None:
    # JSON string literals are valid TOML basic strings, so json.dumps quotes
    # every value safely without a TOML writer.
    lines = [
        "# Compose containers rs-fleetd takes over: each worker keeps its",
        "# session directory and cache volume when its container is recreated.",
    ]
    for worker_id in sorted(adopted):
        lines.append("")
        lines.append(f"[workers.{json.dumps(worker_id)}]")
        for key in ADOPT_KEYS:
            lines.append(f"{key} = {json.dumps(adopted[worker_id][key])}")
    write_private(root / ADOPT_FILE, "\n".join(lines) + "\n", mode=0o644)


# -- healthcheck ----------------------------------------------------------------


def install_healthcheck(root: Path, source: Path) -> Path:
    """Copy the worker healthcheck under the root, where the daemon can mount it.

    `source` is a path inside the agent's container; worker mounts need a host
    path, and the root is the one directory both sides see alike.
    """
    target = root / HEALTHCHECK_FILE
    write_in_place(target, source.read_text(encoding="utf-8"), mode=0o755)
    os.chmod(target, 0o755)
    return target
