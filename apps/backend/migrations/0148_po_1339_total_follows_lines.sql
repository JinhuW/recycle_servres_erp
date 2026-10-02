-- PO-1339 lost its only line to PO-1353 in a 2026-07-23 hand clone but kept
-- its $8,500 total_cost, so the same lot is costed twice: PO-1353 carries the
-- line and the same $8,500. With no lines left, PO-1339's total can only be a
-- stale figure, never a negotiated price, so it goes back to following its
-- lines (none, so 0).
--
-- Guarded on the id, the figure and the empty line set together, so it can
-- touch only that row, only as it was, and does nothing anywhere else (a fresh
-- dev or test database has no PO-1339).
UPDATE orders o
   SET total_cost = 0
 WHERE o.id = 'PO-1339'
   AND o.total_cost = 8500
   AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id);
