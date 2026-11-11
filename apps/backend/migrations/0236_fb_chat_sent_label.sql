-- Facebook's own wording for when a chat message was sent ("Tuesday 5:57pm"),
-- as the page labels each bubble. It is relative to the day it was read, so it
-- is kept as text beside created_at rather than guessed into a timestamp.
ALTER TABLE fb_chat_messages ADD COLUMN fb_sent_label TEXT;
