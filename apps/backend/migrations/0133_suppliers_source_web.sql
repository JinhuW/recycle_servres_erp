-- The public sell form on cash4ram.com files its sellers as house-account
-- suppliers (owner_id NULL). None of the existing sources describes "typed
-- their own details into our website": referral implies a person referred
-- them, manual implies a purchaser keyed them in. 'web' names the channel so
-- the CRM can tell a form lead from a cold call.
--
-- orders.source is left alone on purpose: it mirrors packages.source and the
-- shared PACKAGE_SOURCES enum; a web submission maps to 'other' there.

ALTER TABLE suppliers
  DROP CONSTRAINT IF EXISTS suppliers_source_check;

ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_source_check
  CHECK (source IN ('manual','shipping','package','referral','facebook','reddit','walk_in','web'));
