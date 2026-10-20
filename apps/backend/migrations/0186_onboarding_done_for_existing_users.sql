-- The purchaser walkthrough opens for anyone whose preferences lack
-- `onboarding.done`. Everyone who has already signed in learned the app
-- without it, so they start with it set; a member who has never signed in
-- (a pending invite) is exactly who it is for.
UPDATE users
   SET preferences = preferences || '{"onboarding.done": true}'::jsonb
 WHERE last_seen_at IS NOT NULL
   AND NOT (preferences ? 'onboarding.done');
