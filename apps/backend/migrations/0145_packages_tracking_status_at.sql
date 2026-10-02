-- When the carrier says the stored tracking status happened (Shippo's
-- tracking_status.status_date). Pushes are not ordered and the poll races
-- them, so an event older than this one is dropped instead of overwriting a
-- newer status. NULL until a payload carrying a date lands.
ALTER TABLE packages ADD COLUMN tracking_status_at TIMESTAMPTZ;
