import { type Env, HttpError, consume, notify, random, hash } from "./runtime";
import { accessToken, oauthAvailable } from "./oauth";
import { isLiveOwner, productionEnabled } from "./live-controls";
import {
  emailProvider,
  ProviderError,
  type ProviderName,
  type Fetcher,
  type Receipt,
} from "./providers";
import { readyDocument, documentBytes, FILE_LIMIT } from "./storage";
export function liveEnabled(env: Env) {
  return (
    env.LIVE_EMAIL_ENABLED === "true" &&
    env.OAUTH_ENABLED === "true" &&
    !!env.TOKEN_ENCRYPTION_KEY &&
    !!env.LIVE_TEST_RECIPIENTS?.trim()
  );
}
export async function allowedRecipient(
  env: Env,
  address: string,
  user?: string,
) {
  if (!liveEnabled(env) || (user && !isLiveOwner(env, user))) return false;
  return (
    (env.LIVE_TEST_RECIPIENTS || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .includes(address.toLowerCase()) ||
    (!!user && (await productionEnabled(env, user)))
  );
}
export type Snapshot = {
  recipient: string;
  subject: string;
  body: string;
  attachments: {
    id: string;
    checksum: string | null;
    size: number;
    name: string;
    content_type: string;
  }[];
  key: string;
  threadId?: string;
  inReplyTo?: string;
};
export async function transportSnapshot(
  env: Env,
  user: string,
  connectionId: string,
  recipient: string,
  subject: string,
  body: string,
  attachments: string[],
  messageId: string,
) {
  if (!(await allowedRecipient(env, recipient, user)))
    throw new HttpError(
      403,
      "Live sending is disabled or this controlled test recipient is not authorized.",
    );
  const connection = await env.DB.prepare(
    "SELECT * FROM connections WHERE id=? AND user_id=? AND status='connected'",
  )
    .bind(connectionId, user)
    .first<any>();
  if (!connection) throw new HttpError(404, "Sending account not found");
  if (connection.provider === "gmail" && !/gmail.send/.test(connection.scopes))
    throw new HttpError(409, "Reconnect Gmail with sending permission.");
  if (
    connection.provider === "outlook" &&
    !/\bMail.Read\b/.test(connection.scopes)
  )
    throw new HttpError(
      409,
      "Reconnect Outlook with reply access to confirm sent messages.",
    );
  if (!oauthAvailable(env, connection.provider))
    throw new HttpError(503, "Sending provider configuration is incomplete.");
  const docs = [];
  let total = 0;
  for (const id of new Set(attachments)) {
    const doc = await readyDocument(env, user, id);
    total += doc.size;
    docs.push({
      id,
      checksum: doc.checksum,
      size: doc.size,
      name: doc.name,
      content_type: doc.content_type,
    });
  }
  if (total > FILE_LIMIT || docs.length > 3)
    throw new HttpError(
      400,
      "Live email supports at most 3 attachments totaling 2 MiB.",
    );
  return {
    recipient,
    subject,
    body,
    attachments: docs,
    key: messageId + "@ms-professor-agent.invalid",
  } satisfies Snapshot;
}
async function receipt(env: Env, row: any, result: Receipt) {
  if (!result.id) return;
  const acceptedAt = result.acceptedAt || new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries(message_id,provider,provider_id) VALUES(?,?,?)",
    ).bind(row.message_id, row.provider, row.connection_id + ":" + result.id),
    env.DB.prepare(
      "UPDATE delivery_attempts SET outcome='accepted' WHERE message_id=? AND attempt=(SELECT attempts FROM transports WHERE message_id=?)",
    ).bind(row.message_id, row.message_id),
    env.DB.prepare(
      "UPDATE transports SET state='confirmed',provider_id=?,thread_id=?,lease=NULL,lease_until=0,next_sync=? WHERE message_id=?",
    ).bind(result.id, result.threadId, Date.now() + 300000, row.message_id),
    env.DB.prepare(
      "UPDATE messages SET status='sent',sent_at=? WHERE id=? AND status='pending'",
    ).bind(acceptedAt, row.message_id),
    env.DB.prepare(
      "UPDATE automation SET due_at=?+days*86400000 WHERE message_id=? AND due_at IS NULL",
    ).bind(Date.parse(acceptedAt), row.message_id),
    env.DB.prepare(
      "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,'provider.sent_confirmed',?)",
    ).bind(crypto.randomUUID(), row.user_id, row.message_id),
  ]);
}
async function fail(env: Env, row: any, kind: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE transports SET state='failed',lease=NULL WHERE message_id=?",
    ).bind(row.message_id),
    env.DB.prepare(
      "UPDATE messages SET status='failed',error=? WHERE id=? AND status='pending'",
    ).bind(
      kind === "reconnect"
        ? "Reconnect your sending account."
        : "Email could not be sent. Review the notification.",
      row.message_id,
    ),
  ]);
  await notify(
    env,
    row.user_id,
    kind,
    kind === "reconnect"
      ? "Reconnect your mailbox before scheduling new mail."
      : "Email failed before confirmed delivery. Review before trying again.",
    row.message_id,
  );
}
export async function runLiveJobs(env: Env, network: Fetcher = fetch) {
  if (env.OAUTH_ENABLED !== "true" || !env.TOKEN_ENCRYPTION_KEY) return;
  const maySend = liveEnabled(env);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE transports SET state='uncertain',next_at=?,lease=NULL WHERE state='submitting' AND lease_until<?",
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    "UPDATE transports SET state='waiting',lease=NULL WHERE state='leased' AND lease_until<?",
  )
    .bind(now)
    .run();
  const rows = await env.DB.prepare(
    `SELECT t.*,c.provider,c.address,c.subject AS account_subject,c.status AS account_status,c.scopes,c.tokens,c.expires_at,c.refresh_until,c.refresh_lease,m.status AS message_status,m.parent_id FROM transports t JOIN messages m ON m.id=t.message_id JOIN connections c ON c.id=t.connection_id JOIN profiles p ON p.user_id=t.user_id WHERE t.state IN ('waiting','uncertain') AND t.next_at<=? AND ((t.state='uncertain') OR (?=1 AND m.status='pending' AND m.live_ready=1 AND NOT EXISTS(SELECT 1 FROM professors pr WHERE pr.id=m.professor_id AND pr.deleted_at IS NOT NULL) AND m.approved=1 AND (m.mode!='auto' OR m.authorized=1) AND m.scheduled_at<=? AND p.paused=0 AND p.stopped=0)) ORDER BY t.next_at,t.message_id LIMIT 1`,
  )
    .bind(now, +maySend, new Date().toISOString())
    .all<any>();
  for (const row of rows.results) {
    const snapshot = JSON.parse(row.snapshot) as Snapshot;
    if (
      row.state !== "uncertain" &&
      !(await allowedRecipient(env, snapshot.recipient, row.user_id))
    )
      continue;
    if (!oauthAvailable(env, row.provider)) continue;
    if (row.account_status !== "connected") {
      if (row.state !== "uncertain") await fail(env, row, "reconnect");
      continue;
    }
    const connection = {
      ...row,
      id: row.connection_id,
      status: row.account_status,
    };
    const provider = emailProvider(row.provider as ProviderName, network);
    if (row.state === "uncertain") {
      const lease = random();
      const claimed = await env.DB.prepare(
        "UPDATE transports SET next_at=?,lease=? WHERE message_id=? AND state='uncertain' AND next_at<=? RETURNING message_id",
      )
        .bind(now + 300000, lease, row.message_id, now)
        .first();
      if (!claimed) continue;
      try {
        const token = await accessToken(env, connection, network);
        const found = await provider.reconcile(token, snapshot.key);
        if (found?.id) await receipt(env, row, found);
      } catch (error) {
        if (error instanceof ProviderError && error.kind === "reconnect") {
          await env.DB.prepare(
            "UPDATE connections SET status='reconnect',tokens=NULL WHERE id=?",
          )
            .bind(row.connection_id)
            .run();
          await notify(
            env,
            row.user_id,
            "reconnect",
            "Reconnect with reply access to reconcile the uncertain delivery. It will not be automatically resent.",
            row.message_id,
          );
        }
        /* Never retry a send because reconciliation failed or found nothing. */
      }
      continue;
    }
    if (row.parent_id) {
      // A queued child may wait through quota backoff. Recheck its parent thread
      // at submission time; a failed/partial read must invalidate old evidence.
      const checkedAfter = Date.now();
      await env.DB.prepare(
        "UPDATE transports SET sync_checked_at=0 WHERE message_id=?",
      )
        .bind(row.parent_id)
        .run();
      await syncReplies(env, network, row.user_id, row.parent_id);
      const parent = await env.DB.prepare(
        "SELECT m.status,t.sync_checked_at,t.sync_cursor FROM messages m JOIN transports t ON t.message_id=m.id WHERE m.id=? AND m.user_id=?",
      )
        .bind(row.parent_id, row.user_id)
        .first<any>();
      if (
        !parent ||
        parent.status !== "sent" ||
        parent.sync_cursor ||
        parent.sync_checked_at < checkedAfter
      )
        continue;
    }
    const suppressed = await env.DB.prepare(
      "SELECT address FROM suppressions WHERE user_id=? AND address=?",
    )
      .bind(row.user_id, snapshot.recipient.toLowerCase())
      .first();
    if (suppressed) {
      await fail(env, row, "suppressed");
      continue;
    }
    if (row.attempts >= row.max_attempts) {
      await fail(env, row, "failed");
      continue;
    }
    const lease = random();
    const claimed = await env.DB.prepare(
      `UPDATE transports SET state='leased',lease=?,lease_until=? WHERE message_id=? AND state='waiting' AND next_at<=? RETURNING message_id`,
    )
      .bind(lease, now + 120000, row.message_id, now)
      .first();
    if (!claimed) continue;
    let submitted = false;
    try {
      await consume(
        env,
        `send:${row.user_id}:minute`,
        1,
        1,
        new Date().toISOString().slice(0, 16),
      );
      await consume(env, `send:${row.user_id}:day`, 10);
      await consume(env, "send:global:day", 100);
      // Same provider identity shares a budget even across application users.
      const mailbox = await hash(row.provider + ":" + row.account_subject);
      await consume(
        env,
        `send:mailbox:${mailbox}:minute`,
        1,
        1,
        new Date().toISOString().slice(0, 16),
      );
      await consume(env, `send:mailbox:${mailbox}:day`, 10);
      const token = await accessToken(env, connection, network),
        attachments = [];
      for (const attachment of snapshot.attachments) {
        const doc = await readyDocument(env, row.user_id, attachment.id);
        if (
          doc.checksum !== attachment.checksum ||
          doc.size !== attachment.size
        )
          throw new HttpError(409, "Approved attachment changed.");
        attachments.push({
          name: attachment.name,
          type: attachment.content_type,
          bytes: await documentBytes(env, doc),
        });
      }
      if (row.parent_id) {
        const checkedAfter = Date.now();
        await env.DB.prepare(
          "UPDATE transports SET sync_checked_at=0 WHERE message_id=?",
        )
          .bind(row.parent_id)
          .run();
        await syncReplies(env, network, row.user_id, row.parent_id);
        const parent = await env.DB.prepare(
          "SELECT m.status,t.sync_checked_at,t.sync_cursor FROM messages m JOIN transports t ON t.message_id=m.id WHERE m.id=? AND m.user_id=?",
        )
          .bind(row.parent_id, row.user_id)
          .first<any>();
        if (
          !parent ||
          parent.status !== "sent" ||
          parent.sync_cursor ||
          parent.sync_checked_at < checkedAfter
        )
          throw new HttpError(
            503,
            "A fresh complete reply check is required before sending.",
          );
      }
      // Last D1 fence before the external side effect; do not trust stale approval/account state.
      const fenced = await env.DB.prepare(
        `UPDATE transports SET state='submitting',attempts=attempts+1 WHERE message_id=? AND lease=? AND state='leased' AND EXISTS(SELECT 1 FROM messages m JOIN profiles p ON p.user_id=m.user_id JOIN connections c ON c.id=? WHERE m.id=? AND m.status='pending' AND m.live_ready=1 AND NOT EXISTS(SELECT 1 FROM professors pr WHERE pr.id=m.professor_id AND pr.deleted_at IS NOT NULL) AND m.approved=1 AND (m.mode!='auto' OR m.authorized=1) AND p.paused=0 AND p.stopped=0 AND c.status='connected' AND (m.parent_id IS NULL OR EXISTS(SELECT 1 FROM messages parent WHERE parent.id=m.parent_id AND parent.status='sent'))) AND NOT EXISTS(SELECT 1 FROM suppressions WHERE user_id=? AND address=?) RETURNING message_id`,
      )
        .bind(
          row.message_id,
          lease,
          row.connection_id,
          row.message_id,
          row.user_id,
          snapshot.recipient.toLowerCase(),
        )
        .first();
      if (!fenced) {
        await env.DB.prepare(
          "UPDATE transports SET state='waiting',lease=NULL,next_at=? WHERE message_id=? AND lease=? AND state='leased'",
        )
          .bind(now + 60000, row.message_id, lease)
          .run();
        continue;
      }
      await env.DB.prepare(
        "INSERT INTO delivery_attempts(id,message_id,attempt,started_at,outcome) SELECT ?,message_id,attempts,?,'submitting' FROM transports WHERE message_id=?",
      )
        .bind(crypto.randomUUID(), Date.now(), row.message_id)
        .run();
      submitted = true;
      const result = await provider.send(token, {
        ...snapshot,
        messageKey: snapshot.key,
        attachments,
      });
      if (result.id) await receipt(env, row, result);
      else {
        await env.DB.prepare(
          "UPDATE transports SET state='uncertain',next_at=?,lease=NULL WHERE message_id=?",
        )
          .bind(now + 60000, row.message_id)
          .run();
        await notify(
          env,
          row.user_id,
          "uncertain",
          "Provider accepted the request; sent-message confirmation is pending. No automatic resend will occur.",
          row.message_id,
        );
      }
    } catch (error) {
      await env.DB.prepare(
        "UPDATE delivery_attempts SET outcome=? WHERE message_id=? AND attempt=(SELECT attempts FROM transports WHERE message_id=?)",
      )
        .bind(
          submitted &&
            (!(error instanceof ProviderError) || error.kind === "uncertain")
            ? "uncertain"
            : error instanceof ProviderError
              ? error.kind
              : "failed_before_send",
          row.message_id,
          row.message_id,
        )
        .run();
      if (
        submitted &&
        (!(error instanceof ProviderError) || error.kind === "uncertain")
      ) {
        await env.DB.prepare(
          "UPDATE transports SET state='uncertain',next_at=?,lease=NULL WHERE message_id=?",
        )
          .bind(now + 300000, row.message_id)
          .run();
        await notify(
          env,
          row.user_id,
          "uncertain",
          "Delivery outcome is uncertain. Reconciliation will run before any further action; this email will not be blindly retried.",
          row.message_id,
        );
      } else if (
        (error instanceof ProviderError && error.kind === "retry") ||
        (error instanceof HttpError && [429, 503].includes(error.status))
      ) {
        const delay = Math.max(
          60000,
          Math.min(
            3600000,
            (error instanceof ProviderError ? error.retryAfter * 1000 : 60000) *
              2 ** row.attempts,
          ),
        );
        await env.DB.prepare(
          "UPDATE transports SET state='waiting',next_at=?,lease=NULL WHERE message_id=? AND lease=?",
        )
          .bind(
            now + delay + Math.floor(Math.random() * 1000),
            row.message_id,
            lease,
          )
          .run();
      } else {
        if (error instanceof ProviderError && error.kind === "reconnect") {
          await env.DB.prepare(
            "UPDATE connections SET status='reconnect',tokens=NULL WHERE id=?",
          )
            .bind(row.connection_id)
            .run();
        }
        await fail(
          env,
          row,
          error instanceof ProviderError ? error.kind : "failed",
        );
      }
    }
  }
}
export async function syncReplies(
  env: Env,
  network: Fetcher = fetch,
  user?: string,
  messageId?: string,
) {
  if (env.OAUTH_ENABLED !== "true" || !env.TOKEN_ENCRYPTION_KEY) return;
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT t.*,m.sent_at,c.provider,c.status AS account_status,c.scopes,c.tokens,c.expires_at,c.refresh_until,c.refresh_lease FROM transports t JOIN messages m ON m.id=t.message_id JOIN connections c ON c.id=t.connection_id WHERE t.state='confirmed' AND t.thread_id IS NOT NULL AND (t.next_sync<=? OR t.message_id=?) AND c.status='connected' AND m.sent_at>? AND (? IS NULL OR t.user_id=?) AND (? IS NULL OR t.message_id=?) ORDER BY t.next_sync LIMIT ?`,
  )
    .bind(
      now,
      messageId || null,
      new Date(now - 31 * 86400000).toISOString(),
      user || null,
      user || null,
      messageId || null,
      messageId || null,
      messageId ? 1 : user ? 2 : 1,
    )
    .all<any>();
  for (const row of rows.results) {
    if (!oauthAvailable(env, row.provider)) continue;
    await env.DB.prepare("UPDATE transports SET next_sync=? WHERE message_id=?")
      .bind(now + 300000, row.message_id)
      .run();
    if (!/gmail.readonly|Mail.Read/.test(row.scopes)) continue;
    try {
      await consume(env, "mailbox:global:polls", 1000);
      const token = await accessToken(
        env,
        { ...row, id: row.connection_id, status: row.account_status },
        network,
      );
      const result = await emailProvider(row.provider, network).replies(
        token,
        row.thread_id,
        row.sync_cursor,
      );
      const snapshot = JSON.parse(row.snapshot) as Snapshot;
      const known = new Set(
        (
          await env.DB.prepare(
            "SELECT provider_id FROM mailbox_events WHERE connection_id=? AND message_id=? ORDER BY rowid DESC LIMIT 200",
          )
            .bind(row.connection_id, row.message_id)
            .all<any>()
        ).results.map((event) => event.provider_id),
      );
      let processed = 0,
        partial = false;
      for (const event of result.events) {
        if (known.has(event.id)) continue;
        const sender = (event.sender.match(/<([^>]+)>/)?.[1] || event.sender)
          .trim()
          .toLowerCase();
        if (
          !event.id ||
          !Number.isFinite(Date.parse(event.receivedAt)) ||
          Date.parse(event.receivedAt) <= Date.parse(row.sent_at)
        )
          continue;
        if (!event.bounce && sender !== snapshot.recipient.toLowerCase())
          continue;
        if (processed >= 1) {
          partial = true;
          break;
        }
        processed++;
        const kind = event.bounce
          ? "bounce"
          : /\b(unsubscribe|opt.out|do not contact|not interested|decline|no positions|no openings)\b/i.test(
                event.text,
              )
            ? "decline"
            : "reply";
        await env.DB.batch([
          env.DB.prepare(
            "INSERT OR IGNORE INTO mailbox_events(connection_id,provider_id,message_id,kind,received_at) VALUES(?,?,?,?,?)",
          ).bind(
            row.connection_id,
            event.id,
            row.message_id,
            kind,
            event.receivedAt,
          ),
          env.DB.prepare(
            "UPDATE messages SET status=CASE WHEN ?='bounce' THEN 'failed' ELSE 'replied' END,followup_at=NULL WHERE id=? AND status='sent'",
          ).bind(kind, row.message_id),
          env.DB.prepare(
            "UPDATE automation SET generated=1 WHERE message_id=?",
          ).bind(row.message_id),
          env.DB.prepare(
            "UPDATE messages SET status='cancelled' WHERE parent_id=? AND status IN ('draft','pending')",
          ).bind(row.message_id),
          ...(kind !== "reply"
            ? [
                env.DB.prepare(
                  "INSERT OR IGNORE INTO suppressions(user_id,address,reason) VALUES(?,?,?)",
                ).bind(row.user_id, snapshot.recipient.toLowerCase(), kind),
              ]
            : []),
          env.DB.prepare(
            "INSERT OR IGNORE INTO notifications(id,user_id,kind,message,entity_id) VALUES(?,?,?,?,?)",
          ).bind(
            "event:" + row.connection_id + ":" + event.id,
            row.user_id,
            kind,
            kind === "reply"
              ? "A reply was received. Follow-up automation has stopped."
              : "A decline, opt-out or bounce was detected. Further sending to this recipient is blocked.",
            row.message_id,
          ),
        ]);
      }
      await env.DB.prepare(
        "UPDATE transports SET sync_cursor=?,sync_checked_at=? WHERE message_id=?",
      )
        .bind(
          partial ? row.sync_cursor : result.cursor,
          partial || result.cursor ? 0 : Date.now(),
          row.message_id,
        )
        .run();
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "reconnect") {
        await env.DB.prepare(
          "UPDATE connections SET status='reconnect',tokens=NULL WHERE id=?",
        )
          .bind(row.connection_id)
          .run();
        await notify(
          env,
          row.user_id,
          "reconnect",
          "Reply synchronization needs mailbox reconnection.",
          row.connection_id,
        );
      }
    }
  }
}
export async function queueFollowups(env: Env) {
  if (!liveEnabled(env)) return;
  const rows = await env.DB.prepare(
    `SELECT a.*,m.user_id,m.professor_id,m.timezone,m.sent_at,t.connection_id,t.thread_id,t.snapshot,c.status AS account_status,c.scopes FROM automation a JOIN messages m ON m.id=a.message_id JOIN transports t ON t.message_id=m.id JOIN connections c ON c.id=t.connection_id JOIN profiles p ON p.user_id=m.user_id WHERE a.generated=0 AND NOT EXISTS(SELECT 1 FROM professors pr WHERE pr.id=m.professor_id AND pr.deleted_at IS NOT NULL) AND m.live_ready=1 AND m.parent_id IS NULL AND m.status='sent' AND p.paused=0 AND p.stopped=0 AND c.status='connected' AND t.sync_checked_at>? AND t.sync_cursor IS NULL AND COALESCE(a.due_at,CAST((julianday(m.sent_at)-2440587.5)*86400000 AS INTEGER)+a.days*86400000)<=? LIMIT 1`,
  )
    .bind(Date.now() - 60000, Date.now())
    .all<any>();
  for (const row of rows.results) {
    const snapshot = JSON.parse(row.snapshot) as Snapshot;
    if (
      !(await allowedRecipient(env, snapshot.recipient, row.user_id)) ||
      !/gmail.readonly|Mail.Read/.test(row.scopes)
    )
      continue;
    const suppression = await env.DB.prepare(
      "SELECT address FROM suppressions WHERE user_id=? AND address=?",
    )
      .bind(row.user_id, snapshot.recipient)
      .first();
    if (suppression) continue;
    try {
      for (const doc of snapshot.attachments)
        await readyDocument(env, row.user_id, doc.id);
    } catch {
      await env.DB.prepare(
        "UPDATE automation SET generated=1 WHERE message_id=?",
      )
        .bind(row.message_id)
        .run();
      await notify(
        env,
        row.user_id,
        "followup",
        "Follow-up stopped because an attachment is unavailable.",
        row.message_id,
      );
      continue;
    }
    const id = crypto.randomUUID(),
      now = new Date(
        row.due_at ?? Date.parse(row.sent_at) + row.days * 86400000,
      ).toISOString(),
      next = {
        ...snapshot,
        subject: row.subject,
        body: row.body,
        key: id + "@ms-professor-agent.invalid",
        threadId: row.subject === snapshot.subject ? row.thread_id : undefined,
        inReplyTo: snapshot.key,
      };
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO messages(id,user_id,professor_id,subject,body,mode,authorized,approved,status,scheduled_at,timezone,parent_id,live_ready) SELECT ?,?,?,?,?,'auto',1,1,'pending',?,?,?,1 WHERE EXISTS(SELECT 1 FROM messages m JOIN automation a ON a.message_id=m.id JOIN connections c ON c.id=? WHERE m.id=? AND m.status='sent' AND a.generated=0 AND c.status='connected') AND NOT EXISTS(SELECT 1 FROM suppressions WHERE user_id=? AND address=?)`,
        ).bind(
          id,
          row.user_id,
          row.professor_id,
          row.subject,
          row.body,
          now,
          row.timezone,
          row.message_id,
          row.connection_id,
          row.message_id,
          row.user_id,
          snapshot.recipient,
        ),
        env.DB.prepare(
          "INSERT INTO transports(message_id,user_id,connection_id,snapshot) SELECT id,user_id,?,? FROM messages WHERE id=?",
        ).bind(row.connection_id, JSON.stringify(next), id),
        env.DB.prepare(
          "INSERT INTO message_authorizations(message_id,user_id,campaign_id,kind,parent_id,snapshot,authorized_at,followup_authorized) SELECT m.id,m.user_id,a.campaign_id,'followup',?,json_object('initial',json(?),'sending_account_id',?,'scheduled_at',m.scheduled_at,'timezone',m.timezone,'parent_authorization',a.message_id,'followup',NULL,'condition','only_if_no_reply','maximum_followups',0),a.authorized_at,0 FROM messages m JOIN message_authorizations a ON a.message_id=m.parent_id WHERE m.id=? AND a.followup_authorized=1",
        ).bind(row.message_id, JSON.stringify(next), row.connection_id, id),
        env.DB.prepare(
          "INSERT INTO message_authorizations(message_id,user_id,campaign_id,kind,parent_id,snapshot,authorized_at,followup_authorized) SELECT m.id,m.user_id,'separate:' || f.message_id,'followup',m.parent_id,json_object('initial',json(?),'sending_account_id',?,'parent_authorization',f.message_id,'followup',NULL,'condition','only_if_no_reply','maximum_followups',0),f.authorized_at,0 FROM messages m JOIN followup_approvals f ON f.message_id=m.parent_id WHERE m.id=? AND NOT EXISTS(SELECT 1 FROM message_authorizations WHERE message_id=m.id)",
        ).bind(JSON.stringify(next), row.connection_id, id),
        ...snapshot.attachments.map((doc) =>
          env.DB.prepare(
            "INSERT INTO message_attachments(message_id,document_id,user_id) SELECT id,?,user_id FROM messages WHERE id=?",
          ).bind(doc.id, id),
        ),
        env.DB.prepare(
          "INSERT INTO audit(id,user_id,action,entity_id) SELECT ?,user_id,'followup.preapproved_queued',id FROM messages WHERE id=?",
        ).bind(crypto.randomUUID(), id),
        env.DB.prepare(
          "UPDATE automation SET generated=1 WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE parent_id=?)",
        ).bind(row.message_id, row.message_id),
      ]);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.includes("Message storage quota reached")
      ) {
        await env.DB.prepare(
          "UPDATE automation SET generated=1 WHERE message_id=?",
        )
          .bind(row.message_id)
          .run();
        await notify(
          env,
          row.user_id,
          "followup",
          "Automatic follow-up could not be queued because retained-message capacity was reached. The plan has stopped; review private retention with the operator.",
          row.message_id,
        );
      } else throw error;
    }
  }
}
