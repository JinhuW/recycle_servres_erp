-- Minutes a post may wait unjudged, behind the newest judged one, before the
-- watch pages "evaluation stalled"; 0 turns the alert off. A dead provider key
-- fails every post but leaves the evaluate loop's failure streak at zero
-- between posts, so only an alert on outcomes catches it. Set from the ERP.
INSERT INTO settings (key, value) VALUES
  ('eval_stall_alert_min', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;
