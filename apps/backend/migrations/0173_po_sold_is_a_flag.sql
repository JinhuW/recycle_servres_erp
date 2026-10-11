-- Sold is no longer a stage after Done but a flag beside the stage, derived
-- from the lines when read (services/orderSold.ts soldFlagSql). Every order
-- that 0130 or the old settle path parked at 'sold' was Done with its lines
-- sold, so it goes back to 'done' and reads Done · Sold. The old
-- `advanced done→sold` events stay as history; the activity feed drops them.
-- Idempotent: a second run matches nothing.
UPDATE orders SET lifecycle = 'done' WHERE lifecycle = 'sold';
