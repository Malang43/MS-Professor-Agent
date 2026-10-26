-- Additive authentication options; existing approvals and deliveries remain unchanged.
CREATE TABLE recovery_codes(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,code_hash));
CREATE TABLE passkeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,public_key TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX passkeys_owner ON passkeys(user_id);
CREATE TABLE auth_challenges(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL,challenge TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE followup_approvals(message_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),authorized_at INTEGER NOT NULL);
CREATE TRIGGER followup_approval_immutable BEFORE UPDATE ON followup_approvals BEGIN SELECT RAISE(ABORT,'Follow-up approval is immutable'); END;
CREATE TRIGGER followup_approval_retained BEFORE DELETE ON followup_approvals WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN SELECT RAISE(ABORT,'Follow-up approval must be retained'); END;
DROP TRIGGER unauthorized_rule_blocked;
CREATE TRIGGER unauthorized_rule_blocked BEFORE INSERT ON automation WHEN EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=NEW.message_id AND followup_authorized=0) AND NOT EXISTS(SELECT 1 FROM followup_approvals WHERE message_id=NEW.message_id AND json_extract(snapshot,'$.days')=NEW.days AND json_extract(snapshot,'$.subject')=NEW.subject AND json_extract(snapshot,'$.body')=NEW.body) BEGIN SELECT RAISE(ABORT,'No automatic follow-up was authorized'); END;
