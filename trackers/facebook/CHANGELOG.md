# Changelog

What changed in the Facebook Marketplace tracker, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions are [semantic](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a **minor** bump is what carries a breaking change — and here
"breaking" mostly means *the fleet will not come up until you do something*: a
renamed environment variable, a config that must be regenerated, a credential
that is no longer accepted. Those are called out under **Breaking** with the
command to run, because a worker that silently keeps running while doing less is
this project's most common failure mode.

One version covers the whole system — the coordinator, the poster, the configs,
and the pinned revision of the vendored monitor (see [VENDOR.md](VENDOR.md)).
They only ever ship together, so versioning them apart would only make "what is
deployed?" harder to answer.

## [Unreleased]

## [0.1.0] - 2026-08-20

First tagged version: the system as it stood when it went under version
control, already running against live Facebook accounts. Recorded as a baseline
rather than reconstructed — the entries below say what exists, not what changed.

### Added

- **Coordinator** (`rs_coordinator`, CLI `rsc`) — FastAPI service that ingests
  matched listings from the fleet, dedupes them by Facebook item id so a
  listing visible from two adjacent regions still produces exactly one alert,
  and owns the single Telegram alert stream. SQLite by default, Postgres when
  `RS_DATABASE_URL` is set.
- **Control plane** — an encrypted account vault (Fernet), per-worker bearer
  tokens (HMAC of one rotatable secret), TOTP code minting, IMAP polling for
  emailed login codes, captcha/checkpoint escalation to a human, and encrypted
  session backups. Workers hold no account secret of their own.
- **Config sharding** (`rsc gen-configs`) — generates one monitor config per
  worker from `configs/master.toml` + `configs/fleet.toml`, pinning each worker
  to exactly one region. No runtime dispatch, no random city selection.
- **Poster** (`rs_poster`, CLIs `rs-poster` / `rs-session`) — publishes "we buy
  used server hardware" ads and reposts them on a paced schedule; `rs-session`
  creates and checks the password-free Facebook sessions everything else runs
  on.
- **Deployment** — Docker Compose for the coordinator, the homelab monitor and
  a fleet worker; Terraform for the Railway Postgres that backs the vault;
  `scripts/deploy.sh`, which proves the container is running the tree it just
  pushed by checksumming every module rather than trusting the build.
- **Measurement tooling** — `scripts/probe-search-url.py` and
  `scripts/check-cities.py` for testing a search URL or a city slug against a
  live session, and a daily keyword evaluation that mines the monitor log into
  an evidence pack. The conclusions live in `configs/master.toml`'s comments,
  which is why that file reads the way it does.

<!-- This repository has no remote yet (see VENDOR.md), so there is nothing to
     link a version to. Compare two releases locally with `git diff v0.1.0..v0.2.0`,
     or add the link definitions here once it has one. -->
