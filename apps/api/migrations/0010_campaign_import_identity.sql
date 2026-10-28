CREATE TABLE campaign_imports (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,id)
);
ALTER TABLE messages ADD COLUMN campaign_import_id TEXT;
CREATE UNIQUE INDEX campaign_import_recipient ON messages(user_id,campaign_import_id,approved_recipient) WHERE campaign_import_id IS NOT NULL AND parent_id IS NULL;
CREATE TRIGGER campaign_import_consistent BEFORE INSERT ON campaign_imports WHEN EXISTS(SELECT 1 FROM campaign_imports WHERE user_id=NEW.user_id AND id=NEW.id AND payload_hash<>NEW.payload_hash) BEGIN SELECT RAISE(ABORT,'Import changed; start a new campaign'); END;
CREATE TRIGGER campaign_import_message_owner BEFORE INSERT ON messages WHEN NEW.campaign_import_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campaign_imports WHERE user_id=NEW.user_id AND id=NEW.campaign_import_id) BEGIN SELECT RAISE(ABORT,'Campaign import owner mismatch'); END;
CREATE TRIGGER campaign_import_message_immutable BEFORE UPDATE OF campaign_import_id ON messages WHEN NEW.campaign_import_id IS NOT OLD.campaign_import_id BEGIN SELECT RAISE(ABORT,'Campaign import identity is immutable'); END;

UPDATE suppressions SET reason='historical_recipient_block' WHERE reason='professor_deleted' AND EXISTS(
 SELECT 1 FROM messages m JOIN professors p ON p.id=m.professor_id LEFT JOIN transports t ON t.message_id=m.id
 WHERE m.user_id=suppressions.user_id AND lower(COALESCE(json_extract(t.snapshot,'$.recipient'),m.approved_recipient,p.deleted_email,p.email))=suppressions.address
 AND (EXISTS(SELECT 1 FROM audit a WHERE a.user_id=m.user_id AND a.entity_id=m.id AND a.action IN ('recipient.decline','recipient.opt_out','recipient.bounce'))
 OR EXISTS(SELECT 1 FROM mailbox_events e WHERE e.message_id=m.id AND e.kind IN ('decline','opt_out','bounce')))
);
INSERT INTO audit(id,user_id,action,entity_id) SELECT lower(hex(randomblob(16))),user_id,'recipient.deletion_only_restriction_removed',address FROM suppressions WHERE reason='professor_deleted';
DELETE FROM suppressions WHERE reason='professor_deleted';
DROP TRIGGER deleted_professor_cancellation;
CREATE TRIGGER deleted_professor_cancellation AFTER UPDATE OF deleted_at ON professors WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
 UPDATE messages SET status='cancelled',error='Professor deleted; no further sending' WHERE professor_id=NEW.id AND user_id=NEW.user_id AND status IN ('draft','pending');
 UPDATE automation SET generated=1,cancel_reason='professor_deleted' WHERE message_id IN (SELECT id FROM messages WHERE professor_id=NEW.id AND user_id=NEW.user_id);
END;
UPDATE followup_steps SET cancel_reason=COALESCE(cancel_reason,'dashboard_removed') WHERE root_id IN (SELECT id FROM messages WHERE hidden_at IS NOT NULL);
UPDATE messages SET status='cancelled' WHERE status IN ('draft','pending') AND id IN (SELECT child_id FROM followup_steps WHERE cancel_reason IS NOT NULL);
