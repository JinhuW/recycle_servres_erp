"""Stream D: verification codes read out of an account's inbox.

Everything here runs against a fake IMAP server. The point of the tests is the
parsing and the freshness rules — which wordings Facebook uses, which message
wins when several match, and the guarantee that a code from a previous
challenge is never replayed — plus the promise that no IMAP failure escapes as
a raw traceback.
"""

from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime

import imaplib
import pytest

from rs_coordinator import deps, email_codes
from rs_coordinator.code_service import CodeUnavailable, get_code

ACCOUNT = "denver"
NOW = datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc)

EMAIL_SECRETS = {
    "email": "fleet@example.com",
    "email_password": "app-password",
    "imap_host": "imap.example.com",
}


# -- fakes -----------------------------------------------------------------


class FakeStore:
    """Stands in for AccountStore; only get_secret is ever called."""

    def __init__(self, secrets):
        self.secrets = secrets

    def get_secret(self, account_id):
        return dict(self.secrets)


class FakeIMAP:
    """The handful of imaplib methods `email_codes` actually uses."""

    def __init__(self, messages=(), *, fail_on=None):
        # messages are given oldest-first, matching IMAP sequence order.
        self.messages = list(messages)
        self.fail_on = fail_on
        self.searches = []
        self.logged_out = False

    def _maybe_fail(self, name):
        if self.fail_on == name:
            raise imaplib.IMAP4.error(f"{name.upper()} command error: BAD")

    def select(self, mailbox="INBOX", readonly=False):
        self._maybe_fail("select")
        self.selected = (mailbox, readonly)
        return "OK", [str(len(self.messages)).encode()]

    def search(self, charset, *criteria):
        self._maybe_fail("search")
        self.searches.append(criteria)
        if 'FROM "facebook"' in criteria[0] and not self.messages:
            return "OK", [b""]
        ids = b" ".join(str(i + 1).encode() for i in range(len(self.messages)))
        return "OK", [ids]

    def fetch(self, msg_id, spec):
        self._maybe_fail("fetch")
        raw = self.messages[int(msg_id) - 1]
        return "OK", [(b"%s (RFC822 {%d}" % (msg_id, len(raw)), raw), b")"]

    def logout(self):
        self.logged_out = True
        return "BYE", [b""]


@pytest.fixture()
def store(monkeypatch):
    """Point the module at a vault holding working email credentials."""
    holder = FakeStore(EMAIL_SECRETS)
    monkeypatch.setattr(deps, "get_account_store", lambda: holder)
    return holder


def use_mailbox(monkeypatch, *messages, **kwargs):
    """Install a fake mailbox and hand back the client the code will use."""
    client = FakeIMAP([_render(m) for m in messages], **kwargs)
    monkeypatch.setattr(email_codes, "_connect", lambda *a, **k: client)
    return client


# -- message builders ------------------------------------------------------


def _render(msg):
    return msg if isinstance(msg, bytes) else msg.as_bytes()


def plain_mail(subject, body="", *, sent=NOW, sender="Facebook <security@facebookmail.com>",
               cte=None):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = EMAIL_SECRETS["email"]
    msg["Subject"] = subject
    msg["Date"] = format_datetime(sent)
    if cte:
        msg.set_content(body or subject, cte=cte)
    else:
        msg.set_content(body or subject)
    return msg


def multipart_mail(subject, text, html, *, sent=NOW):
    msg = plain_mail(subject, text, sent=sent)
    msg.add_alternative(html, subtype="html")
    return msg


# -- code extraction -------------------------------------------------------


@pytest.mark.parametrize(
    "subject, body, expected",
    [
        ("461208 is your Facebook code", "", "461208"),
        ("Your Facebook confirmation code", "Your confirmation code is 328104.", "328104"),
        ("FB-90210", "Enter FB-90210 to confirm your identity.", "90210"),
        ("Facebook code: 774312", "", "774312"),
        ("Confirm your account", "Your Facebook code is 118822", "118822"),
        ("Login alert", "112233 is your login code for Facebook.", "112233"),
        ("Nothing to see", "Your account was viewed 12 times in 2026.", None),
    ],
)
def test_extract_code_handles_facebooks_wordings(subject, body, expected):
    assert email_codes.extract_code(subject, body) == expected


def test_subject_wins_over_the_body():
    """A body can quote an older challenge; a subject only ever states this one."""
    code = email_codes.extract_code(
        "654321 is your Facebook code",
        "Earlier we sent you the code 111111. Your Facebook code is 111111.",
    )
    assert code == "654321"


def test_code_survives_html_and_non_breaking_spaces():
    html = "<p>Your Facebook confirmation&nbsp;code is <b>240816</b></p>"
    assert email_codes.extract_code("Confirm your account", html) == "240816"


def test_reads_a_quoted_printable_body(store, monkeypatch):
    body = "Your Facebook confirmation code is 505150 — enter it to continue."
    raw = plain_mail("Confirm your account", body, cte="quoted-printable").as_bytes()
    assert b"quoted-printable" in raw and b"505150" in raw
    use_mailbox(monkeypatch, raw)

    assert email_codes.latest_code(ACCOUNT)[0] == "505150"


def test_reads_a_base64_body(store, monkeypatch):
    mail = plain_mail("Security alert")
    mail.set_content("Your Facebook code is 616263", cte="base64")
    raw = mail.as_bytes()
    assert b"base64" in raw
    use_mailbox(monkeypatch, raw)

    assert email_codes.latest_code(ACCOUNT)[0] == "616263"


def test_reads_a_multipart_message(store, monkeypatch):
    mail = multipart_mail(
        "Security alert",
        "We noticed a new login.",
        "<html><body><p>Your Facebook code is <b>707172</b></p></body></html>",
    )
    use_mailbox(monkeypatch, mail)

    assert email_codes.latest_code(ACCOUNT)[0] == "707172"


def test_encoded_subject_is_decoded(store, monkeypatch):
    mail = plain_mail("=?utf-8?B?ODA4MDgwIGlzIHlvdXIgRmFjZWJvb2sgY29kZQ==?=", "body text")
    use_mailbox(monkeypatch, mail)

    assert email_codes.latest_code(ACCOUNT)[0] == "808080"


# -- picking the right message ---------------------------------------------


def test_newest_matching_message_wins(store, monkeypatch):
    use_mailbox(
        monkeypatch,
        plain_mail("111111 is your Facebook code", sent=NOW - timedelta(minutes=30)),
        plain_mail("222222 is your Facebook code", sent=NOW - timedelta(minutes=10)),
        plain_mail("333333 is your Facebook code", sent=NOW - timedelta(minutes=20)),
    )

    code, ttl = email_codes.latest_code(ACCOUNT)
    assert code == "222222"
    assert ttl == email_codes.CODE_TTL_SECONDS


def test_non_facebook_mail_is_ignored(store, monkeypatch):
    """The fallback search is unfiltered, so the sender check has to be local."""
    use_mailbox(
        monkeypatch,
        plain_mail(
            "999999 is your login code",
            sender="Some Bank <noreply@some-bank.example>",
            sent=NOW,
        ),
    )

    with pytest.raises(CodeUnavailable):
        email_codes.latest_code(ACCOUNT)


def test_a_stale_code_is_never_replayed(store, monkeypatch):
    """The previous challenge's mail parses fine — `since` is what rules it out."""
    use_mailbox(
        monkeypatch,
        plain_mail("111111 is your Facebook code", sent=NOW - timedelta(hours=2)),
    )
    since = (NOW - timedelta(minutes=1)).isoformat()

    with pytest.raises(CodeUnavailable, match="newer than"):
        email_codes.latest_code(ACCOUNT, since)


def test_since_keeps_the_message_sent_after_the_challenge(store, monkeypatch):
    use_mailbox(
        monkeypatch,
        plain_mail("111111 is your Facebook code", sent=NOW - timedelta(hours=2)),
        plain_mail("444444 is your Facebook code", sent=NOW),
    )
    since = (NOW - timedelta(minutes=1)).isoformat()

    assert email_codes.latest_code(ACCOUNT, since)[0] == "444444"


def test_a_message_with_no_date_is_too_old_to_trust(store, monkeypatch):
    mail = plain_mail("111111 is your Facebook code")
    del mail["Date"]
    use_mailbox(monkeypatch, mail)

    with pytest.raises(CodeUnavailable):
        email_codes.latest_code(ACCOUNT, NOW.isoformat())
    # ...but with no `since` there is nothing to compare against, so it counts.
    assert email_codes.latest_code(ACCOUNT)[0] == "111111"


def test_message_is_recent_compares_timezone_aware(store):
    mail = plain_mail("111111 is your Facebook code", sent=NOW)
    # Same instant, written in another zone: must not be read as stale.
    since = NOW.astimezone(timezone(timedelta(hours=-6))).isoformat()
    assert email_codes.message_is_recent(mail, since) is True
    assert email_codes.message_is_recent(mail, (NOW + timedelta(minutes=1)).isoformat()) is False


def test_empty_inbox_is_code_unavailable(store, monkeypatch):
    client = use_mailbox(monkeypatch)

    with pytest.raises(CodeUnavailable, match="retry"):
        email_codes.latest_code(ACCOUNT)
    assert client.logged_out


def test_the_sender_filter_is_tried_server_side_first(store, monkeypatch):
    client = use_mailbox(monkeypatch, plain_mail("111111 is your Facebook code"))
    email_codes.latest_code(ACCOUNT)

    assert 'FROM "facebook"' in client.searches[0][0]
    assert "SINCE" in client.searches[0][0]


def test_the_inbox_is_opened_read_only(store, monkeypatch):
    """Reading a code must not mark a human's mailbox as read."""
    client = use_mailbox(monkeypatch, plain_mail("111111 is your Facebook code"))
    email_codes.latest_code(ACCOUNT)

    assert client.selected == ("INBOX", True)


# -- configuration ---------------------------------------------------------


def test_missing_email_credentials_name_the_cli(monkeypatch):
    monkeypatch.setattr(deps, "get_account_store", lambda: FakeStore({"password": "pw"}))

    with pytest.raises(CodeUnavailable, match="rsc vault set-account"):
        email_codes.latest_code(ACCOUNT)


def test_known_providers_need_no_imap_host(monkeypatch):
    for address, host in (
        ("a@gmail.com", "imap.gmail.com"),
        ("b@outlook.com", "outlook.office365.com"),
        ("c@hotmail.com", "outlook.office365.com"),
    ):
        monkeypatch.setattr(
            deps,
            "get_account_store",
            lambda a=address: FakeStore({"email": a, "email_password": "pw"}),
        )
        config = email_codes.mailbox_config(ACCOUNT)
        assert (config.host, config.port) == (host, 993)


def test_an_unknown_domain_must_be_told_its_imap_host(monkeypatch):
    monkeypatch.setattr(
        deps,
        "get_account_store",
        lambda: FakeStore({"email": "ops@rs-mail.example", "email_password": "pw"}),
    )

    with pytest.raises(CodeUnavailable, match="rs-mail.example"):
        email_codes.mailbox_config(ACCOUNT)


def test_a_stored_imap_host_and_port_are_honoured(monkeypatch):
    monkeypatch.setattr(
        deps,
        "get_account_store",
        lambda: FakeStore(
            {
                "email": "a@gmail.com",
                "email_password": "pw",
                "imap_host": "mail.internal.example",
                "imap_port": "1993",
            }
        ),
    )
    config = email_codes.mailbox_config(ACCOUNT)
    assert (config.host, config.port) == ("mail.internal.example", 1993)


# -- failure modes ---------------------------------------------------------


def test_a_rejected_login_is_a_clear_error_not_a_traceback(store, monkeypatch):
    def refuse(host, port, user, password):
        raise imaplib.IMAP4.error("b'[AUTHENTICATIONFAILED] Invalid credentials'")

    monkeypatch.setattr(email_codes, "_connect", refuse)

    with pytest.raises(RuntimeError) as caught:
        email_codes.latest_code(ACCOUNT)
    message = str(caught.value)
    assert "app password" in message
    assert EMAIL_SECRETS["email_password"] not in message  # never log the password
    assert not isinstance(caught.value, CodeUnavailable)  # retrying will not help


def test_an_unreachable_host_is_retryable(store, monkeypatch):
    def refuse(host, port, user, password):
        raise OSError("connection refused")

    monkeypatch.setattr(email_codes, "_connect", refuse)

    with pytest.raises(CodeUnavailable, match="imap.example.com"):
        email_codes.latest_code(ACCOUNT)


def test_an_imap_error_mid_session_is_wrapped_and_logs_out(store, monkeypatch):
    client = use_mailbox(
        monkeypatch, plain_mail("111111 is your Facebook code"), fail_on="search"
    )

    with pytest.raises(CodeUnavailable, match="inbox"):
        email_codes.latest_code(ACCOUNT)
    assert client.logged_out


def test_a_dropped_connection_is_wrapped(store, monkeypatch):
    client = use_mailbox(monkeypatch, plain_mail("111111 is your Facebook code"))

    def drop(msg_id, spec):
        raise imaplib.IMAP4.abort("socket error: EOF")

    monkeypatch.setattr(client, "fetch", drop)

    with pytest.raises(CodeUnavailable):
        email_codes.latest_code(ACCOUNT)


def test_a_bad_since_is_reported_not_ignored(store, monkeypatch):
    use_mailbox(monkeypatch, plain_mail("111111 is your Facebook code"))

    with pytest.raises(CodeUnavailable, match="ISO timestamp"):
        email_codes.latest_code(ACCOUNT, "last tuesday")


# -- dispatcher integration ------------------------------------------------


def test_code_service_routes_email_to_this_module(store, monkeypatch):
    use_mailbox(monkeypatch, plain_mail("606162 is your Facebook code", sent=NOW))

    assert get_code(ACCOUNT, "email") == ("606162", email_codes.CODE_TTL_SECONDS)


def test_code_service_passes_since_through(store, monkeypatch):
    use_mailbox(
        monkeypatch,
        plain_mail("111111 is your Facebook code", sent=NOW - timedelta(hours=3)),
    )

    with pytest.raises(CodeUnavailable):
        get_code(ACCOUNT, "email", (NOW - timedelta(minutes=5)).isoformat())
