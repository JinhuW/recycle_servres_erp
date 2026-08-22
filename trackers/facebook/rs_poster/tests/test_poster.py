"""Poster safety rules: pacing, active-ad caps, photo validation, config loading.

The browser-driving code is covered by `rs-poster post --dry-run` against a
real session, not here; these tests pin the logic that decides *whether* to act.
"""

from datetime import timedelta
from pathlib import Path

import pytest

from rs_poster.cli import load_ads, selected_targets
from rs_poster.photo_library import PhotoLibrary, PhotoLibraryError
from rs_poster.poster import AdTemplate, PostingError
from rs_poster.session import SessionLockedError, account_lock
from rs_poster.state import AdRecord, PacingRules, PosterState, utcnow

ADS_DIR = Path(__file__).resolve().parents[1] / "ads"


def make_record(ad_name="buy_servers", city="Denver, CO", days_ago=0, renew_days=7):
    stamp = (utcnow() - timedelta(days=days_ago)).isoformat(timespec="seconds")
    return AdRecord(
        ad_name=ad_name,
        city=city,
        title="We Buy Used Servers",
        created_at=stamp,
        last_renewed_at=stamp,
        renew_days=renew_days,
    )


# -- pacing ----------------------------------------------------------------


def test_action_interval_is_enforced(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(min_action_interval_minutes=20))
    assert state.seconds_until_next_action() == 0

    state.record_action()
    remaining = state.seconds_until_next_action()
    assert 0 < remaining <= 20 * 60


def test_active_ad_cap_blocks_further_creates(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(max_active_ads=2))
    assert state.can_create_ad()

    state.upsert(make_record(city="Denver, CO"))
    state.upsert(make_record(city="Boulder, CO"))
    assert not state.can_create_ad()

    # Deleting one frees a slot.
    state.mark_inactive("buy_servers", "Boulder, CO")
    assert state.can_create_ad()


def test_group_share_daily_cap(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(max_group_shares_per_day=2))
    assert state.can_share_to_group()
    state.record_share()
    state.record_share()
    assert not state.can_share_to_group()
    assert state.shares_today() == 2


def test_old_shares_do_not_count_against_today(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(max_group_shares_per_day=1))
    state.share_log = [(utcnow() - timedelta(days=3)).isoformat(timespec="seconds")]
    assert state.shares_today() == 0
    assert state.can_share_to_group()


def test_renewal_is_due_only_after_the_interval(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(renew_jitter_days=0))
    state.upsert(make_record(days_ago=1, renew_days=7))
    assert state.due_for_renewal() == []

    state.upsert(make_record(days_ago=9, renew_days=7))
    assert len(state.due_for_renewal()) == 1


def test_inactive_ads_are_never_renewed(tmp_path):
    state = PosterState(tmp_path / "state.json", PacingRules(renew_jitter_days=0))
    state.upsert(make_record(days_ago=30))
    state.mark_inactive("buy_servers", "Denver, CO")
    assert state.due_for_renewal() == []


def test_state_round_trips_to_disk(tmp_path):
    path = tmp_path / "state.json"
    state = PosterState(path)
    state.upsert(make_record())
    state.record_action()
    state.record_share()
    state.save()

    reloaded = PosterState(path)
    assert len(reloaded.ads) == 1
    assert reloaded.last_action_at == state.last_action_at
    assert reloaded.shares_today() == 1


# -- account lock ----------------------------------------------------------


def test_account_lock_is_exclusive(tmp_path):
    lock = tmp_path / "fb.lock"
    with account_lock(lock):
        assert lock.exists()
        with pytest.raises(SessionLockedError):
            with account_lock(lock):
                pass
    assert not lock.exists()


def test_account_lock_releases_on_error(tmp_path):
    lock = tmp_path / "fb.lock"
    with pytest.raises(ValueError):
        with account_lock(lock):
            raise ValueError("boom")
    assert not lock.exists()


# -- photo library ---------------------------------------------------------


def test_missing_photos_are_reported(tmp_path):
    (tmp_path / "photos").mkdir()
    (tmp_path / "manifest.toml").write_text(
        '[photo_set.demo]\nfiles = ["there.jpg", "gone.jpg"]\n'
    )
    (tmp_path / "photos" / "there.jpg").write_bytes(b"x")

    library = PhotoLibrary(tmp_path)
    with pytest.raises(PhotoLibraryError, match="missing files"):
        library.resolve("demo")
    assert "demo" in library.validate_all()


def test_photo_count_is_capped_at_ten(tmp_path):
    (tmp_path / "photos").mkdir()
    names = [f"p{i}.jpg" for i in range(15)]
    for name in names:
        (tmp_path / "photos" / name).write_bytes(b"x")
    files = ", ".join(f'"{name}"' for name in names)
    (tmp_path / "manifest.toml").write_text(f"[photo_set.big]\nfiles = [{files}]\n")

    assert len(PhotoLibrary(tmp_path).resolve("big")) == 10


def test_unknown_photo_set_names_the_known_ones(tmp_path):
    (tmp_path / "photos").mkdir()
    (tmp_path / "manifest.toml").write_text('[photo_set.real]\nfiles = ["a.jpg"]\n')
    with pytest.raises(PhotoLibraryError, match="real"):
        PhotoLibrary(tmp_path).get("imaginary")


# -- ad config -------------------------------------------------------------


def test_shipped_ads_config_loads():
    ads, pacing = load_ads(ADS_DIR / "ads.toml")
    assert "buy_servers" in ads
    assert pacing.max_active_ads == 3
    assert pacing.min_action_interval_minutes == 20

    ad = ads["buy_servers"]
    assert ad.cities
    # The copy has to say we are buying, or the ad reads as a sale.
    assert "buy" in ad.description.lower()


def test_ads_reference_defined_photo_sets():
    ads, _ = load_ads(ADS_DIR / "ads.toml")
    library = PhotoLibrary(ADS_DIR)
    for ad in ads.values():
        assert ad.photo_set in library.set_names, f"{ad.name} -> {ad.photo_set}"


def test_incomplete_ad_template_is_rejected():
    with pytest.raises(PostingError, match="missing required fields"):
        AdTemplate.from_config("broken", {"title": "x"})


def test_target_selection_filters_and_validates():
    ads, _ = load_ads(ADS_DIR / "ads.toml")

    all_targets = selected_targets(ads, None, None)
    assert len(all_targets) == sum(len(ad.cities) for ad in ads.values())

    denver = selected_targets(ads, "buy_servers", "Denver, CO")
    assert denver == [(ads["buy_servers"], "Denver, CO")]

    with pytest.raises(PostingError, match="Unknown ad"):
        selected_targets(ads, "nope", None)
    with pytest.raises(PostingError, match="No ad/city"):
        selected_targets(ads, "buy_servers", "Atlantis, XX")


# -- stale locks -----------------------------------------------------------


def test_stale_lock_with_dead_pid_is_broken(tmp_path):
    import subprocess
    import sys

    proc = subprocess.Popen([sys.executable, "-c", ""])
    proc.wait()
    lock = tmp_path / "fb.lock"
    lock.write_text(str(proc.pid))

    with account_lock(lock):  # a hard-killed run must not block forever
        assert lock.exists()
    assert not lock.exists()


def test_malformed_lock_file_counts_as_stale(tmp_path):
    lock = tmp_path / "fb.lock"
    lock.write_text("not a pid")
    with account_lock(lock):
        assert lock.exists()


def test_lock_held_by_a_live_process_still_blocks(tmp_path):
    import os

    lock = tmp_path / "fb.lock"
    lock.write_text(str(os.getpid()))
    with pytest.raises(SessionLockedError, match=str(os.getpid())):
        with account_lock(lock):
            pass


# -- atomic writes ---------------------------------------------------------


def test_interrupted_state_save_leaves_the_old_ledger_intact(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    state = PosterState(path)
    state.upsert(make_record())
    state.save()
    before = path.read_text()

    monkeypatch.setattr(Path, "write_text", _raise_io_error)
    with pytest.raises(IOError):
        state.save()
    monkeypatch.undo()

    assert path.read_text() == before
    assert list(tmp_path.glob(".state.json.tmp-*")) == []


def _raise_io_error(self, *args, **kwargs):
    raise IOError("disk full")


def test_atomic_write_text_is_owner_only_and_leaves_no_temp(tmp_path):
    from rs_poster.cookies import atomic_write_text

    path = tmp_path / "cred.json"
    path.write_text("old")
    atomic_write_text(path, "new")
    assert path.read_text() == "new"
    assert (path.stat().st_mode & 0o777) == 0o600
    assert list(tmp_path.glob(".cred.json.tmp-*")) == []


# -- session save gating ---------------------------------------------------


class _FakeContext:
    def __init__(self, cookies):
        self._cookies = cookies

    def cookies(self):
        return self._cookies

    def storage_state(self, indexed_db=False):
        return {"cookies": self._cookies, "origins": []}


class _FakeSessionPage:
    def __init__(self, url, context):
        self.url = url
        self.context = context

    def evaluate(self, script):
        return "test-agent"


def _session_with(tmp_path, url, cookies):
    from rs_poster.session import PosterSession

    session = PosterSession(storage_state_path=str(tmp_path / "fb_state.json"))
    session._context = _FakeContext(cookies)
    session.page = _FakeSessionPage(url, session._context)
    return session


def test_logged_out_run_does_not_overwrite_the_session_file(tmp_path):
    path = tmp_path / "fb_state.json"
    path.write_text('{"cookies": [{"name": "xs", "value": "live"}]}')

    session = _session_with(tmp_path, "https://www.facebook.com/login/?next=x", [])
    session.save_state()

    # The stored session still holds the live cookie jar.
    assert "live" in path.read_text()


def test_logged_in_run_saves_the_session_atomically(tmp_path):
    import json

    cookies = [{"name": "xs", "value": "fresh"}]
    session = _session_with(tmp_path, "https://www.facebook.com/marketplace/", cookies)
    session.save_state()

    path = tmp_path / "fb_state.json"
    assert json.loads(path.read_text())["cookies"] == cookies
    assert (path.stat().st_mode & 0o777) == 0o600
    assert list(tmp_path.glob(".fb_state.json.tmp-*")) == []


# -- publish failure and the ledger ----------------------------------------


class _FakePosterPage:
    url = "https://www.facebook.com/marketplace/create/item"

    def goto(self, url, timeout=None):
        pass

    def wait_for_load_state(self, state):
        pass

    def set_input_files(self, selector, files):
        pass

    def wait_for_timeout(self, ms):
        pass


class _FakeSession:
    page = _FakePosterPage()


class _FakeLibrary:
    def __init__(self, root):
        self.root = Path(root)

    def resolve(self, name):
        return ["photo.jpg"]


def _stubbed_poster(tmp_path, monkeypatch):
    from rs_poster import poster as poster_mod

    state = PosterState(tmp_path / "state.json")
    poster = poster_mod.Poster(_FakeSession(), _FakeLibrary(tmp_path), state)
    for method in ("_paced", "_fill_labeled", "_select_option", "_set_location"):
        monkeypatch.setattr(poster_mod.Poster, method, lambda self, *a, **k: None)
    monkeypatch.setattr(poster_mod, "raise_if_restricted", lambda *a, **k: None)
    monkeypatch.setattr(poster_mod, "human_pause", lambda *a, **k: None)
    return poster, state


def _template():
    return AdTemplate(
        name="buy_servers",
        title="We Buy Used Servers",
        description="We buy them.",
        price=1,
        category="Electronics",
        condition="Used - Good",
        photo_set="default",
        cities=["Denver, CO"],
    )


def test_failed_publish_counts_against_pacing_but_records_no_ad(tmp_path, monkeypatch):
    from rs_poster import poster as poster_mod

    poster, state = _stubbed_poster(tmp_path, monkeypatch)

    def explode(self):
        raise PostingError("form never closed")

    monkeypatch.setattr(poster_mod.Poster, "_publish", explode)
    with pytest.raises(PostingError):
        poster.create_listing(_template(), "Denver, CO")

    # The click reached Facebook, so pacing must count it...
    assert state.last_action_at is not None
    assert PosterState(tmp_path / "state.json").last_action_at == state.last_action_at
    # ...but no phantom active record may occupy a cap slot.
    assert state.ads == {}


def test_successful_publish_records_an_active_ad(tmp_path, monkeypatch):
    from rs_poster import poster as poster_mod

    poster, state = _stubbed_poster(tmp_path, monkeypatch)
    monkeypatch.setattr(poster_mod.Poster, "_publish", lambda self: None)

    record = poster.create_listing(_template(), "Denver, CO")
    assert record is not None and record.active
    assert PosterState(tmp_path / "state.json").get("buy_servers", "Denver, CO")
