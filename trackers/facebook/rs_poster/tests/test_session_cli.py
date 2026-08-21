"""The 2FA autofill that `rs-session capture` runs on every poll.

This is the code that replaced a human copying a six-digit number, so the rules
it has to obey are worth pinning down without a browser: submit once per code,
never re-submit a code Facebook has already consumed, and stay silent when the
prompt is not on screen.
"""

import pytest

from rs_poster import totp
from rs_poster.session_cli import (
    _autofill_two_factor,
    _resolve_totp_or_warn,
    _session_files,
)
from rs_poster.cookies import meta_path_for

DEMO_SECRET = "JBSWY3DPEHPK3PXP"
CONFIG = totp.TotpConfig(secret=DEMO_SECRET)

# A timestamp 10 seconds into a 30-second TOTP window.
#
# Without this the suite reads the real clock, and `_autofill_two_factor`
# deliberately declines a code with 3 seconds or less left in its window — so
# for roughly three seconds out of every thirty, five of the tests below failed.
# Because the whole suite runs in under a tenth of a second, a run lands either
# wholly inside that dead zone or wholly outside it: it did not look like
# flakiness, it looked like the suite was broken, and then fine again a moment
# later. It also removes a narrower race in which the window rolls between the
# code the helper generates and the one the assertion compares it to.
#
# 1_700_000_010 is divisible by 30, so it is the first second of a window and
# +10 sits comfortably in the middle of one. (1_700_000_000 is NOT divisible by
# 30 — it is 20 seconds into a window — which is worth stating because getting
# it wrong gives a constant that still passes and no longer tests what it says.)
WINDOW_START = 1_700_000_010
FROZEN_NOW = WINDOW_START + 10


class FrozenClock:
    """Stands in for the `time` module inside rs_poster.totp."""

    @staticmethod
    def time():
        return FROZEN_NOW


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    """Pin the TOTP clock mid-window for every test in this module.

    The <=3s guard keeps its own coverage: it is exercised deliberately by
    `test_waits_out_a_code_that_is_about_to_expire`, which overrides this.
    """
    monkeypatch.setattr(totp, "time", FrozenClock)


class FakeLocator:
    def __init__(self, visible=True, log=None, name="field"):
        self._visible = visible
        self.log = log if log is not None else []
        self.name = name
        self.typed = []

    @property
    def first(self):
        return self

    def is_visible(self, timeout=None):
        return self._visible

    def fill(self, value):
        self.log.append(("fill", value))

    def type(self, value, delay=None):
        self.typed.append(value)
        self.log.append(("type", value))

    def click(self):
        self.log.append(("click", self.name))


class FakeKeyboard:
    def __init__(self, log):
        self.log = log

    def press(self, key):
        self.log.append(("press", key))


class FakePage:
    """Just enough Playwright surface for the autofill helper."""

    def __init__(self, prompt_visible=True, trust_visible=False):
        self.log = []
        self.field = FakeLocator(prompt_visible, self.log, "code")
        self.trust = FakeLocator(trust_visible, self.log, "trust")
        self.keyboard = FakeKeyboard(self.log)

    def locator(self, selector):
        return self.field

    def get_by_role(self, role, name=None):
        return self.trust

    def wait_for_timeout(self, ms):
        pass


def test_submits_the_code_when_the_prompt_is_showing():
    page = FakePage()
    submitted = set()

    assert _autofill_two_factor(page, CONFIG, submitted) is True

    assert len(page.field.typed) == 1
    code = page.field.typed[0]
    assert code == totp.generate(CONFIG)
    assert submitted == {code}
    assert ("press", "Enter") in page.log


def test_does_nothing_when_the_prompt_is_not_on_screen():
    page = FakePage(prompt_visible=False)
    submitted = set()

    assert _autofill_two_factor(page, CONFIG, submitted) is False

    assert page.field.typed == []
    assert submitted == set()


def test_never_submits_the_same_code_twice():
    """Facebook rejects a consumed code, so re-typing one breaks the login."""
    page = FakePage()
    submitted = set()

    assert _autofill_two_factor(page, CONFIG, submitted) is True
    # The capture loop polls every few seconds; the prompt is still up.
    assert _autofill_two_factor(page, CONFIG, submitted) is False
    assert _autofill_two_factor(page, CONFIG, submitted) is False

    assert len(page.field.typed) == 1


def test_submits_again_once_the_window_rolls_over(monkeypatch):
    page = FakePage()
    submitted = set()

    monkeypatch.setattr(totp, "generate", lambda cfg, at=None: "111111")
    assert _autofill_two_factor(page, CONFIG, submitted) is True

    monkeypatch.setattr(totp, "generate", lambda cfg, at=None: "222222")
    assert _autofill_two_factor(page, CONFIG, submitted) is True

    assert page.field.typed == ["111111", "222222"]


def test_waits_out_a_code_that_is_about_to_expire(monkeypatch):
    """A code typed in the last seconds can expire before Facebook reads it."""
    page = FakePage()
    monkeypatch.setattr(totp, "seconds_remaining", lambda cfg, at=None: 2)

    assert _autofill_two_factor(page, CONFIG, set()) is False
    assert page.field.typed == []


def test_clicks_trust_this_device_when_offered():
    page = FakePage(trust_visible=True)

    _autofill_two_factor(page, CONFIG, set())

    assert ("click", "trust") in page.log


def test_a_browser_error_is_reported_not_raised(monkeypatch, capsys):
    page = FakePage()
    monkeypatch.setattr(
        page.field, "type", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("detached"))
    )

    assert _autofill_two_factor(page, CONFIG, set()) is False
    assert "could not submit" in capsys.readouterr().err


def test_a_garbled_stored_secret_warns_instead_of_aborting_capture(tmp_path, capsys):
    state = tmp_path / "tx-1.json"
    meta_path_for(state).write_text('{"totp_secret": "not-base32!"}')

    assert _resolve_totp_or_warn(state) is None
    assert "unusable" in capsys.readouterr().err


def test_session_listing_pairs_each_account_once(tmp_path):
    (tmp_path / "denver-1.json").write_text("{}")
    (tmp_path / "denver-1.json.meta.json").write_text("{}")
    # An account set up but not yet captured: sidecar only.
    (tmp_path / "tx-1.json.meta.json").write_text("{}")

    assert [p.name for p in _session_files(tmp_path)] == [
        "denver-1.json",
        "tx-1.json",
    ]


def test_session_listing_of_a_missing_directory_is_empty(tmp_path):
    assert _session_files(tmp_path / "nope") == []
