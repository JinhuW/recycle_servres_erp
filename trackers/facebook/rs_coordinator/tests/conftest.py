"""Test-session safety rails.

Two hazards this file exists to remove, both of which are easy to hit because
the documented operator workflow is `source configs/secrets.env` — which exports
the production `RS_DATABASE_URL` into the very shell people then run pytest in.

1. **Tests silently running against production.** `open_database()` picks
   Postgres whenever `RS_DATABASE_URL`/`DATABASE_URL` is set, so an ambient
   production URL would point the whole suite at the live control plane and
   write test rows into it.

2. **The Postgres suite dropping the live vault.** `test_postgres.py` starts
   each case with `DROP TABLE ... CASCADE` on whatever `RS_TEST_DATABASE_URL`
   names. Aimed at production that is not a failing test, it is a destroyed
   fleet: every account's TOTP secret gone and every Facebook account needing
   2FA re-enrolment.

So: the ambient URLs are stripped for the session, and pointing the destructive
suite at the same database as production is refused outright.
"""

import os

import pytest

# Read before the fixtures strip them, so the comparison in the guard below can
# still see what production is.
_AMBIENT_DB_URLS = {
    name: os.environ.get(name) for name in ("RS_DATABASE_URL", "DATABASE_URL")
}


def _normalize(url: str | None) -> str | None:
    """Compare URLs by identity, ignoring query-string differences."""
    if not url:
        return None
    return url.split("?", 1)[0].rstrip("/").strip()


def pytest_configure(config: pytest.Config) -> None:
    """Refuse to run the destructive Postgres suite against production."""
    test_url = _normalize(os.environ.get("RS_TEST_DATABASE_URL"))
    if not test_url:
        return
    for name, ambient in _AMBIENT_DB_URLS.items():
        if test_url and test_url == _normalize(ambient):
            raise pytest.UsageError(
                f"RS_TEST_DATABASE_URL points at the same database as {name}. "
                "The Postgres tests DROP every table they touch, which would "
                "destroy the account vault. Point RS_TEST_DATABASE_URL at a "
                "throwaway database instead."
            )


@pytest.fixture(autouse=True, scope="session")
def _isolate_from_production_database() -> None:
    """Make SQLite the backend for every test, whatever the shell exports.

    Session-scoped and autouse: individual tests should not have to remember,
    and a test that genuinely wants Postgres opts in through
    RS_TEST_DATABASE_URL rather than through the ambient environment.
    """
    for name in _AMBIENT_DB_URLS:
        os.environ.pop(name, None)
