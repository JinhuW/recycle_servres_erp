# Backend tests fail with Postgres I/O errors: it is the Colima data disk

**Date:** 2026-11-11

## Symptom

Every backend test file fails in setup, before any test runs, with one of:

- `PostgresError: could not open file "global/pg_filenode.map": Input/output error` (58030)
- `Error: connect ECONNREFUSED 127.0.0.1:55432`

`docker logs recycle-erp-testdb` answers `input/output error`, `docker run`
fails writing containerd's `meta.db`, and the other Postgres containers on the
Mac show `unhealthy`.

## Cause

Not the suite and not the test database. The Colima VM's data disk
(`~/.colima/_lima/_disks/colima/datadisk`, `/dev/vdb` in the VM, mounted at
`/var/lib/docker`) returns I/O errors. Confirm with:

```sh
colima ssh -- sudo dmesg | grep -i "I/O error"
```

## What does and does not help

- `colima restart` brings Docker back for about four minutes. Containers
  without a restart policy (`recycle-erp-testdb`, `fleet-e2-pg`) have to be
  started by hand afterwards. Under the suite's load the errors return.
- A single test file (`cd apps/backend && npx vitest run tests/foo.test.ts`)
  fits inside that window. The full suite does not.
- The fix is a new data disk, which deletes every container's volumes. That is
  the owner's call. Until then, let CI run the full suite.
