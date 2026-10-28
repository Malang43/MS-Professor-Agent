import { z } from "zod";
import { type Env, HttpError } from "./runtime";
export async function recordAction(
  req: Request,
  env: Env,
  user: string,
  path: string,
  method: string,
): Promise<Response | null> {
  const match = path.match(
    /^\/api\/(professors|messages)\/([^/]+)\/(archive|restore|delete|remove)$/,
  );
  if (!match || method !== "POST") return null;
  const [, table, id, action] = match;
  if (
    (table === "professors" && action === "remove") ||
    (table === "messages" && action === "delete")
  )
    throw new HttpError(404, "Not found");
  const row = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id=? AND user_id=?`,
  )
    .bind(id, user)
    .first<any>();
  if (!row) throw new HttpError(404, "Record not found");
  if (table === "professors" && row.deleted_at)
    throw new HttpError(
      409,
      "This professor record was removed. Import the address again to create a new record and campaign.",
    );
  if (action === "delete" || action === "remove")
    z.object({ confirmed: z.literal(true) }).parse(await req.json());
  const now = Date.now();
  const audit = env.DB.prepare(
    "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,?)",
  ).bind(crypto.randomUUID(), user, table + "." + action, id);
  if (action === "delete") {
    await env.DB.batch([
      // Keep the minimum address/ID tombstone and immutable delivery/authorization
      // history. Remove the profile details, and stop every future send atomically.
      env.DB.prepare(
        "UPDATE professors SET deleted_at=?,archived_at=?,name='Deleted professor',university='',interests='',source_url=NULL,verified_at=NULL WHERE id=? AND user_id=? AND deleted_at IS NULL",
      ).bind(now, now, id, user),
      audit,
    ]);
  } else if (action === "remove") {
    if (!["sent", "replied", "failed", "cancelled"].includes(row.status))
      throw new HttpError(
        409,
        "Cancel an unsent message before removing it from the dashboard.",
      );
    const uncertain = await env.DB.prepare(
      "SELECT 1 ok FROM transports WHERE message_id=? AND state IN ('uncertain','submitting','leased')",
    )
      .bind(id)
      .first();
    if (uncertain)
      throw new HttpError(
        409,
        "A message awaiting provider reconciliation must remain visible.",
      );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET hidden_at=? WHERE id=? AND user_id=?",
      ).bind(now, id, user),
      env.DB.prepare(
        "UPDATE automation SET generated=1,cancel_reason=COALESCE(cancel_reason,'dashboard_removed') WHERE message_id=?",
      ).bind(id),
      env.DB.prepare(
        "UPDATE followup_steps SET cancel_reason=COALESCE(cancel_reason,'dashboard_removed') WHERE root_id=?",
      ).bind(id),
      env.DB.prepare(
        "UPDATE messages SET status='cancelled' WHERE status IN ('draft','pending') AND id IN (SELECT child_id FROM followup_steps WHERE root_id=?)",
      ).bind(id),
      env.DB.prepare(
        "UPDATE messages SET status='cancelled' WHERE parent_id=? AND user_id=? AND status IN ('draft','pending')",
      ).bind(id, user),
      audit,
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${table} SET archived_at=?${table === "messages" && action === "restore" ? ",hidden_at=NULL" : ""} WHERE id=? AND user_id=?`,
      ).bind(action === "archive" ? now : null, id, user),
      audit,
    ]);
  }
  return Response.json({
    ok: true,
    retained_operational_audit: true,
    recalls_delivered_mail: false,
  });
}
