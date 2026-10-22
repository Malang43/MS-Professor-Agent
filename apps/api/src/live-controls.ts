import { type Env, HttpError } from "./runtime";
import { accessToken, oauthAvailable } from "./oauth";
import { type Fetcher } from "./providers";
export function isLiveOwner(env: Env, user: string) {
  return (
    !env.LIVE_OWNER_USER_IDS?.trim() ||
    env.LIVE_OWNER_USER_IDS.split(",")
      .map((v) => v.trim())
      .includes(user)
  );
}
export function testRecipients(env: Env) {
  return (env.LIVE_TEST_RECIPIENTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}
export async function productionEnabled(env: Env, user: string) {
  return (
    isLiveOwner(env, user) &&
    !!(
      await env.DB.prepare(
        "SELECT production_enabled FROM outreach_settings WHERE user_id=?",
      )
        .bind(user)
        .first<{ production_enabled: number }>()
    )?.production_enabled
  );
}
export async function activationEvidence(env: Env, user: string) {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT lower(json_extract(t.snapshot,'$.recipient')) address FROM transports t JOIN deliveries d ON d.message_id=t.message_id WHERE t.user_id=? AND d.provider='gmail' AND t.state='confirmed' AND t.provider_id IS NOT NULL",
  )
    .bind(user)
    .all<{ address: string }>();
  const recipients = testRecipients(env);
  const delivered =
    recipients.length > 0 &&
    recipients.every((address) =>
      rows.results.some((r) => r.address === address),
    );
  const reply = await env.DB.prepare(
    "SELECT 1 ok FROM mailbox_events e JOIN transports t ON t.message_id=e.message_id WHERE t.user_id=? AND e.kind='reply' AND lower(json_extract(t.snapshot,'$.recipient')) IN (SELECT value FROM json_each(?)) LIMIT 1",
  )
    .bind(user, JSON.stringify(recipients))
    .first();
  return {
    delivered,
    reply_detected: !!reply,
    can_activate: delivered && !!reply,
  };
}
export async function changeProductionMode(
  env: Env,
  user: string,
  enabled: boolean,
) {
  if (!isLiveOwner(env, user) || !env.LIVE_OWNER_USER_IDS?.trim())
    throw new HttpError(
      403,
      "Only the configured owner may activate professor outreach.",
    );
  if (enabled && !(await activationEvidence(env, user)).can_activate)
    throw new HttpError(
      409,
      "First approve and deliver a controlled Gmail test to each test recipient, then reply to one test and check replies.",
    );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO outreach_settings(user_id,production_enabled,activated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET production_enabled=excluded.production_enabled,activated_at=excluded.activated_at",
    ).bind(user, +enabled, enabled ? Date.now() : null),
    env.DB.prepare(
      "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,'')",
    ).bind(
      crypto.randomUUID(),
      user,
      enabled ? "outreach.production_activated" : "outreach.test_mode_restored",
    ),
  ]);
}
// A read-only Gmail call verifies decryption, refresh and provider access. No send API.
export async function checkGmail(env: Env, network: Fetcher = fetch) {
  if (!oauthAvailable(env, "gmail")) return;
  const rows = await env.DB.prepare(
    "SELECT c.* FROM connections c LEFT JOIN mailbox_checks k ON k.connection_id=c.id WHERE c.provider='gmail' AND c.status='connected' AND (k.checked_at IS NULL OR k.checked_at<?) ORDER BY COALESCE(k.checked_at,0) LIMIT 1",
  )
    .bind(Date.now() - 3600000)
    .all<any>();
  for (const row of rows.results) {
    if (!isLiveOwner(env, row.user_id)) continue;
    let status = "failed",
      detail = "Mailbox check failed; review connection or reconnect.";
    try {
      if (!/gmail.send/.test(row.scopes) || !/gmail.readonly/.test(row.scopes))
        throw new Error("scopes");
      const token = await accessToken(env, row, network);
      const response = await network.call(
        globalThis,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        {
          headers: { Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("profile");
      }
      const data = (await response.json()) as { emailAddress?: string };
      if (data.emailAddress?.toLowerCase() !== row.address.toLowerCase())
        throw new Error("identity");
      status = "ready";
      detail =
        "Gmail identity, encrypted token access, send/reply scopes and refresh path verified. No email sent.";
    } catch {
      /* Never persist provider payloads or secrets. */
    }
    await env.DB.prepare(
      "INSERT INTO mailbox_checks(connection_id,checked_at,status,detail) VALUES(?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,detail=excluded.detail",
    )
      .bind(row.id, Date.now(), status, detail)
      .run();
  }
}
