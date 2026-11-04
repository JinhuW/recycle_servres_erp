-- 0223: hourly request and page-load timing per release, so an optimization can
-- start from a ranking and end with a before/after. /metrics resets on every
-- deploy and the request log has no aggregation, so neither can answer that.
--
-- Histograms rather than stored percentiles: percentiles cannot be merged, and
-- every view here merges rows across hours. `buckets` holds one count per bound
-- in PERF_BUCKETS_MS (lib/perf.ts) plus a last one for anything over the top.
--
-- `name` is bounded by construction: a matched route pattern, or a client metric
-- with an allowlisted shell and page. No row names a user, an id or a raw path.

CREATE TABLE perf_rollups (
  bucket  TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('http', 'client')),
  name    TEXT NOT NULL,
  count   BIGINT NOT NULL,
  errors  BIGINT NOT NULL DEFAULT 0,
  sum_ms  DOUBLE PRECISION NOT NULL,
  max_ms  DOUBLE PRECISION NOT NULL,
  buckets BIGINT[] NOT NULL,
  PRIMARY KEY (bucket, version, kind, name)
);

-- The primary key serves the time windows; the release compare filters by version.
CREATE INDEX perf_rollups_version_idx ON perf_rollups (version, kind);
