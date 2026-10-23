"""Where a TelegramNotifier send lands: chat, and forum topic (RS-372)."""

import importlib
from urllib import parse

import pytest

from rs_coordinator import deps, telegram_notify
from rs_coordinator.telegram_notify import TelegramNotifier


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def sent(monkeypatch):
    fields = []

    def urlopen(url, data=None, timeout=None):
        fields.append(dict(parse.parse_qsl(data.decode())))
        return _Response()

    monkeypatch.setattr(telegram_notify.request, "urlopen", urlopen)
    return fields


def test_a_default_topic_is_used_when_the_caller_names_none(sent):
    notifier = TelegramNotifier("t", "-100", min_interval=0, thread_id=13)

    assert notifier.send("worker down")
    assert notifier.send("buyer topic", message_thread_id=7)

    assert [(f["chat_id"], f["message_thread_id"]) for f in sent] == [("-100", "13"), ("-100", "7")]


def test_no_default_topic_means_general(sent):
    TelegramNotifier("t", "-100", min_interval=0).send("listing")

    assert "message_thread_id" not in sent[0]


@pytest.fixture
def reload_deps():
    yield
    # The env is back as it was by now (monkeypatch undoes first); rebuild the
    # module-level notifiers from it so later tests see the usual ones.
    importlib.reload(deps)


def test_ops_alerts_go_to_the_ops_chat_and_its_topic(monkeypatch, reload_deps):
    monkeypatch.setenv("TELEGRAM_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-100-listings")
    monkeypatch.setenv("TELEGRAM_OPS_CHAT_ID", "-100-ops")
    monkeypatch.setenv("TELEGRAM_TOPIC_OPS", "13")
    importlib.reload(deps)

    assert (deps.ops_notifier.chat_id, deps.ops_notifier.thread_id) == ("-100-ops", 13)
    assert (deps.notifier.chat_id, deps.notifier.thread_id) == ("-100-listings", None)


def test_without_an_ops_chat_ops_alerts_stay_in_the_listings_chat(monkeypatch, reload_deps):
    monkeypatch.setenv("TELEGRAM_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-100-listings")
    monkeypatch.delenv("TELEGRAM_OPS_CHAT_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_TOPIC_OPS", raising=False)
    importlib.reload(deps)

    assert (deps.ops_notifier.chat_id, deps.ops_notifier.thread_id) == ("-100-listings", None)
