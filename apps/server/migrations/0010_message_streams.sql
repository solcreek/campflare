-- Streamed messages (chat.startStream, chat.appendStream, chat.stopStream).
-- stream_state is NULL for an ordinary message, 'in_progress' while its app
-- streams into it and 'completed' once stopped; the API sends it as
-- streaming_state. stream_mode is how the stream sends content, 'markdown_text'
-- or 'chunks', fixed by the first call that sends any: Slack refuses a mix.

ALTER TABLE messages ADD COLUMN stream_state TEXT;
ALTER TABLE messages ADD COLUMN stream_mode TEXT;
