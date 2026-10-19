"""`is_visible(timeout=…)` never waits: Playwright ignores the argument.

Every such call was an instant snapshot that read like a wait. The ones that
meant to wait now use `wait_for`; the ones that meant a snapshot say so by
passing nothing. This keeps the misleading form from coming back.
"""

import re
from pathlib import Path

DEAD_TIMEOUT = re.compile(r"\.is_(visible|hidden|enabled|disabled|checked|editable)\(\s*timeout")
PACKAGES = ("rs_poster/rs_poster", "rs_messenger/rs_messenger")


def test_no_state_check_passes_a_timeout():
    root = Path(__file__).resolve().parents[2]
    offenders = [
        f"{path.relative_to(root)}:{number}"
        for package in PACKAGES
        for path in (root / package).glob("*.py")
        for number, line in enumerate(path.read_text().splitlines(), 1)
        if DEAD_TIMEOUT.search(line)
    ]
    assert offenders == []
