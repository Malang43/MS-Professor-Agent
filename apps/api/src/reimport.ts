import { type Env } from "./runtime";
// Run in the same D1 batch as the new active record. Never touches old messages,
// approvals, transports, or explicit recipient suppressions.
export function reimportDeleted(env: Env, user: string, emails: string[]) {
  const payload = JSON.stringify([...new Set(emails)]);
  return [
    env.DB.prepare(
      "INSERT INTO audit(id,user_id,action,entity_id) SELECT lower(hex(randomblob(16))),user_id,'professor.reimported_as_new',id FROM professors WHERE user_id=? AND deleted_at IS NOT NULL AND email IN (SELECT value FROM json_each(?))",
    ).bind(user, payload),
    env.DB.prepare(
      "DELETE FROM suppressions WHERE user_id=? AND reason='professor_deleted' AND address IN (SELECT email FROM professors WHERE user_id=? AND deleted_at IS NOT NULL AND email IN (SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM messages m JOIN professors p ON p.id=m.professor_id LEFT JOIN transports t ON t.message_id=m.id WHERE m.user_id=suppressions.user_id AND lower(COALESCE(json_extract(t.snapshot,'$.recipient'),m.approved_recipient,p.deleted_email,p.email))=suppressions.address AND (EXISTS(SELECT 1 FROM audit a WHERE a.user_id=m.user_id AND a.entity_id=m.id AND a.action IN ('recipient.decline','recipient.opt_out','recipient.bounce')) OR EXISTS(SELECT 1 FROM mailbox_events e WHERE e.message_id=m.id AND e.kind IN ('decline','opt_out','bounce'))))",
    ).bind(user, user, payload),
    env.DB.prepare(
      "UPDATE professors SET deleted_email=COALESCE(deleted_email,email),email=id || '@deleted.invalid' WHERE user_id=? AND deleted_at IS NOT NULL AND email IN (SELECT value FROM json_each(?))",
    ).bind(user, payload),
  ];
}
