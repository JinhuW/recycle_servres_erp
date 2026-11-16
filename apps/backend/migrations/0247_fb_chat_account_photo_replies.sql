-- Whether the account's extension last claimed replies saying it can attach
-- photos (`caps` has `media`). Null until it claims at all. False means photo
-- replies wait in the outbox: the extension is older than 0.5.0, or Chrome's
-- "Allow access to file URLs" is off for it.
ALTER TABLE fb_chat_accounts ADD COLUMN photo_replies BOOLEAN;
