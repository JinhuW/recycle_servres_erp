-- One spelling of "nobody has priced this line".
--
-- order_lines.sell_price carried two: NULL, and 0 from a drawer whose sell
-- field sent Number('0'). The SQL asks `sell_price IS NULL` (the orders list's
-- unpriced_line_count, market.ts's 30-day aggregate) while every client gates
-- on `> 0` (CostTape, the group headers, the drawer's margin), so a line stored
-- at 0 was counted priced by one and unpriced by the other — the same PO
-- reporting "2 of 3 priced" in the tape and 3 of 3 in the list row.
--
-- Nothing is lost: a 0 contributes 0 to every revenue SUM either way, and each
-- of these lines already RENDERED as unpriced. normSellPrice() in
-- routes/orders.ts keeps new writes on this side of the line.

UPDATE order_lines SET sell_price = NULL WHERE sell_price = 0;
