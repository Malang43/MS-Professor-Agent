-- Additive: no historical message or reminder receives new authorization.
ALTER TABLE professors ADD COLUMN archived_at INTEGER;
ALTER TABLE professors ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN archived_at INTEGER;
ALTER TABLE messages ADD COLUMN hidden_at INTEGER;
ALTER TABLE messages ADD COLUMN followup_issue TEXT;
ALTER TABLE messages ADD COLUMN followup_draft TEXT;
ALTER TABLE automation ADD COLUMN due_at INTEGER;
ALTER TABLE automation ADD COLUMN cancel_reason TEXT;
CREATE TABLE message_authorizations(message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, campaign_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'initial', parent_id TEXT, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), authorized_at INTEGER NOT NULL, followup_authorized INTEGER NOT NULL DEFAULT 0);
CREATE INDEX campaign_authorization_owner ON message_authorizations(user_id,campaign_id);
CREATE TRIGGER authorization_immutable BEFORE UPDATE ON message_authorizations BEGIN SELECT RAISE(ABORT,'Authorization records are immutable'); END;
CREATE TRIGGER authorization_retained BEFORE DELETE ON message_authorizations WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN SELECT RAISE(ABORT,'Authorization audit must be retained'); END;
CREATE TRIGGER approved_content_immutable BEFORE UPDATE OF subject,body,professor_id,scheduled_at,timezone,approved_recipient,parent_id ON messages WHEN EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=OLD.id) AND (NEW.subject IS NOT OLD.subject OR NEW.body IS NOT OLD.body OR NEW.professor_id IS NOT OLD.professor_id OR NEW.scheduled_at IS NOT OLD.scheduled_at OR NEW.timezone IS NOT OLD.timezone OR NEW.approved_recipient IS NOT OLD.approved_recipient OR NEW.parent_id IS NOT OLD.parent_id) BEGIN SELECT RAISE(ABORT,'Approved message content is immutable; create a new draft'); END;
CREATE TRIGGER approved_transport_immutable BEFORE UPDATE OF snapshot,connection_id ON transports WHEN EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=OLD.message_id) AND (NEW.snapshot IS NOT OLD.snapshot OR NEW.connection_id IS NOT OLD.connection_id) BEGIN SELECT RAISE(ABORT,'Approved transport is immutable'); END;
CREATE TRIGGER approved_rule_immutable BEFORE UPDATE OF days,subject,body ON automation WHEN EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=OLD.message_id) AND (NEW.days IS NOT OLD.days OR NEW.subject IS NOT OLD.subject OR NEW.body IS NOT OLD.body) BEGIN SELECT RAISE(ABORT,'Approved follow-up rule is immutable'); END;
CREATE TRIGGER unauthorized_rule_blocked BEFORE INSERT ON automation WHEN EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=NEW.message_id AND followup_authorized=0) BEGIN SELECT RAISE(ABORT,'No automatic follow-up was authorized'); END;
CREATE TRIGGER reply_cancellation_reason AFTER UPDATE OF status ON messages WHEN NEW.status='replied' BEGIN UPDATE automation SET cancel_reason=COALESCE(cancel_reason,'reply') WHERE message_id=NEW.id; END;
CREATE TRIGGER suppression_cancellation_reason AFTER INSERT ON suppressions BEGIN UPDATE automation SET cancel_reason=CASE WHEN NEW.reason='professor_deleted' THEN 'professor_deleted' WHEN NEW.reason='bounce' THEN 'bounce' ELSE 'opt_out' END WHERE message_id IN (SELECT message_id FROM transports WHERE user_id=NEW.user_id AND lower(json_extract(snapshot,'$.recipient'))=NEW.address); END;
CREATE TRIGGER deleted_professor_cancellation AFTER UPDATE OF deleted_at ON professors WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
 UPDATE messages SET status='cancelled',error='Professor deleted; no further sending' WHERE professor_id=NEW.id AND user_id=NEW.user_id AND status IN ('draft','pending');
 UPDATE automation SET generated=1,cancel_reason='professor_deleted' WHERE message_id IN (SELECT id FROM messages WHERE professor_id=NEW.id AND user_id=NEW.user_id);
 INSERT OR IGNORE INTO suppressions(user_id,address,reason) VALUES(NEW.user_id,lower(NEW.email),'professor_deleted');
END;
CREATE TRIGGER deleted_professor_send_blocked BEFORE UPDATE OF state ON transports WHEN NEW.state='submitting' AND EXISTS(SELECT 1 FROM messages m JOIN professors p ON p.id=m.professor_id WHERE m.id=NEW.message_id AND p.deleted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Deleted professor cannot receive email'); END;

CREATE TABLE campaign_approvals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,approved_at INTEGER NOT NULL,initial_count INTEGER NOT NULL,followup_count INTEGER NOT NULL,sending_account_id TEXT NOT NULL,selection TEXT NOT NULL CHECK(json_valid(selection)));
CREATE TRIGGER campaign_selection_current BEFORE INSERT ON campaign_approvals WHEN (SELECT count(*) FROM json_each(NEW.selection) j JOIN messages m ON m.id=json_extract(j.value,'$.id') JOIN professors p ON p.id=m.professor_id WHERE m.user_id=NEW.user_id AND (m.status='draft' OR (m.status='pending' AND m.live_ready=0)) AND p.deleted_at IS NULL AND m.subject=json_extract(j.value,'$.snapshot.subject') AND m.body=json_extract(j.value,'$.snapshot.body') AND m.scheduled_at=json_extract(j.value,'$.scheduled_at') AND m.timezone=json_extract(j.value,'$.timezone'))<>NEW.initial_count BEGIN SELECT RAISE(ABORT,'Campaign changed; review again'); END;
CREATE TRIGGER campaign_immutable BEFORE UPDATE ON campaign_approvals BEGIN SELECT RAISE(ABORT,'Campaign approval is immutable'); END;
CREATE TRIGGER campaign_retained BEFORE DELETE ON campaign_approvals WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN SELECT RAISE(ABORT,'Campaign audit must be retained'); END;

CREATE TRIGGER cancelled_followup_permanent BEFORE UPDATE OF generated ON automation WHEN OLD.generated=1 AND NEW.generated=0 AND EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=OLD.message_id) BEGIN SELECT RAISE(ABORT,'Cancelled authorized follow-up cannot be rearmed'); END;
