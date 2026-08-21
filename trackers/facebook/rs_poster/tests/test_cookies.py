"""Cookie import: the password-free path into a Facebook session.

Covers the export formats browsers and cookie extensions actually produce, and
the validation that stops a half-exported session from reaching a worker.
"""

import json
import time

import pytest

from rs_poster.cookies import (
    CookieError,
    describe,
    filter_facebook,
    load_cookie_file,
    meta_path_for,
    parse_netscape,
    read_session_meta,
    storage_state_cookies,
    write_session_meta,
    write_storage_state,
)

FUTURE = int(time.time()) + 60 * 86400
PAST = int(time.time()) - 86400


def netscape_line(name, value, domain=".facebook.com", expiry=FUTURE):
    return f"{domain}\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{value}"


def valid_netscape(expiry=FUTURE):
    return "\n".join(
        [
            "# Netscape HTTP Cookie File",
            netscape_line("c_user", "100012345678901", expiry=expiry),
            netscape_line("xs", "42%3Asession%3A2", expiry=expiry),
            netscape_line("datr", "abc123", expiry=expiry),
        ]
    )


def valid_json(expiry=FUTURE):
    return json.dumps(
        [
            {
                "name": "c_user",
                "value": "100012345678901",
                "domain": ".facebook.com",
                "path": "/",
                "expirationDate": expiry,
                "httpOnly": False,
                "secure": True,
                "sameSite": "no_restriction",
            },
            {
                "name": "xs",
                "value": "42%3Asession%3A2",
                "domain": ".facebook.com",
                "path": "/",
                "expirationDate": expiry,
                "httpOnly": True,
                "secure": True,
                "sameSite": "lax",
            },
        ]
    )


# -- parsing ---------------------------------------------------------------


def test_netscape_parses_and_skips_comments():
    cookies = parse_netscape(valid_netscape())
    assert [c["name"] for c in cookies] == ["c_user", "xs", "datr"]
    assert cookies[0]["value"] == "100012345678901"
    assert cookies[0]["secure"] is True


def test_netscape_httponly_prefix_is_a_cookie_not_a_comment():
    text = "#HttpOnly_" + netscape_line("xs", "secret")
    cookies = parse_netscape(text)
    assert len(cookies) == 1
    assert cookies[0]["name"] == "xs"


def test_json_export_is_detected_and_samesite_normalized(tmp_path):
    path = tmp_path / "cookies.json"
    path.write_text(valid_json())
    cookies = load_cookie_file(path)
    by_name = {c["name"]: c for c in cookies}
    # Extensions write "no_restriction"; Playwright only accepts None/Lax/Strict.
    assert by_name["c_user"]["sameSite"] == "None"
    assert by_name["xs"]["sameSite"] == "Lax"


def test_wrapped_json_object_is_accepted(tmp_path):
    path = tmp_path / "cookies.json"
    path.write_text(json.dumps({"cookies": json.loads(valid_json())}))
    assert len(load_cookie_file(path)) == 2


def test_millisecond_expiry_is_converted(tmp_path):
    path = tmp_path / "cookies.json"
    path.write_text(
        json.dumps([{"name": "c_user", "value": "1", "expirationDate": FUTURE * 1000}])
    )
    cookie = load_cookie_file(path)[0]
    assert abs(cookie["expires"] - FUTURE) < 2


def test_session_cookie_expiry_becomes_minus_one(tmp_path):
    path = tmp_path / "cookies.json"
    path.write_text(json.dumps([{"name": "c_user", "value": "1"}]))
    assert load_cookie_file(path)[0]["expires"] == -1


def test_missing_and_empty_files_are_reported(tmp_path):
    with pytest.raises(CookieError, match="not found"):
        load_cookie_file(tmp_path / "nope.txt")
    empty = tmp_path / "empty.txt"
    empty.write_text("   ")
    with pytest.raises(CookieError, match="empty"):
        load_cookie_file(empty)


def test_broken_json_is_not_silently_treated_as_netscape(tmp_path):
    path = tmp_path / "cookies.json"
    path.write_text('[{"name": "c_user",}]')
    with pytest.raises(CookieError, match="does not parse"):
        load_cookie_file(path)


# -- filtering -------------------------------------------------------------


def test_non_facebook_cookies_are_dropped():
    cookies = parse_netscape(
        "\n".join(
            [
                netscape_line("c_user", "1"),
                netscape_line("xs", "2"),
                netscape_line("session", "secret", domain=".mybank.com"),
            ]
        )
    )
    kept = filter_facebook(cookies)
    assert [c["name"] for c in kept] == ["c_user", "xs"]


def test_insecure_samesite_none_is_repaired():
    cookies = [
        {"name": "c_user", "domain": ".facebook.com", "sameSite": "None", "secure": False}
    ]
    assert filter_facebook(cookies)[0]["secure"] is True


# -- validation and writing ------------------------------------------------


def test_write_storage_state_round_trips(tmp_path):
    state_path = tmp_path / "fb_state.json"
    info = write_storage_state(parse_netscape(valid_netscape()), state_path)

    assert info.account_id == "100012345678901"
    assert info.has_required
    assert 59 < info.days_remaining < 61

    state = json.loads(state_path.read_text())
    assert state["origins"] == []
    assert {c["name"] for c in state["cookies"]} == {"c_user", "xs", "datr"}
    assert [c["name"] for c in storage_state_cookies(state_path)]


def test_session_file_is_not_world_readable(tmp_path):
    state_path = tmp_path / "fb_state.json"
    write_storage_state(parse_netscape(valid_netscape()), state_path)
    assert state_path.stat().st_mode & 0o077 == 0


def test_export_without_session_cookies_is_rejected(tmp_path):
    # A common failure: the export tool omitted httpOnly cookies, so `xs` is absent.
    cookies = parse_netscape(netscape_line("c_user", "100012345678901"))
    with pytest.raises(CookieError, match="xs"):
        write_storage_state(cookies, tmp_path / "state.json")


def test_expired_export_is_rejected(tmp_path):
    with pytest.raises(CookieError, match="expired"):
        write_storage_state(parse_netscape(valid_netscape(expiry=PAST)), tmp_path / "s.json")


def test_export_from_the_wrong_site_is_rejected(tmp_path):
    cookies = parse_netscape(netscape_line("session", "x", domain=".example.com"))
    with pytest.raises(CookieError, match="No facebook.com cookies"):
        write_storage_state(cookies, tmp_path / "state.json")


def test_describe_flags_missing_cookies():
    info = describe([{"name": "c_user", "value": "1", "expires": FUTURE}])
    assert not info.has_required
    assert info.missing == ["xs"]


# -- session environment sidecar -------------------------------------------


def test_session_meta_records_the_pinned_environment(tmp_path):
    state = tmp_path / "fb_state.json"
    write_session_meta(
        state, user_agent="Mozilla/5.0 TestBrowser", proxy="http://p:8080", account_id="123"
    )

    meta = read_session_meta(state)
    assert meta["user_agent"] == "Mozilla/5.0 TestBrowser"
    assert meta["proxy"] == "http://p:8080"
    assert meta["account_id"] == "123"
    assert meta["captured_at"]
    assert meta_path_for(state) == tmp_path / "fb_state.json.meta.json"


def test_session_meta_updates_preserve_unspecified_fields(tmp_path):
    state = tmp_path / "fb_state.json"
    write_session_meta(state, user_agent="UA/1", proxy="http://p:8080")
    # A later save that only knows the user agent must not drop the proxy.
    write_session_meta(state, user_agent="UA/2")

    meta = read_session_meta(state)
    assert meta["user_agent"] == "UA/2"
    assert meta["proxy"] == "http://p:8080"


def test_missing_or_corrupt_meta_is_not_fatal(tmp_path):
    state = tmp_path / "fb_state.json"
    assert read_session_meta(state) == {}

    meta_path_for(state).write_text("not json{")
    assert read_session_meta(state) == {}


def test_meta_file_is_not_world_readable(tmp_path):
    state = tmp_path / "fb_state.json"
    write_session_meta(state, user_agent="UA/1")
    assert meta_path_for(state).stat().st_mode & 0o077 == 0


def test_describe_ignores_session_cookie_expiry():
    info = describe(
        [{"name": "c_user", "value": "1", "expires": -1}, {"name": "xs", "value": "2", "expires": -1}]
    )
    assert info.has_required
    assert info.days_remaining is None
    assert not info.expired


# -- session cookies survive an import --------------------------------------


def test_a_netscape_session_cookie_is_not_stamped_with_the_epoch():
    """cookies.txt is text, so "no expiry" arrives as the STRING "0".

    Comparing it against the int 0 fell through to float("0") -> 0.0, i.e.
    expired at the epoch, and Playwright discards those on restore. Facebook
    rotates precisely the session-scoped cookies, so the import silently lost
    its live half while `rs-session check` still passed on the persistent ones.
    """
    cookies = parse_netscape(
        ".facebook.com\tTRUE\t/\tTRUE\t0\txs\t42%3Aabcdef%3A%3A2%3A1234567890\n"
    )
    assert len(cookies) == 1
    assert cookies[0]["name"] == "xs"
    assert cookies[0]["expires"] == -1


def test_a_real_expiry_still_comes_through():
    cookies = parse_netscape(".facebook.com\tTRUE\t/\tTRUE\t1800000000\tdatr\tsomevalue\n")
    assert cookies[0]["expires"] == 1800000000.0


def test_the_http_only_flag_is_carried_not_dropped():
    """The "#HttpOnly_" prefix is the file format's only record of the flag."""
    cookies = parse_netscape(
        "#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t0\txs\tsecret\n"
        ".facebook.com\tTRUE\t/\tTRUE\t1800000000\tc_user\t100000\n"
    )
    by_name = {cookie["name"]: cookie for cookie in cookies}
    assert by_name["xs"]["httpOnly"] is True
    assert by_name["c_user"]["httpOnly"] is False
