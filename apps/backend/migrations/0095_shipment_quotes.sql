-- The last rate quotes returned for this shipment, as RateQuote[] JSON.
-- ShipSaving v2's create_and_pay response does not echo carrier/service, so
-- the buy handler resolves the picked rate_id against these instead of
-- trusting the client — and a rate_id from another shipment can't be replayed.
ALTER TABLE shipments ADD COLUMN quotes JSONB;
