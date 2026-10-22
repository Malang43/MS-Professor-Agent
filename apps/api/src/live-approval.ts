import { z } from "zod";
import { type Env, HttpError, hash } from "./runtime";
import { transportSnapshot, allowedRecipient } from "./automation";
export async function approveGmail(env: Env, user: string, body: unknown) {
  const input = z
    .object({
      ids: z.array(z.string().uuid()).min(1).max(10),
      sending_account_id: z.string().uuid(),
      authorize_followups: z.boolean().default(false),
    })
    .parse(body);
  const ids = [...new Set(input.ids)];
  const rows = await env.DB.prepare(
    "SELECT m.*,COALESCE(m.approved_recipient,p.email) recipient,t.connection_id,t.snapshot,t.state transport_state FROM messages m JOIN professors p ON p.id=m.professor_id LEFT JOIN transports t ON t.message_id=m.id WHERE m.user_id=? AND m.id IN (SELECT value FROM json_each(?))",
  )
    .bind(user, JSON.stringify(ids))
    .all<any>();
  if (rows.results.length !== ids.length)
    throw new HttpError(404, "Message not found.");
  const connection = await env.DB.prepare(
    "SELECT provider,scopes,status FROM connections WHERE id=? AND user_id=?",
  )
    .bind(input.sending_account_id, user)
    .first<any>();
  if (
    connection?.provider !== "gmail" ||
    connection.status !== "connected" ||
    !/gmail.send/.test(connection.scopes)
  )
    throw new HttpError(
      409,
      "Choose a connected Gmail account with sending permission.",
    );
  const attachments = await env.DB.prepare(
    "SELECT message_id,document_id FROM message_attachments WHERE user_id=? AND message_id IN (SELECT value FROM json_each(?))",
  )
    .bind(user, JSON.stringify(ids))
    .all<any>();
  if (ids.length > 1 && attachments.results.length)
    throw new HttpError(400, "Approve messages with attachments individually.");
  const plans = [];
  for (const m of rows.results) {
    if (
      !(m.status === "draft" || (m.status === "pending" && !m.live_ready)) ||
      ["uncertain", "submitting", "leased", "confirmed"].includes(
        m.transport_state,
      )
    )
      throw new HttpError(
        409,
        "Message is already scheduled, cancelled or awaiting reconciliation. Refresh before approving.",
      );
    if (m.connection_id && m.connection_id !== input.sending_account_id)
      throw new HttpError(
        409,
        "This draft is bound to its reviewed sending account.",
      );
    const recipient = m.snapshot
      ? JSON.parse(m.snapshot).recipient
      : m.recipient;
    const snapshot = m.snapshot
      ? JSON.parse(m.snapshot)
      : await transportSnapshot(
          env,
          user,
          input.sending_account_id,
          recipient,
          m.subject,
          m.body,
          attachments.results
            .filter((a) => a.message_id === m.id)
            .map((a) => a.document_id),
          m.id,
        );
    if (!(await allowedRecipient(env, recipient, user)))
      throw new HttpError(
        403,
        "Recipient is outside the current sending mode.",
      );
    const followup =
      input.authorize_followups && m.followup_proposal
        ? JSON.parse(m.followup_proposal)
        : null;
    if (followup && !/gmail.readonly/.test(connection.scopes))
      throw new HttpError(
        409,
        "Reconnect Gmail with reply access before authorizing a follow-up.",
      );
    plans.push({
      id: m.id,
      snapshot,
      followup,
      fingerprint: await hash(
        JSON.stringify([
          snapshot.recipient.toLowerCase(),
          snapshot.subject,
          snapshot.body,
          m.scheduled_at,
        ]),
      ),
    });
  }
  const payload = JSON.stringify(plans);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET approved=1,authorized=CASE WHEN mode='auto' THEN 1 ELSE authorized END,status='pending',live_ready=1,error=NULL,live_fingerprint=(SELECT json_extract(value,'$.fingerprint') FROM json_each(?) WHERE json_extract(value,'$.id')=messages.id) WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND (status='draft' OR (status='pending' AND live_ready=0))",
      ).bind(payload, user, payload),
      env.DB.prepare(
        "INSERT INTO transports(message_id,user_id,connection_id,snapshot) SELECT m.id,m.user_id,?,json_extract(j.value,'$.snapshot') FROM json_each(?) j JOIN messages m ON m.id=json_extract(j.value,'$.id') WHERE m.user_id=? AND m.status='pending' AND m.live_ready=1 ON CONFLICT(message_id) DO NOTHING",
      ).bind(input.sending_account_id, payload, user),
      env.DB.prepare(
        "INSERT INTO automation(message_id,days,subject,body) SELECT m.id,json_extract(j.value,'$.followup.days'),json_extract(j.value,'$.followup.subject'),json_extract(j.value,'$.followup.body') FROM json_each(?) j JOIN messages m ON m.id=json_extract(j.value,'$.id') WHERE m.user_id=? AND m.status='pending' AND m.live_ready=1 AND json_extract(j.value,'$.followup') IS NOT NULL ON CONFLICT(message_id) DO NOTHING",
      ).bind(payload, user),
      env.DB.prepare(
        "INSERT INTO audit(id,user_id,action,entity_id) SELECT lower(hex(randomblob(16))),?,? ,json_extract(value,'$.id') FROM json_each(?)",
      ).bind(
        user,
        input.authorize_followups
          ? "gmail.approved_with_exact_followup"
          : "gmail.approved",
        payload,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /live_fingerprint/.test(error.message))
      throw new HttpError(
        409,
        "An identical recipient, message and schedule is already approved. Review the existing message instead.",
      );
    throw error;
  }
  return Response.json({ ok: true, scheduled: ids.length });
}
export async function retryGmail(env: Env, user: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT t.*,m.status message_status,c.status connection_status FROM transports t JOIN messages m ON m.id=t.message_id JOIN connections c ON c.id=t.connection_id WHERE t.message_id=? AND t.user_id=? AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=m.id)",
  )
    .bind(id, user)
    .first<any>();
  if (
    !row ||
    row.message_status !== "failed" ||
    row.state !== "failed" ||
    row.connection_status !== "connected"
  )
    throw new HttpError(
      409,
      "Only a proven failed send with no receipt can be retried. Uncertain messages are never resent.",
    );
  const snapshot = JSON.parse(row.snapshot);
  if (!(await allowedRecipient(env, snapshot.recipient, user)))
    throw new HttpError(403, "Recipient is outside the current sending mode.");
  const suppressed = await env.DB.prepare(
    "SELECT 1 ok FROM suppressions WHERE user_id=? AND address=?",
  )
    .bind(user, snapshot.recipient.toLowerCase())
    .first();
  if (suppressed) throw new HttpError(409, "This recipient is suppressed.");
  if (
    (
      await env.DB.prepare("SELECT parent_id FROM messages WHERE id=?")
        .bind(id)
        .first<any>()
    )?.parent_id
  )
    throw new HttpError(
      409,
      "Failed follow-ups require a separately approved new message.",
    );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status='pending',error=NULL,approved=1,live_ready=1 WHERE id=? AND user_id=? AND status='failed'",
    ).bind(id, user),
    env.DB.prepare(
      "UPDATE transports SET state='waiting',next_at=0,max_attempts=attempts+3 WHERE message_id=? AND user_id=? AND state='failed'",
    ).bind(id, user),
    env.DB.prepare(
      "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,'gmail.retry_authorized',?)",
    ).bind(crypto.randomUUID(), user, id),
  ]);
  return Response.json({ ok: true });
}
