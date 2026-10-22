-- Historical messages remain intact but cannot become live jobs without fresh approval.
ALTER TABLE messages ADD COLUMN approved_recipient TEXT;
ALTER TABLE messages ADD COLUMN live_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transports ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
CREATE TABLE outreach_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, production_enabled INTEGER NOT NULL DEFAULT 0, activated_at INTEGER);
CREATE TABLE mailbox_checks(connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, checked_at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE delivery_attempts(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, outcome TEXT NOT NULL, UNIQUE(message_id,attempt));
ALTER TABLE messages ADD COLUMN live_fingerprint TEXT;
CREATE UNIQUE INDEX live_message_fingerprint ON messages(user_id,live_fingerprint) WHERE live_fingerprint IS NOT NULL;
