"""The pool-cookie parser that seeds a worker's session (RS-308).

A pool account stores its cookie the way the operator pasted it — a browser
cookie header, a cookie-extension JSON export (array or {name: value}). These
fence that every one of those becomes a valid Playwright storage_state, and
that anything that is not a Facebook session is refused before it is sealed.
"""

import pytest

from rs_coordinator.cookies import CookieError, cookies_from_text, storage_state_from_text

UID = "61574553140062"


def by_name(state):
    return {c["name"]: c for c in state["cookies"]}


def test_a_browser_cookie_header_becomes_a_storage_state():
    header = f"c_user={UID}; xs=sess-token; datr=device-id; sb=sib; locale=en_US"
    state, c_user = storage_state_from_text(header)
    assert c_user == UID
    cookies = by_name(state)
    assert {"c_user", "xs", "datr", "sb"} <= set(cookies)
    # A pasted header carries no attributes, so the bearer cookies are pinned
    # to facebook.com and marked httpOnly as a real browser has them.
    assert cookies["xs"]["httpOnly"] is True
    assert cookies["xs"]["secure"] is True
    assert cookies["xs"]["domain"] == ".facebook.com"
    # c_user is readable from JS in a real browser; keep it that way.
    assert cookies["c_user"]["httpOnly"] is False


def test_a_json_array_export_preserves_its_attributes():
    export = (
        f'[{{"name":"c_user","value":"{UID}","domain":".facebook.com"}},'
        '{"name":"xs","value":"z","httpOnly":true,"expirationDate":1800000000}]'
    )
    state, c_user = storage_state_from_text(export)
    assert c_user == UID
    assert by_name(state)["xs"]["expires"] == 1800000000.0


def test_a_flat_name_value_object_is_read():
    state, c_user = storage_state_from_text(f'{{"c_user":"{UID}","xs":"q","datr":"d"}}')
    assert c_user == UID
    assert {"c_user", "xs", "datr"} <= set(by_name(state))


def test_non_facebook_cookies_are_dropped():
    # A cookie jar from another site carries no facebook session.
    with pytest.raises(CookieError):
        storage_state_from_text("sessionid=abc; csrftoken=xyz")


def test_a_cookie_without_xs_is_refused():
    with pytest.raises(CookieError):
        storage_state_from_text(f"c_user={UID}; datr=only-a-device")


def test_a_cookie_without_c_user_is_refused():
    with pytest.raises(CookieError):
        storage_state_from_text("xs=sess-token; datr=device")


def test_malformed_json_is_a_cookie_error_not_a_crash():
    with pytest.raises(CookieError):
        storage_state_from_text("[{not json")


def test_empty_input_is_refused():
    with pytest.raises(CookieError):
        cookies_from_text("   ")
