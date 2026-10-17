-- 0183: the pool records when a manager sends an account's login to a fleet
-- worker ('assigned', detail = the worker id).
ALTER TABLE fb_pool_events DROP CONSTRAINT fb_pool_events_kind_check;
ALTER TABLE fb_pool_events ADD CONSTRAINT fb_pool_events_kind_check
  CHECK (kind IN ('added','edited','imported','took','returned',
                  'reported','retired','removed','copied','revealed','assigned'));
