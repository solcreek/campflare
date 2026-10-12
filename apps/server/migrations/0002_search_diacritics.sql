-- Search ignores diacritics as well as case, so "cafe" finds "Café", "munchen"
-- finds "München" and "senor" finds "señor". Rebuilt from the messages table;
-- the triggers address the index by name and carry on unchanged.

DROP TABLE messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);
INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');
