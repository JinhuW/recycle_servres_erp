"""Two-factor codes: the thing that used to be a manual trip to a web authenticator.

The codes have to match what any authenticator produces, so the vectors here are
checked against the RFC 6238 test key rather than against ourselves.
"""

import json

import pytest

from rs_poster import totp
from rs_poster.cookies import meta_path_for, read_session_meta, write_session_meta

# RFC 6238's test key "12345678901234567890" in base32.
RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
DEMO_SECRET = "JBSWY3DPEHPK3PXP"


def test_generates_the_rfc_6238_vectors():
    config = totp.TotpConfig(secret=RFC_SECRET)
    # Times and expected codes straight from RFC 6238 Appendix B (SHA-1, 8
    # digits there; we take the low 6, which is what a 6-digit token is).
    assert totp.generate(config, at=59) == "287082"
    assert totp.generate(config, at=1111111109) == "081804"
    assert totp.generate(config, at=1234567890) == "005924"


def test_code_is_stable_within_a_window_and_changes_across_it():
    config = totp.TotpConfig(secret=DEMO_SECRET)
    assert totp.generate(config, at=1755600000) == totp.generate(config, at=1755600029)
    assert totp.generate(config, at=1755600000) != totp.generate(config, at=1755600030)


def test_seconds_remaining_counts_down_within_the_window():
    config = totp.TotpConfig(secret=DEMO_SECRET)
    assert totp.seconds_remaining(config, at=1755600000) == 30
    assert totp.seconds_remaining(config, at=1755600025) == 5


@pytest.mark.parametrize(
    "raw",
    [
        DEMO_SECRET,
        DEMO_SECRET.lower(),
        "jbsw y3dp ehpk 3pxp",  # Facebook prints the key in groups
        "JBSW-Y3DP-EHPK-3PXP",
        f"{DEMO_SECRET}====",  # some exports keep the padding
    ],
)
def test_accepts_the_shapes_people_actually_paste(raw):
    assert totp.parse_secret(raw).secret == DEMO_SECRET


def test_rejects_a_secret_that_is_not_base32():
    # '1' and '8' are outside the base32 alphabet — a common transcription slip.
    with pytest.raises(totp.TotpError, match="base32"):
        totp.parse_secret("JBSW18DPEHPK3PXP")


def test_rejects_an_empty_secret():
    with pytest.raises(totp.TotpError):
        totp.parse_secret("   ")


def test_parses_an_otpauth_uri_including_its_parameters():
    config = totp.parse_secret(
        "otpauth://totp/Facebook:tx-1%40example.com"
        f"?secret={DEMO_SECRET}&issuer=Facebook&digits=8&period=60&algorithm=SHA256"
    )
    assert config.secret == DEMO_SECRET
    assert (config.digits, config.period, config.algorithm) == (8, 60, "SHA256")
    assert config.label == "Facebook:tx-1@example.com"
    assert not config.is_default
    assert len(totp.generate(config)) == 8


def test_otpauth_defaults_match_a_bare_secret():
    config = totp.parse_secret(f"otpauth://totp/Facebook?secret={DEMO_SECRET}")
    assert config.is_default
    assert totp.generate(config, at=59) == totp.generate(
        totp.TotpConfig(secret=DEMO_SECRET), at=59
    )


def test_rejects_counter_based_hotp():
    # HOTP needs a counter that only the account knows; unattended login can't.
    with pytest.raises(totp.TotpError, match="time-based"):
        totp.parse_secret(f"otpauth://hotp/Facebook?secret={DEMO_SECRET}&counter=1")


def test_rejects_an_otpauth_uri_without_a_secret():
    with pytest.raises(totp.TotpError, match="secret"):
        totp.parse_secret("otpauth://totp/Facebook?issuer=Facebook")


def test_env_var_name_is_derived_from_the_session_filename():
    assert totp.env_var_for("configs/sessions/tx-1.json") == "FB_TOTP_SECRET_TX_1"
    assert totp.env_var_for("configs/sessions/denver-1.json") == "FB_TOTP_SECRET_DENVER_1"
    # The sidecar names the same session, so it must resolve the same variable.
    assert totp.env_var_for("configs/sessions/tx-1.json.meta.json") == "FB_TOTP_SECRET_TX_1"


def test_store_then_resolve_round_trips_through_the_sidecar(tmp_path):
    state = tmp_path / "tx-1.json"
    totp.store(state, totp.parse_secret("jbsw y3dp ehpk 3pxp"))

    resolved = totp.resolve(state)
    assert resolved is not None
    assert resolved.secret == DEMO_SECRET
    assert resolved.is_default


def test_stored_secret_is_owner_readable_only(tmp_path):
    state = tmp_path / "tx-1.json"
    meta = totp.store(state, totp.parse_secret(DEMO_SECRET))
    assert meta.stat().st_mode & 0o077 == 0


def test_storing_a_secret_keeps_the_rest_of_the_sidecar(tmp_path):
    state = tmp_path / "tx-1.json"
    write_session_meta(state, user_agent="Mozilla/5.0 test", proxy="http://p:8080")

    totp.store(state, totp.parse_secret(DEMO_SECRET))

    meta = read_session_meta(state)
    assert meta["user_agent"] == "Mozilla/5.0 test"
    assert meta["proxy"] == "http://p:8080"
    assert meta["totp_secret"] == DEMO_SECRET


def test_capturing_a_session_again_keeps_the_stored_secret(tmp_path):
    """save_state() rewrites the sidecar on every run; the secret must survive."""
    state = tmp_path / "tx-1.json"
    totp.store(state, totp.parse_secret(DEMO_SECRET))

    write_session_meta(state, user_agent="Mozilla/5.0 refreshed")

    assert totp.resolve(state).secret == DEMO_SECRET


def test_non_default_parameters_survive_the_sidecar(tmp_path):
    state = tmp_path / "odd.json"
    totp.store(
        state,
        totp.parse_secret(f"otpauth://totp/X?secret={DEMO_SECRET}&digits=8&period=60"),
    )

    resolved = totp.resolve(state)
    assert (resolved.digits, resolved.period) == (8, 60)


def test_clear_removes_the_secret_and_leaves_the_session_usable(tmp_path):
    state = tmp_path / "tx-1.json"
    write_session_meta(state, user_agent="Mozilla/5.0 test")
    totp.store(state, totp.parse_secret(DEMO_SECRET))

    assert totp.clear(state) is True
    assert totp.resolve(state) is None
    assert read_session_meta(state)["user_agent"] == "Mozilla/5.0 test"
    # Removing a secret that is not there is not an error.
    assert totp.clear(state) is False


def test_resolution_order(tmp_path, monkeypatch):
    state = tmp_path / "tx-1.json"
    totp.store(state, totp.parse_secret(DEMO_SECRET))
    monkeypatch.setenv("FB_TOTP_SECRET", RFC_SECRET)

    # The sidecar beats the shared single-account variable...
    assert totp.resolve(state).secret == DEMO_SECRET
    # ...the per-session variable beats the sidecar...
    monkeypatch.setenv("FB_TOTP_SECRET_TX_1", RFC_SECRET)
    assert totp.resolve(state).secret == RFC_SECRET
    # ...and an explicit secret beats everything.
    assert totp.resolve(state, explicit=DEMO_SECRET).secret == DEMO_SECRET


def test_shared_env_var_covers_a_session_with_no_sidecar(tmp_path, monkeypatch):
    """Inside a worker every session is /data/fb_state.json, so this is the case."""
    monkeypatch.setenv("FB_TOTP_SECRET", DEMO_SECRET)
    assert totp.resolve(tmp_path / "fb_state.json").secret == DEMO_SECRET


def test_no_secret_anywhere_resolves_to_none(tmp_path, monkeypatch):
    monkeypatch.delenv("FB_TOTP_SECRET", raising=False)
    assert totp.resolve(tmp_path / "nothing.json") is None


def test_a_corrupt_sidecar_does_not_crash_resolution(tmp_path, monkeypatch):
    monkeypatch.delenv("FB_TOTP_SECRET", raising=False)
    state = tmp_path / "tx-1.json"
    meta_path_for(state).write_text("{ not json")
    assert totp.resolve(state) is None


def test_a_garbled_stored_secret_raises_rather_than_generating_wrong_codes(tmp_path):
    state = tmp_path / "tx-1.json"
    meta_path_for(state).write_text(json.dumps({"totp_secret": "not-base32-at-all!"}))
    with pytest.raises(totp.TotpError):
        totp.resolve(state)
