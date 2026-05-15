-- Remove the workflow_stages table. The order lifecycle (Draft → In Transit →
-- Reviewing → Done) is a fixed set pinned by the order_lines.status /
-- orders.lifecycle convention, so it now lives as a static constant in the
-- frontend (lib/status.ts WORKFLOW_STAGES) instead of a manager-editable
-- table. The /api/workflow route and its seed were removed alongside this.
-- Drops the table from already-provisioned databases. Idempotent.

DROP TABLE IF EXISTS workflow_stages CASCADE;
