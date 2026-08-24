-- Chip markings are die codes, always printed upper-case on the module.
-- Writes are normalised in the API from now on; fold the rows that predate
-- that rule so one chip can't exist under two spellings.
UPDATE order_lines
   SET chip_number = UPPER(BTRIM(chip_number))
 WHERE chip_number IS NOT NULL
   AND chip_number <> UPPER(BTRIM(chip_number));
