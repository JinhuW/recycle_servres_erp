-- RAM lines can carry the DRAM chip (IC) number printed on the modules —
-- distinct from the module part number. Free text, null = not recorded.
ALTER TABLE order_lines ADD COLUMN chip_number TEXT;
