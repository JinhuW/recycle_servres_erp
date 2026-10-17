# Infrastructure

The Facebook tracker's control plane stores everything — matched listings, fleet
health, the challenge queue, and the encrypted account vault — in **its own
Railway Postgres**, provisioned by the Terraform in `terraform/`.

```
Railway project "facebook-tracker"
  └── postgres (ghcr.io/railwayapp-templates/postgres-ssl:16)
        ├── volume "pgdata"  → /var/lib/postgresql/data
        └── TCP proxy        → public host:port for clients outside Railway
              ▲
              ├── coordinator (rs_coordinator, RS_DATABASE_URL)
              └── ERP console, via the coordinator's HTTP API — never SQL
```

## Why a separate database from reddits-tracker

Asked and answered deliberately, because the first instinct was to share:

- **The vault.** This database holds every Facebook account's password and TOTP
  secret, Fernet-encrypted. That earns its own isolation boundary rather than
  sitting beside another app's operational data.
- **`--reset` exists next door.** reddits-tracker's migration runner drops every
  table in the `public` schema. Sharing would put these tables in its blast
  radius.
- **The upside wasn't real.** The point of sharing would have been one place to
  query both trackers' finds — but the ERP reads both over HTTP proxies
  (`TRACKER_API_URL`, `COORDINATOR_API_URL`), never by joining tables. Sharing
  would have bought coupling and no payoff.

The cost is a second instance to pay for and no cross-tracker SQL. If that
becomes wanted, export into one place rather than merging the live databases.

## Layout

- `terraform/main.tf` — provider, versions, and the (currently commented) remote
  state backend.
- `terraform/postgres.tf` — project, Postgres service + volume, service
  variables, public TCP proxy.
- `terraform/variables.tf`, `outputs.tf`, `.gitignore`.

## Usage

```bash
export PATH="$HOME/.railway/bin:$PATH"          # railway CLI
export RAILWAY_TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.railway/config.json')))['user']['accessToken'])")

cd infra/terraform
terraform init
terraform plan            # always read this before applying
terraform apply
terraform output -raw database_url    # → RS_DATABASE_URL
```

Point the coordinator at it:

```bash
echo "RS_DATABASE_URL=$(terraform output -raw database_url)" >> ../../configs/secrets.env
```

## Two things that will bite you

### 1. The token

`RAILWAY_TOKEN` above is the **CLI's session token**, which expires (see
`tokenExpiresAt` in `~/.railway/config.json`). It works, but for anything
unattended create a real account token at
<https://railway.com/account/tokens> and use that instead. Note that a *project*
token cannot create projects — only an account/workspace token can.

`projectCreate` is also scoped to a workspace, which is why `workspace_id` is
passed explicitly in `variables.tf`; without it Railway answers
`Not Authorized` rather than picking one.

### 2. A provider bug around volumes

`terraform-community-providers/railway` v0.6 returns `volume = null` in the
create response for `railway_service`, even though the volume is created and
mounted correctly. Terraform sees the mismatch, reports
*"Provider produced inconsistent result after apply"*, and marks the service
**tainted** — while the real service, volume, and mount all exist.

If a first `apply` on a fresh project hits this:

```bash
# Confirm reality before touching anything: the service and volume DO exist.
terraform state list
terraform untaint railway_service.postgres
terraform plan      # expect no replacement — the volume does not drift on read
terraform apply
```

**Do not let Terraform "fix" it by replacing the service** — that destroys the
volume and the database with it. Untaint, verify the plan shows `0 to destroy`,
then continue.

## Never point the test suite at this database

The documented workflow is `source configs/secrets.env`, which exports the
production `RS_DATABASE_URL` into your shell. Running pytest in that same shell
used to send the whole suite at the live control plane — it happened once during
setup and left four junk accounts and a pile of test listings in production.

`rs_coordinator/tests/conftest.py` now closes both holes: it strips
`RS_DATABASE_URL`/`DATABASE_URL` for the test session so tests always use
SQLite, and it refuses to start when `RS_TEST_DATABASE_URL` names the same
database as production — because `test_postgres.py` begins each case with
`DROP TABLE ... CASCADE`, which against this database means every account's TOTP
secret gone and every Facebook account needing 2FA re-enrolment.

To run the Postgres conformance suite, use a throwaway:

```bash
docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55439:5432 postgres:16
RS_TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55439/postgres \
  .venv-coordinator/bin/python -m pytest rs_coordinator/tests/test_postgres.py -q
```

## State contains a secret

Unlike the reddits-tracker stack (whose state is deliberately secrets-free),
this one generates the Postgres password with `random_password`, so
`terraform.tfstate` **is a credential**. It is gitignored and kept local.

Before moving it to the shared OCI Object Storage backend (the block is in
`main.tf`, commented, and needs `~/.aws/credentials`), be aware you are putting
a live database password in that bucket. Use a distinct state key
(`homelab_infra/facebook-tracker`) either way.

## Rotating the Postgres password

Changing `POSTGRES_PASSWORD` in Terraform **does not** rotate it. The image only
reads it during `initdb`; after first boot the volume is authoritative. To
actually rotate:

```sql
ALTER ROLE postgres WITH PASSWORD '<new>';
```

then update the Terraform variable to match, or the state and reality diverge.

## Tearing it down

```bash
terraform destroy      # deletes the project, service, volume, and all data
```

There are no snapshots. Take a `pg_dump` first if the vault has real accounts in
it — losing that table means re-enrolling every Facebook account's 2FA.
