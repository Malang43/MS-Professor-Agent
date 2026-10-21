-- Additive migration: legacy document metadata remains marked as R2.
ALTER TABLE documents ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'r2';
ALTER TABLE documents ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE documents ADD COLUMN checksum TEXT;
ALTER TABLE documents ADD COLUMN expires_at INTEGER;
ALTER TABLE documents ADD COLUMN purge_after INTEGER;
ALTER TABLE documents ADD COLUMN cleanup_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);
CREATE UNIQUE INDEX messages_one_followup ON messages(parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE usage_counters(scope TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(scope,period));
CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, session_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, verifier TEXT NOT NULL, read_replies INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE connections(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL CHECK(provider IN ('gmail','outlook')), address TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'connected', scopes TEXT NOT NULL, tokens TEXT, expires_at INTEGER NOT NULL, refresh_lease TEXT, refresh_until INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,provider,subject), UNIQUE(id,user_id));
CREATE TABLE transports(message_id TEXT PRIMARY KEY REFERENCES messages(id), user_id TEXT NOT NULL REFERENCES users(id), connection_id TEXT NOT NULL, snapshot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, provider_id TEXT, thread_id TEXT, next_sync INTEGER NOT NULL DEFAULT 0, sync_cursor TEXT, sync_checked_at INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(connection_id,user_id) REFERENCES connections(id,user_id), FOREIGN KEY(message_id,user_id) REFERENCES messages(id,user_id));
CREATE INDEX transport_due ON transports(state,next_at);
CREATE INDEX transport_sync ON transports(state,next_sync);
CREATE TABLE automation(message_id TEXT PRIMARY KEY REFERENCES messages(id), days INTEGER NOT NULL CHECK(days BETWEEN 7 AND 10), subject TEXT NOT NULL, body TEXT NOT NULL, generated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE suppressions(user_id TEXT NOT NULL REFERENCES users(id), address TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(user_id,address));
CREATE TABLE mailbox_events(connection_id TEXT NOT NULL REFERENCES connections(id), provider_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), kind TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(connection_id,provider_id));
CREATE TABLE notifications(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, message TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX notifications_owner ON notifications(user_id,created_at);
CREATE TABLE ai_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 1,tokens INTEGER NOT NULL DEFAULT 0,reserved_tokens INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX documents_storage ON documents(storage_state,user_id);

CREATE TRIGGER attachment_ready BEFORE INSERT ON message_attachments WHEN NOT EXISTS(SELECT 1 FROM documents WHERE id=NEW.document_id AND user_id=NEW.user_id AND storage_state='ready' AND (expires_at IS NULL OR expires_at>unixepoch()*1000)) BEGIN SELECT RAISE(ABORT,'Attachment is unavailable'); END;

CREATE TRIGGER stop_followup_on_status AFTER UPDATE OF status ON messages WHEN NEW.status IN ('replied','cancelled','failed') BEGIN
 UPDATE automation SET generated=1 WHERE message_id=NEW.id;
 UPDATE messages SET status='cancelled' WHERE parent_id=NEW.id AND status IN ('draft','pending');
END;
CREATE TRIGGER stop_suppressed_recipient AFTER INSERT ON suppressions BEGIN
 UPDATE automation SET generated=1 WHERE message_id IN (SELECT message_id FROM transports WHERE user_id=NEW.user_id AND lower(json_extract(snapshot,'$.recipient'))=NEW.address);
 UPDATE messages SET status='cancelled' WHERE user_id=NEW.user_id AND status IN ('draft','pending') AND id IN (SELECT message_id FROM transports WHERE user_id=NEW.user_id AND lower(json_extract(snapshot,'$.recipient'))=NEW.address);
END;

CREATE INDEX documents_owner_state ON documents(user_id,storage_state);
CREATE INDEX documents_expiry ON documents(expires_at);
CREATE TRIGGER message_capacity BEFORE INSERT ON messages WHEN (SELECT count(*) FROM messages WHERE user_id=NEW.user_id)>=100 OR (SELECT count(*) FROM messages)>=1000 BEGIN SELECT RAISE(ABORT,'Message storage quota reached'); END;

ALTER TABLE professors ADD COLUMN source_url TEXT;
ALTER TABLE professors ADD COLUMN verified_at INTEGER;
