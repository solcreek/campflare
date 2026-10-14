-- Streaming follow-ups (chat.startStream and friends).
-- stream_stopped_by is the person who stopped a stream from their client
-- (campflare.chat.stopStream); chat.appendStream then answers stopped_by_user.
-- stream_task_display is chat.startStream's task_display_mode: 'plan' gathers
-- task_update chunks into one `plan` block, anything else ('timeline', the
-- default, stored as NULL) shows each task as a `task_card` block among the text.

ALTER TABLE messages ADD COLUMN stream_stopped_by TEXT;
ALTER TABLE messages ADD COLUMN stream_task_display TEXT;
