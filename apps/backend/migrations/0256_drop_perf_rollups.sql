-- Request and page-load timing is exposed as Prometheus metrics (metrics.ts)
-- and kept by the homelab Prometheus, so the ERP no longer stores its own copy.

DROP TABLE IF EXISTS perf_rollups;
