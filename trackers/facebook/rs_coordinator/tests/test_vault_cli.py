"""The operator CLI that loads real Facebook credentials into the vault.

This is the one path a human types secrets into, so the tests pin the promises
that make it safe to use: secrets are prompted for (never arguments), a partial
update never drops the other secrets, `vault list` prints presence and never a
value, and `show-code` proves the stored TOTP secret is the same one the
operator's authenticator app holds.
"""

import getpass
import json

import pytest

from rs_coordinator.cli import main
from rs_coordinator.db import Database
from rs_coordinator.tokens import generate_secret, mint_worker_token, verify_worker_token
from rs_coordinator.vault import AccountStore, Vault, generate_key

pyotp = pytest.importorskip("pyotp")

SEED = "JBSWY3DPEHPK3PXP"
PASSWORD = "correct-horse-battery"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A control plane with its own database and freshly generated keys."""
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "coordinator.db"))
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", generate_secret())
    return tmp_path


@pytest.fixture()
def store(env):
    """Direct vault access, for asserting on what the CLI actually stored."""
    return AccountStore(Database(str(env / "coordinator.db")), Vault())


def prompts(monkeypatch, **values):
    """Answer the four getpass prompts in order; unnamed ones are left blank."""
    queue = [
        values.get(field, "")
        for field in ("password", "email", "email_password", "totp_secret")
    ]

    def fake_getpass(prompt: str = "") -> str:
        return queue.pop(0) if queue else ""

    monkeypatch.setattr(getpass, "getpass", fake_getpass)


# -- init -------------------------------------------------------------------


def test_init_prints_a_usable_key_and_token_secret(env, capsys):
    assert main(["vault", "init"]) == 0
    out = capsys.readouterr().out

    def printed(name: str) -> str:
        prefix = f"{name}="
        return next(
            line.split("=", 1)[1] for line in out.splitlines() if line.startswith(prefix)
        )

    key = printed("RS_VAULT_KEY")
    secret = printed("RS_WORKER_TOKEN_SECRET")
    # Both are immediately usable, not placeholders.
    assert Vault(key).decrypt(Vault(key).encrypt({"a": 1})) == {"a": 1}
    assert verify_worker_token(mint_worker_token("denver-1", secret), secret) == "denver-1"


def test_init_writes_an_env_file(env, capsys):
    path = env / "secrets.env"
    assert main(["vault", "init", "--write-env", str(path)]) == 0
    body = path.read_text()
    assert "RS_VAULT_KEY=" in body and "RS_WORKER_TOKEN_SECRET=" in body


def test_init_refuses_to_rotate_an_existing_key(env, capsys):
    path = env / "secrets.env"
    assert main(["vault", "init", "--write-env", str(path)]) == 0
    before = path.read_text()
    capsys.readouterr()

    # Rotating RS_VAULT_KEY orphans every stored secret, so it needs --force.
    assert main(["vault", "init", "--write-env", str(path)]) == 1
    err = capsys.readouterr().err
    assert "RS_VAULT_KEY" in err and "unreadable" in err
    assert path.read_text() == before

    assert main(["vault", "init", "--write-env", str(path), "--force"]) == 0
    assert path.read_text() != before


# -- set-account / list -----------------------------------------------------


def test_set_account_prompts_for_secrets_then_lists_them_as_set(env, monkeypatch, capsys):
    prompts(monkeypatch, password=PASSWORD, totp_secret=SEED)
    assert (
        main(
            [
                "vault",
                "set-account",
                "--account-id",
                "denver",
                "--worker",
                "denver-1",
                "--region",
                "rs_mountain",
                "--fb-username",
                "ops@example.com",
                "--no-password-login",
            ]
        )
        == 0
    )
    capsys.readouterr()

    assert main(["vault", "list"]) == 0
    out = capsys.readouterr().out
    assert "denver" in out and "denver-1" in out and "rs_mountain" in out
    assert "password=SET" in out and "totp_secret=SET" in out
    assert "email=-" in out  # never entered, reported as absent
    assert "password-login: no" in out

    # The whole point: presence is shown, values are not.
    assert PASSWORD not in out
    assert SEED not in out


def test_set_account_accepts_a_spaced_key_and_an_otpauth_uri(env, monkeypatch, store):
    prompts(monkeypatch, totp_secret="jbswy 3dpe hpk3 pxp")
    assert main(["vault", "set-account", "--account-id", "a"]) == 0
    assert store.get_secret("a")["totp_secret"] == SEED

    prompts(monkeypatch, totp_secret=f"otpauth://totp/Facebook:ops?secret={SEED}&issuer=Facebook")
    assert main(["vault", "set-account", "--account-id", "b"]) == 0
    assert store.get_secret("b")["totp_secret"] == SEED


def test_a_non_default_otpauth_uri_is_stored_whole(env, monkeypatch, store, capsys):
    """digits/period have no field of their own, so the URI must survive intact."""
    uri = f"otpauth://totp/Facebook:ops?secret={SEED}&period=60&digits=8"
    prompts(monkeypatch, totp_secret=uri)
    assert main(["vault", "set-account", "--account-id", "odd"]) == 0
    assert store.get_secret("odd")["totp_secret"] == uri
    capsys.readouterr()

    before = pyotp.TOTP(SEED, digits=8, interval=60).now()
    assert main(["vault", "show-code", "--account-id", "odd"]) == 0
    printed = capsys.readouterr().out.split()[0]
    after = pyotp.TOTP(SEED, digits=8, interval=60).now()
    assert len(printed) == 8 and printed in (before, after)


def test_a_mistyped_totp_secret_is_refused_before_anything_is_stored(
    env, monkeypatch, store, capsys
):
    prompts(monkeypatch, totp_secret="not a real key!!")
    assert main(["vault", "set-account", "--account-id", "denver"]) == 1
    assert "base32" in capsys.readouterr().err
    assert store.get_account("denver") is None


def test_secret_file_loads_without_prompting(env, store, monkeypatch):
    def explode(prompt: str = "") -> str:  # pragma: no cover - must not be called
        raise AssertionError("--secret-file must not prompt")

    monkeypatch.setattr(getpass, "getpass", explode)
    path = env / "denver.json"
    path.write_text(json.dumps({"password": PASSWORD, "totp_secret": SEED}))

    argv = ["vault", "set-account", "--account-id", "denver", "--secret-file", str(path)]
    assert main(argv) == 0
    secret = store.get_secret("denver")
    assert secret["password"] == PASSWORD and secret["totp_secret"] == SEED


def test_secret_file_rejects_an_unknown_field(env, capsys):
    path = env / "bad.json"
    path.write_text(json.dumps({"api_key": "nope"}))
    argv = ["vault", "set-account", "--account-id", "denver", "--secret-file", str(path)]
    assert main(argv) == 1
    assert "unknown secret field" in capsys.readouterr().err.lower()


def test_a_second_set_account_keeps_the_untouched_secrets(env, monkeypatch, store):
    prompts(monkeypatch, password="old-pw", totp_secret=SEED)
    assert main(["vault", "set-account", "--account-id", "denver", "--worker", "denver-1"]) == 0

    # Change only the password; the TOTP secret and the worker mapping survive.
    prompts(monkeypatch, password="new-pw")
    argv = ["vault", "set-account", "--account-id", "denver", "--proxy", "http://p:8080"]
    assert main(argv) == 0

    secret = store.get_secret("denver")
    assert secret["password"] == "new-pw"
    assert secret["totp_secret"] == SEED
    account = store.get_account("denver")
    assert account["proxy"] == "http://p:8080"
    assert account["worker_id"] == "denver-1"


def test_metadata_only_update_preserves_the_password_login_flag(env, monkeypatch, store):
    prompts(monkeypatch, password=PASSWORD)
    assert main(["vault", "set-account", "--account-id", "denver", "--allow-password-login"]) == 0
    argv = ["vault", "set-account", "--account-id", "denver", "--no-prompt"]
    assert main(argv + ["--region", "rs_mountain"]) == 0

    account = store.get_account("denver")
    assert account["allow_password_login"] is True  # not silently reset
    assert account["region"] == "rs_mountain"
    assert store.get_secret("denver")["password"] == PASSWORD


def test_clear_secret_removes_just_that_field(env, monkeypatch, store):
    prompts(monkeypatch, password=PASSWORD, totp_secret=SEED)
    assert main(["vault", "set-account", "--account-id", "denver"]) == 0

    assert (
        main(
            [
                "vault",
                "set-account",
                "--account-id",
                "denver",
                "--no-prompt",
                "--clear-secret",
                "totp_secret",
            ]
        )
        == 0
    )
    secret = store.get_secret("denver")
    assert "totp_secret" not in secret
    assert secret["password"] == PASSWORD


def test_list_is_friendly_when_the_vault_is_empty(env, capsys):
    assert main(["vault", "list"]) == 0
    assert "No accounts" in capsys.readouterr().out


# -- show-code --------------------------------------------------------------


def test_show_code_matches_an_authenticator(env, monkeypatch, capsys):
    prompts(monkeypatch, totp_secret=SEED)
    assert main(["vault", "set-account", "--account-id", "denver"]) == 0
    capsys.readouterr()

    before = pyotp.TOTP(SEED).now()
    assert main(["vault", "show-code", "--account-id", "denver"]) == 0
    printed = capsys.readouterr().out.split()[0]
    after = pyotp.TOTP(SEED).now()

    assert len(printed) == 6 and printed.isdigit()
    # Allow for the 30-second window rolling over mid-test.
    assert printed in (before, after)


def test_show_code_without_a_stored_secret_is_actionable(env, monkeypatch, capsys):
    prompts(monkeypatch, password=PASSWORD)
    assert main(["vault", "set-account", "--account-id", "denver"]) == 0
    capsys.readouterr()

    assert main(["vault", "show-code", "--account-id", "denver"]) == 1
    assert "no TOTP secret" in capsys.readouterr().err


def test_show_code_for_an_unknown_account_does_not_traceback(env, capsys):
    assert main(["vault", "show-code", "--account-id", "nope"]) == 1
    assert "No account" in capsys.readouterr().err


# -- rm ---------------------------------------------------------------------


def test_rm_asks_before_deleting(env, monkeypatch, store, capsys):
    prompts(monkeypatch, password=PASSWORD)
    assert main(["vault", "set-account", "--account-id", "denver"]) == 0

    monkeypatch.setattr("builtins.input", lambda prompt="": "n")
    assert main(["vault", "rm", "--account-id", "denver"]) == 1
    assert store.get_account("denver") is not None

    monkeypatch.setattr("builtins.input", lambda prompt="": "y")
    assert main(["vault", "rm", "--account-id", "denver"]) == 0
    assert store.get_account("denver") is None


def test_rm_yes_skips_the_prompt(env, monkeypatch, store):
    prompts(monkeypatch, password=PASSWORD)
    assert main(["vault", "set-account", "--account-id", "denver"]) == 0

    def explode(prompt: str = "") -> str:  # pragma: no cover - must not be called
        raise AssertionError("--yes must not prompt")

    monkeypatch.setattr("builtins.input", explode)
    assert main(["vault", "rm", "--account-id", "denver", "--yes"]) == 0
    assert store.get_account("denver") is None


def test_rm_of_an_unknown_account_reports_clearly(env, capsys):
    assert main(["vault", "rm", "--account-id", "nope", "--yes"]) == 1
    assert "no account" in capsys.readouterr().err.lower()


# -- tokens / missing key ---------------------------------------------------


def test_mint_token_round_trips(env, capsys):
    assert main(["mint-token", "--worker", "denver-1"]) == 0
    captured = capsys.readouterr()
    token = captured.out.strip()

    assert verify_worker_token(token) == "denver-1"
    # The token alone goes to stdout so it can be piped; guidance goes to stderr.
    assert "\n" not in token
    # The note names the env var the generated worker config reads — the same
    # one docker-compose.worker.yml exports. It is deliberately NOT derived from
    # the worker id: compose has no string functions, so a derived name could
    # never be set, and the control plane silently stayed off.
    from rs_coordinator.sharding import DEFAULT_CONTROL_PLANE_TOKEN_ENV

    assert DEFAULT_CONTROL_PLANE_TOKEN_ENV in captured.err


def test_mint_token_rejects_a_bad_worker_id(env, capsys):
    assert main(["mint-token", "--worker", "bad.id"]) == 1
    assert "error" in capsys.readouterr().err


def test_a_missing_vault_key_is_reported_not_raised(env, monkeypatch, capsys):
    monkeypatch.delenv("RS_VAULT_KEY")
    assert main(["vault", "list"]) == 1
    err = capsys.readouterr().err
    assert "RS_VAULT_KEY" in err and "rsc vault init" in err


def test_a_missing_token_secret_is_reported_not_raised(env, monkeypatch, capsys):
    monkeypatch.delenv("RS_WORKER_TOKEN_SECRET")
    assert main(["mint-token", "--worker", "denver-1"]) == 1
    assert "RS_WORKER_TOKEN_SECRET" in capsys.readouterr().err
