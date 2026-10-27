-- Only an explicit later import frees an address; deleted records stay deleted.
ALTER TABLE professors ADD COLUMN deleted_email TEXT;
-- Real opt-outs take precedence even for older INSERT OR IGNORE callers.
CREATE TRIGGER explicit_suppression_precedence BEFORE INSERT ON suppressions
WHEN NEW.reason <> 'professor_deleted'
BEGIN
 UPDATE suppressions SET reason=NEW.reason WHERE user_id=NEW.user_id AND address=NEW.address AND reason='professor_deleted';
END;

ALTER TABLE campaign_approvals ADD COLUMN name TEXT NOT NULL DEFAULT 'Professor outreach campaign';
