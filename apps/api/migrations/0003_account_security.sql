-- Additive only. Existing accounts retain legacy access, without claiming email verification.
ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN legacy_access INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
CREATE TABLE account_tokens(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires_at INTEGER NOT NULL);
CREATE INDEX account_tokens_owner ON account_tokens(user_id,purpose);
-- Only opaque storage identifiers survive account deletion until purge/TTL accounting completes.
CREATE TABLE account_deletion_objects(object_key TEXT PRIMARY KEY, backend TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, purged INTEGER NOT NULL DEFAULT 0);
UPDATE users SET display_name=COALESCE((SELECT name FROM profiles WHERE user_id=users.id),'');
