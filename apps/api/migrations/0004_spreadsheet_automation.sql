DROP TRIGGER stop_followup_on_status;
DROP TRIGGER stop_suppressed_recipient;
-- Preserve all existing plans and generated/cancelled state while widening delays.
CREATE TABLE automation_v4(message_id TEXT PRIMARY KEY REFERENCES messages(id), days INTEGER NOT NULL CHECK(days BETWEEN 1 AND 30), subject TEXT NOT NULL, body TEXT NOT NULL, generated INTEGER NOT NULL DEFAULT 0);
INSERT INTO automation_v4 SELECT * FROM automation;
DROP TABLE automation;
ALTER TABLE automation_v4 RENAME TO automation;
ALTER TABLE messages ADD COLUMN followup_proposal TEXT;
ALTER TABLE messages ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX messages_import_key ON messages(user_id,import_key) WHERE import_key IS NOT NULL;

CREATE TRIGGER stop_followup_on_status AFTER UPDATE OF status ON messages WHEN NEW.status IN ('replied','cancelled','failed') BEGIN
 UPDATE automation SET generated=1 WHERE message_id=NEW.id;
 UPDATE messages SET status='cancelled' WHERE parent_id=NEW.id AND status IN ('draft','pending');
END;
CREATE TRIGGER stop_suppressed_recipient AFTER INSERT ON suppressions BEGIN
 UPDATE automation SET generated=1 WHERE message_id IN (SELECT message_id FROM transports WHERE user_id=NEW.user_id AND lower(json_extract(snapshot,'$.recipient'))=NEW.address);
 UPDATE messages SET status='cancelled' WHERE user_id=NEW.user_id AND status IN ('draft','pending') AND id IN (SELECT message_id FROM transports WHERE user_id=NEW.user_id AND lower(json_extract(snapshot,'$.recipient'))=NEW.address);
END;

