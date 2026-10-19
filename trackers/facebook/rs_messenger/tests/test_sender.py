"""Send verification: a reply is "sent" only when the pane shows our bubble."""

from typing import Any, Dict, List

import pytest

from rs_messenger import sender
from rs_messenger.sender import (
    ERR_COMPOSER_MISSING,
    ERR_NOT_SUBMITTED,
    ERR_NOT_VISIBLE,
    PERMANENT_ERRORS,
    already_sent,
    count_out_rows,
    make_probe,
    reply_landed,
    send_message,
)

REPLY = "Hi! Still available? I can pick up the whole lot tomorrow if the price works."
PROBE = make_probe(REPLY)


def out(text: str) -> Dict[str, str]:
    return {"text": text, "direction": "out"}


def inc(text: str) -> Dict[str, str]:
    return {"text": text, "direction": "in"}


# -- pure helpers -------------------------------------------------------------


def test_probe_is_the_whitespace_collapsed_head_of_the_reply():
    assert make_probe("  Hi!\n\nStill   available? ") == "Hi! Still available?"
    assert len(make_probe("x" * 200)) == 60


def test_only_outgoing_rows_count_and_matching_ignores_case_and_wrapping():
    rows = [inc(REPLY), out(REPLY.upper()), out("hi!\nstill  available? i can pick up the whole lot tomorrow if the price works.")]
    assert count_out_rows(rows, PROBE) == 2
    assert count_out_rows(rows, "") == 0


def test_reply_landed_needs_a_new_outgoing_bubble():
    before = [inc("Is it still for sale?")]
    assert reply_landed(before, before + [out(REPLY)], PROBE, "")
    # The same text appearing as an incoming row (the composer draft when it
    # is read as a pane row) is not our bubble.
    assert not reply_landed(before, before + [inc(REPLY)], PROBE, "")


def test_an_older_identical_bubble_does_not_count():
    before = [out(REPLY), inc("ok")]
    assert not reply_landed(before, before, PROBE, "")
    assert reply_landed(before, before + [out(REPLY)], PROBE, "")


def test_a_draft_still_in_the_composer_is_not_landed():
    before: List[Dict[str, Any]] = []
    assert not reply_landed(before, [out(REPLY)], PROBE, REPLY)


def test_already_sent_looks_only_at_the_latest_message():
    assert already_sent([inc("hello"), out(REPLY), out("Sent"), inc("10:42 AM")], PROBE)
    # The seller answered since: a repeat is a new message, not a lost ack.
    assert not already_sent([out(REPLY), inc("Yes, come by")], PROBE)
    assert not already_sent([inc(REPLY)], PROBE)
    assert not already_sent([], PROBE)


def test_composer_missing_is_the_only_permanent_error():
    assert PERMANENT_ERRORS == {ERR_COMPOSER_MISSING}


# -- send_message against a fake page -----------------------------------------


class FakeKeyboard:
    def __init__(self, page: "FakePage"):
        self.page = page
        self.pressed: List[str] = []

    def press(self, key: str) -> None:
        self.pressed.append(key)
        if key == "Enter":
            self.page.on_enter()
        elif key == "Control+A":
            self.page.selected = True
        elif key == "Backspace" and self.page.selected:
            self.page.composer_text = ""
            self.page.selected = False


class FakeLocator:
    def __init__(self, page: "FakePage", present: bool = True):
        self.page = page
        self.present = present
        self.typed: List[str] = []

    @property
    def first(self) -> "FakeLocator":
        return self

    def count(self) -> int:
        return 1 if self.present else 0

    def wait_for(self, timeout: int = 0) -> None:
        if not self.present:
            raise TimeoutError("not visible")

    def click(self) -> None:
        pass

    def type(self, text: str, delay: int = 0) -> None:
        self.typed.append(text)
        self.page.composer_text += text

    def inner_text(self) -> str:
        return self.page.composer_text


class FakePage:
    """Just enough Messenger: a composer buffer and a scripted pane.

    `on_enter` decides what Facebook does with the keystroke: post the draft
    as our bubble (the happy path) or swallow it (the bug this guards).
    """

    def __init__(self, rows: List[Dict[str, str]], composer: bool = True, submits: bool = True):
        self.rows = list(rows)
        self.composer_text = ""
        self.selected = False
        self.submits = submits
        self.keyboard = FakeKeyboard(self)
        self.composer = FakeLocator(self, present=composer)
        self.url = "https://www.facebook.com/messages/t/1"

    def on_enter(self) -> None:
        if self.submits and self.composer_text:
            self.rows.append(out(self.composer_text))
            self.composer_text = ""

    def goto(self, url: str, timeout: int = 0) -> None:
        pass

    def wait_for_load_state(self, state: str) -> None:
        pass

    def get_by_role(self, role: str, name: Any = None) -> FakeLocator:
        return self.composer

    def locator(self, selector: str) -> FakeLocator:
        return self.composer

    def evaluate(self, js: str) -> List[Dict[str, str]]:
        return list(self.rows)


@pytest.fixture(autouse=True)
def instant(monkeypatch):
    monkeypatch.setattr(sender, "human_pause", lambda *a, **k: None)
    monkeypatch.setattr(sender, "raise_if_restricted", lambda *a, **k: None)
    monkeypatch.setattr(sender.time, "sleep", lambda s: None)
    monkeypatch.setattr(sender, "VERIFY_TIMEOUT_S", 0.0)
    monkeypatch.setattr(sender, "_last_send_at", 0.0)


def test_a_reply_that_posts_as_our_bubble_is_sent():
    page = FakePage([inc("Is it still for sale?")])
    assert send_message(page, "1", REPLY) == (True, None)
    assert page.rows[-1] == out(REPLY)
    assert page.composer_text == ""


def test_a_swallowed_enter_is_not_sent_and_the_draft_is_cleared():
    page = FakePage([inc("Is it still for sale?")], submits=False)
    assert send_message(page, "1", REPLY) == (False, ERR_NOT_SUBMITTED)
    assert page.composer_text == ""
    assert page.keyboard.pressed[-2:] == ["Control+A", "Backspace"]


def test_an_older_identical_bubble_cannot_vouch_for_a_swallowed_enter():
    # The bug: the first 60 chars were on the page already, so the old check
    # acked the reply as sent while the draft sat in the composer.
    page = FakePage([out(REPLY), inc("Yes, come by")], submits=False)
    assert send_message(page, "1", REPLY) == (False, ERR_NOT_SUBMITTED)


def test_a_bubble_already_at_the_foot_of_the_pane_is_not_sent_twice():
    page = FakePage([inc("Is it still for sale?"), out(REPLY), out("Sent")])
    assert send_message(page, "1", REPLY) == (True, None)
    assert page.composer.typed == []
    assert "Enter" not in page.keyboard.pressed


def test_an_empty_composer_without_a_bubble_is_reported_as_not_visible():
    page = FakePage([inc("hello")], submits=False)
    # Enter cleared the draft (so nothing to clear) but no bubble appeared.
    page.on_enter = lambda: setattr(page, "composer_text", "")
    assert send_message(page, "1", REPLY) == (False, ERR_NOT_VISIBLE)


def test_a_missing_composer_is_a_permanent_failure():
    page = FakePage([], composer=False)
    sent, error = send_message(page, "1", REPLY)
    assert (sent, error) == (False, ERR_COMPOSER_MISSING)
    assert error in PERMANENT_ERRORS
