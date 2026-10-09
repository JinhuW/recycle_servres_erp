-- A Micron chip prints a date/lot code over its FBGA die code (8KE75 / D9VPP),
-- and purchasers copied both, so every line's chip was unique. What the trade
-- prices by is the die: the FBGA code's last three letters. Writes keep only
-- those from now on (chipMarkingCanon in @recycle-erp/shared); cut the rows that
-- predate the rule. A value not ending in an FBGA code is left as typed.
UPDATE order_lines
   SET chip_number = substring(regexp_replace(upper(chip_number), '[^A-Z0-9]', '', 'g')
                               FROM '[CDZ][89]([A-Z]{3})$')
 WHERE lower(btrim(brand)) = 'micron'
   AND regexp_replace(upper(chip_number), '[^A-Z0-9]', '', 'g') ~ '[CDZ][89][A-Z]{3}$';
