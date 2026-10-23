import { z } from "zod";
import { type Env, HttpError, hash } from "./runtime";
import { transportSnapshot, allowedRecipient, liveEnabled } from "./automation";
import {
  productionEnabled,
  isLiveOwner,
  testRecipients,
} from "./live-controls";
import { oauthAvailable } from "./oauth";
export async function approveGmail(env: Env, user: string, body: unknown) {
  const input = z
    .object({
      ids: z.array(z.string().uuid()).min(1).max(25),
      sending_account_id: z.string().uuid(),
      authorize_followups: z.boolean().default(false),
    })
    .parse(body);
  const ids = [...new Set(input.ids)];
  const rows = await env.DB.prepare(
    "SELECT m.*,p.deleted_at,p.archived_at professor_archived_at,CASE WHEN a.message_id IS NOT NULL AND a.generated=0 THEN json_object('days',a.days,'subject',a.subject,'body',a.body) ELSE m.followup_proposal END effective_followup,COALESCE(m.approved_recipient,p.email) recipient,t.connection_id,t.snapshot,t.state transport_state FROM messages m JOIN professors p ON p.id=m.professor_id LEFT JOIN transports t ON t.message_id=m.id LEFT JOIN automation a ON a.message_id=m.id WHERE m.user_id=? AND m.id IN (SELECT value FROM json_each(?))",
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
  const readiness = await env.DB.prepare(
    "SELECT status,checked_at FROM mailbox_checks WHERE connection_id=?",
  )
    .bind(input.sending_account_id)
    .first<any>();
  if (
    readiness?.status !== "ready" ||
    readiness.checked_at < Date.now() - 3600000
  )
    throw new HttpError(
      409,
      "Gmail provider verification is not ready. Open Settings, resolve the displayed issue and click Verify Gmail connection before approving.",
    );
  const attachments = await env.DB.prepare(
    "SELECT message_id,document_id FROM message_attachments WHERE user_id=? AND message_id IN (SELECT value FROM json_each(?))",
  )
    .bind(user, JSON.stringify(ids))
    .all<any>();
  if (ids.length > 1 && attachments.results.length)
    throw new HttpError(400, "Approve messages with attachments individually.");
  if (
    !liveEnabled(env) ||
    !isLiveOwner(env, user) ||
    !oauthAvailable(env, "gmail")
  )
    throw new HttpError(
      403,
      "Gmail sending is not available for this account.",
    );
  const production = await productionEnabled(env, user),
    permitted = testRecipients(env);
  const suppressed = await env.DB.prepare(
    "SELECT address FROM suppressions WHERE user_id=?",
  )
    .bind(user)
    .all<{ address: string }>();
  const plans = [];
  for (const m of rows.results) {
    if (m.deleted_at)
      throw new HttpError(409, "A deleted professor cannot receive email.");
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
    if (suppressed.results.some((r) => r.address === recipient.toLowerCase()))
      throw new HttpError(409, "A selected recipient is deleted or opted out.");
    if (!production && !permitted.includes(recipient.toLowerCase()))
      throw new HttpError(
        403,
        "Recipient is outside the current sending mode.",
      );
    const docs = attachments.results
      .filter((a) => a.message_id === m.id)
      .map((a) => a.document_id);
    const snapshot = m.snapshot
      ? JSON.parse(m.snapshot)
      : docs.length
        ? await transportSnapshot(
            env,
            user,
            input.sending_account_id,
            recipient,
            m.subject,
            m.body,
            docs,
            m.id,
          )
        : {
            recipient,
            subject: m.subject,
            body: m.body,
            attachments: [],
            key: m.id + "@ms-professor-agent.invalid",
          };
    let followup = null;
    if (input.authorize_followups) {
      if (!m.effective_followup)
        throw new HttpError(
          400,
          "Missing follow-up content for " +
            recipient +
            ". Supply its exact subject, body and 1-30 day delay, or choose initial emails only.",
        );
      followup = z
        .object({
          days: z.number().int().min(1).max(30),
          subject: z
            .string()
            .min(1)
            .max(500)
            .refine((v) => !/[\r\n]/.test(v)),
          body: z.string().min(1).max(20000),
        })
        .parse(JSON.parse(m.effective_followup));
    }
    if (followup && !/gmail.readonly/.test(connection.scopes))
      throw new HttpError(
        409,
        "Reconnect Gmail with reply access before authorizing a follow-up.",
      );
    plans.push({
      id: m.id,
      snapshot,
      followup,
      scheduled_at: m.scheduled_at,
      timezone: m.timezone,
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
  const payload = JSON.stringify(plans),
    campaignId = crypto.randomUUID(),
    authorizedAt = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO campaign_approvals(id,user_id,approved_at,initial_count,followup_count,sending_account_id,selection) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        campaignId,
        user,
        authorizedAt,
        ids.length,
        plans.filter((p) => p.followup).length,
        input.sending_account_id,
        payload,
      ),
      env.DB.prepare(
        "UPDATE messages SET approved=1,authorized=CASE WHEN mode='auto' THEN 1 ELSE authorized END,status='pending',live_ready=1,error=NULL,live_fingerprint=(SELECT json_extract(value,'$.fingerprint') FROM json_each(?) WHERE json_extract(value,'$.id')=messages.id) WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND (status='draft' OR (status='pending' AND live_ready=0))",
      ).bind(payload, user, payload),
      env.DB.prepare(
        "INSERT INTO transports(message_id,user_id,connection_id,snapshot) SELECT m.id,m.user_id,?,json_extract(j.value,'$.snapshot') FROM json_each(?) j JOIN messages m ON m.id=json_extract(j.value,'$.id') WHERE m.user_id=? AND m.status='pending' AND m.live_ready=1 ON CONFLICT(message_id) DO NOTHING",
      ).bind(input.sending_account_id, payload, user),
      env.DB.prepare(
        "UPDATE automation SET generated=1,cancel_reason='initial_only' WHERE message_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ?=0",
      ).bind(payload, +input.authorize_followups),
      env.DB.prepare(
        "INSERT INTO automation(message_id,days,subject,body) SELECT m.id,json_extract(j.value,'$.followup.days'),json_extract(j.value,'$.followup.subject'),json_extract(j.value,'$.followup.body') FROM json_each(?) j JOIN messages m ON m.id=json_extract(j.value,'$.id') WHERE m.user_id=? AND m.status='pending' AND m.live_ready=1 AND json_extract(j.value,'$.followup') IS NOT NULL ON CONFLICT(message_id) DO UPDATE SET generated=0,cancel_reason=NULL,days=excluded.days,subject=excluded.subject,body=excluded.body",
      ).bind(payload, user),
      env.DB.prepare(
        "INSERT INTO message_authorizations(message_id,user_id,campaign_id,snapshot,authorized_at,followup_authorized) SELECT json_extract(value,'$.id'),?,?,json_object('initial',json(json_extract(value,'$.snapshot')),'sending_account_id',?,'scheduled_at',json_extract(value,'$.scheduled_at'),'timezone',json_extract(value,'$.timezone'),'followup',json(json_extract(value,'$.followup')),'condition','only_if_no_reply','maximum_followups',CASE WHEN json_extract(value,'$.followup') IS NULL THEN 0 ELSE 1 END),?,CASE WHEN json_extract(value,'$.followup') IS NULL THEN 0 ELSE 1 END FROM json_each(?)",
      ).bind(user, campaignId, input.sending_account_id, authorizedAt, payload),
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
    if (
      error instanceof Error &&
      /live_fingerprint|message_authorizations|Campaign changed/.test(
        error.message,
      )
    )
      throw new HttpError(
        409,
        "An identical recipient, message and schedule is already approved. Review the existing message instead.",
      );
    throw error;
  }
  return Response.json({
    ok: true,
    scheduled: ids.length,
    campaign_id: campaignId,
    authorized_followups: plans.filter((p) => p.followup).length,
    total_messages: ids.length + plans.filter((p) => p.followup).length,
  });
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
