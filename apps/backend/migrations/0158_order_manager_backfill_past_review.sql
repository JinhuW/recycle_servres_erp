-- 0156 named a PO's manager from moves into Reviewing only, but a manager's
-- move into Ready to Pay or Done stamps one too. A PO jumped from In Transit
-- straight past Reviewing was left empty, so whichever manager touched it
-- next was stamped without a question.
--
-- The latest such move by a user who is still an active manager names it,
-- as in 0156. Runtime would have kept the first, since the column is sticky,
-- but for moves made before the column existed either one is a guess, and
-- the latest is the one 0156 already made for every other PO.
-- The user filter sits inside DISTINCT ON so a later move by someone no
-- longer a manager doesn't hide an earlier one by a manager.
--
-- The `manager_id IS NULL` guard lets a test replay the file.
UPDATE orders o
SET manager_id = e.actor_id
FROM (
  SELECT DISTINCT ON (ev.order_id) ev.order_id, ev.actor_id
  FROM order_events ev
  JOIN users u ON u.id = ev.actor_id AND u.role = 'manager' AND u.active
  WHERE ev.kind = 'advanced' AND ev.detail->>'to' IN ('reviewing', 'ready_to_pay', 'done')
  ORDER BY ev.order_id, ev.created_at DESC
) e
WHERE o.id = e.order_id AND o.manager_id IS NULL;
