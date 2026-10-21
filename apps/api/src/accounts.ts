import { revokeMailboxTokens } from "./oauth";
import { z } from "zod";
import { type Env, HttpError, hash, random, consume } from "./runtime";
import { passwordHash, validPassword, equalHash } from "./passwords";
import { documentStore } from "./storage";
const mail = z
  .string()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const generic =
  "If the account is eligible, a message will arrive when email delivery is configured. Check your inbox and spam folder.";
const ok = () => Response.json({ ok: true, message: generic });
const clear = (req: Request) =>
  `session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;
export function mailReady(env: Env) {
  return (
    env.MAIL_DELIVERY_ENABLED === "true" &&
    env.MAIL_FREE_PLAN_CONFIRMED === "true" &&
    env.MAIL_PROVIDER === "brevo" &&
    !!env.BREVO_API_KEY &&
    !!env.MAIL_FROM &&
    mail.safeParse(env.MAIL_FROM).success
  );
}
async function limits(req: Request, env: Env, action: string, address: string) {
  const period = new Date().toISOString().slice(0, 13);
  await consume(env, `account:${action}:global`, 100, 1, period);
  await consume(
    env,
    `account:${action}:ip:${await hash(req.headers.get("CF-Connecting-IP") || "local")}`,
    15,
    1,
    period,
  );
  await consume(
    env,
    `account:${action}:address:${await hash(address)}`,
    3,
    1,
    period,
  );
}
export async function sendAccountLink(
  env: Env,
  user: any,
  purpose: "verify" | "reset",
  network: typeof fetch = fetch,
) {
  if (!mailReady(env)) return;
  const token = random(),
    expires = Date.now() + (purpose === "verify" ? 86400000 : 1800000);
  await env.DB.prepare(
    "INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES(?,?,?,?)",
  )
    .bind(await hash(token), user.id, purpose, expires)
    .run();
  // A fragment keeps tokens out of HTTP URLs, proxy logs and referrers.
  const link =
    env.APP_ORIGIN + "/#" + purpose + "=" + encodeURIComponent(token);
  try {
    const response = await network("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "api-key": env.BREVO_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: "MS Professor Outreach" },
        to: [{ email: user.email }],
        subject:
          purpose === "verify"
            ? "Verify your email address"
            : "Reset your password",
        textContent: `${purpose === "verify" ? "Confirm your email" : "Reset your password"} by opening this link and confirming in the application:\n${link}\nThis link expires ${purpose === "verify" ? "in 24 hours" : "in 30 minutes"} and can be used once. If you did not request it, ignore this message.`,
      }),
    });
    if (!response.ok) console.warn("account_mail_failure", "provider_rejected");
    await response.body?.cancel();
  } catch {
    console.warn("account_mail_failure", "transport_or_setup");
  }
}
export async function accountPublic(
  req: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (
    ![
      "/api/auth/signup",
      "/api/auth/login",
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/auth/verify-email",
    ].includes(path)
  )
    return null;
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const data = await req.json();
  if (path.endsWith("signup")) {
    const input = z
      .object({
        email: mail,
        password: z.string().max(128),
        confirm_password: z.string(),
        first_name: z.string().trim().min(1).max(80),
        last_name: z.string().trim().min(1).max(80),
        display_name: z.string().trim().max(160).optional(),
        accept_terms: z.literal(true),
      })
      .parse(data);
    if (input.password !== input.confirm_password)
      throw new HttpError(400, "Passwords do not match.");
    validPassword(input.password, input.email);
    await consume(env, "signup:global", 50);
    await consume(
      env,
      "signup:" + (await hash(req.headers.get("CF-Connecting-IP") || "local")),
      10,
    );
    const digest = await passwordHash(input.password),
      user = await env.DB.prepare("SELECT id,email FROM users WHERE email=?")
        .bind(input.email)
        .first<any>();
    if (!user) {
      const id = crypto.randomUUID(),
        name = input.display_name || `${input.first_name} ${input.last_name}`;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO users(id,email,password,first_name,last_name,display_name,legacy_access,terms_accepted_at) VALUES(?,?,?,?,?,?,0,?)",
        ).bind(
          id,
          input.email,
          digest,
          input.first_name,
          input.last_name,
          name,
          Date.now(),
        ),
        env.DB.prepare(
          "INSERT OR IGNORE INTO profiles(user_id,name) SELECT id,? FROM users WHERE id=?",
        ).bind(name, id),
      ]);
      const created = await env.DB.prepare(
        "SELECT id,email FROM users WHERE id=?",
      )
        .bind(id)
        .first();
      if (created) await sendAccountLink(env, created, "verify");
    }
    return ok();
  }
  if (path.endsWith("login")) {
    const input = z
      .object({ email: mail, password: z.string().min(1).max(128) })
      .parse(data);
    const key = await hash(
        (req.headers.get("CF-Connecting-IP") || "local") + ":" + input.email,
      ),
      now = Date.now();
    await env.DB.prepare(
      "INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END",
    )
      .bind(key, now + 900000, now, now)
      .run();
    const count = await env.DB.prepare(
      "SELECT count FROM login_attempts WHERE key=?",
    )
      .bind(key)
      .first<any>();
    if (count.count > 15)
      throw new HttpError(
        429,
        "Too many attempts. Try again in 15 minutes.",
        900,
      );
    const user = await env.DB.prepare(
      "SELECT id,password FROM users WHERE email=?",
    )
      .bind(input.email)
      .first<any>();
    const computed = await passwordHash(
      input.password,
      user?.password.split(":")[0] || "missing-account-timing-salt",
    );
    if (!user || !equalHash(computed, user.password))
      throw new HttpError(401, "Invalid email or password");
    const token = random();
    await env.DB.prepare(
      "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
    )
      .bind(await hash(token), user.id, now + 604800000)
      .run();
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`,
        },
      },
    );
  }
  if (path.endsWith("forgot-password")) {
    const input = z.object({ email: mail }).parse(data);
    await limits(req, env, "reset", input.email);
    const user = await env.DB.prepare(
      "SELECT id,email FROM users WHERE email=?",
    )
      .bind(input.email)
      .first();
    if (user) await sendAccountLink(env, user, "reset");
    return ok();
  }
  const input = z
    .object({
      token: z.string().min(40).max(128),
      password: z.string().max(128).optional(),
      confirm_password: z.string().optional(),
    })
    .parse(data);
  const purpose = path.endsWith("verify-email") ? "verify" : "reset";
  await consume(
    env,
    "account:redeem:ip:" +
      (await hash(req.headers.get("CF-Connecting-IP") || "local")),
    30,
    1,
    new Date().toISOString().slice(0, 13),
  );
  let password = "";
  if (purpose === "reset") {
    if (!input.password || input.password !== input.confirm_password)
      throw new HttpError(400, "Passwords do not match.");
    validPassword(input.password);
    password = await passwordHash(input.password);
  }
  const claimed = await env.DB.prepare(
    "DELETE FROM account_tokens WHERE token_hash=? AND purpose=? AND expires_at>? RETURNING user_id",
  )
    .bind(await hash(input.token), purpose, Date.now())
    .first<any>();
  if (!claimed)
    throw new HttpError(
      400,
      "This link is invalid, expired, or already used. Request a new link.",
    );
  if (purpose === "verify")
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET email_verified_at=? WHERE id=?").bind(
        Date.now(),
        claimed.user_id,
      ),
      env.DB.prepare(
        "DELETE FROM account_tokens WHERE user_id=? AND purpose='verify'",
      ).bind(claimed.user_id),
    ]);
  else
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(
        password,
        claimed.user_id,
      ),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(
        claimed.user_id,
      ),
      env.DB.prepare("DELETE FROM oauth_states WHERE user_id=?").bind(
        claimed.user_id,
      ),
      env.DB.prepare("DELETE FROM account_tokens WHERE user_id=?").bind(
        claimed.user_id,
      ),
    ]);
  return Response.json(
    { ok: true },
    { headers: purpose === "reset" ? { "Set-Cookie": clear(req) } : {} },
  );
}
export async function accountPrivate(
  req: Request,
  env: Env,
  user: string,
): Promise<Response | null> {
  const path = new URL(req.url).pathname,
    method = req.method;
  if (path === "/api/auth/me" && method === "GET") {
    const account = await env.DB.prepare(
      "SELECT email,first_name,last_name,display_name,email_verified_at,legacy_access FROM users WHERE id=?",
    )
      .bind(user)
      .first();
    return Response.json({ account, mail_delivery_ready: mailReady(env) });
  }
  if (path === "/api/auth/resend-verification" && method === "POST") {
    const row = await env.DB.prepare(
      "SELECT id,email,email_verified_at FROM users WHERE id=?",
    )
      .bind(user)
      .first<any>();
    await limits(req, env, "verify", row.email);
    if (!row.email_verified_at) await sendAccountLink(env, row, "verify");
    return ok();
  }
  if (path === "/api/account/profile" && method === "PUT") {
    const input = z
      .object({
        first_name: z.string().trim().min(1).max(80),
        last_name: z.string().trim().min(1).max(80),
        display_name: z.string().trim().min(1).max(160),
      })
      .parse(await req.json());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET first_name=?,last_name=?,display_name=? WHERE id=?",
      ).bind(input.first_name, input.last_name, input.display_name, user),
      env.DB.prepare("UPDATE profiles SET name=? WHERE user_id=?").bind(
        input.display_name,
        user,
      ),
    ]);
    return Response.json({ ok: true });
  }
  if (path === "/api/auth/logout-all" && method === "POST") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user),
      env.DB.prepare("DELETE FROM oauth_states WHERE user_id=?").bind(user),
    ]);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": clear(req) } },
    );
  }
  if (
    (path === "/api/auth/change-password" || path === "/api/account/delete") &&
    method === "POST"
  ) {
    await consume(
      env,
      "account:reauth:" + user,
      10,
      1,
      new Date().toISOString().slice(0, 13),
    );
    const input = z
      .object({
        current_password: z.string().max(128),
        password: z.string().max(128).optional(),
        confirm_password: z.string().optional(),
        confirmation: z.string().optional(),
      })
      .parse(await req.json());
    const row = await env.DB.prepare("SELECT password FROM users WHERE id=?")
      .bind(user)
      .first<any>();
    if (
      !row ||
      !equalHash(
        await passwordHash(input.current_password, row.password.split(":")[0]),
        row.password,
      )
    )
      throw new HttpError(401, "Reauthentication failed.");
    if (path.endsWith("change-password")) {
      if (!input.password || input.password !== input.confirm_password)
        throw new HttpError(400, "Passwords do not match.");
      validPassword(input.password);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE users SET password=? WHERE id=? AND password=?",
        ).bind(await passwordHash(input.password), user, row.password),
        env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user),
        env.DB.prepare("DELETE FROM oauth_states WHERE user_id=?").bind(user),
        env.DB.prepare("DELETE FROM account_tokens WHERE user_id=?").bind(user),
      ]);
    } else {
      if (input.confirmation !== "DELETE MY ACCOUNT")
        throw new HttpError(
          400,
          "Type DELETE MY ACCOUNT to confirm permanent deletion.",
        );
      const mailboxes = await env.DB.prepare(
        "SELECT provider,tokens FROM connections WHERE user_id=?",
      )
        .bind(user)
        .all<{ provider: string; tokens: string | null }>();
      // One atomic transaction removes all private data and enqueues opaque storage cleanup.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO account_deletion_objects(object_key,backend,size,expires_at,next_at) SELECT object_key,storage_backend,size,COALESCE(expires_at,?),? FROM documents WHERE user_id=?",
        ).bind(Date.now() + 30 * 86400000, Date.now() + 120000, user),
        env.DB.prepare("UPDATE profiles SET stopped=1 WHERE user_id=?").bind(
          user,
        ),
        ...[
          "sessions",
          "oauth_states",
          "account_tokens",
          "mailbox_events",
          "message_attachments",
          "transports",
          "automation",
          "deliveries",
          "messages",
          "connections",
          "professors",
          "documents",
          "notifications",
          "suppressions",
          "ai_usage",
          "audit",
          "profiles",
        ].map((table) => {
          const sql =
            table === "mailbox_events"
              ? `DELETE FROM mailbox_events WHERE connection_id IN (SELECT id FROM connections WHERE user_id=?)`
              : ["automation", "deliveries"].includes(table)
                ? `DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE user_id=?)`
                : `DELETE FROM ${table} WHERE user_id=?`;
          return env.DB.prepare(sql).bind(user);
        }),
        env.DB.prepare("DELETE FROM users WHERE id=?").bind(user),
      ]);
      // Local access is already revoked; provider consent removal is best effort, never a send.
      for (const mailbox of mailboxes.results)
        await revokeMailboxTokens(env, user, mailbox);
    }
    return Response.json(
      { ok: true, cleanup_pending: path.endsWith("/delete") },
      { headers: { "Set-Cookie": clear(req) } },
    );
  }
  return null;
}
export async function requireVerified(env: Env, user: string) {
  const account = await env.DB.prepare(
    "SELECT email_verified_at,legacy_access FROM users WHERE id=?",
  )
    .bind(user)
    .first<any>();
  if (!account) throw new HttpError(401, "Unauthorized");
  if (!account.email_verified_at && !account.legacy_access)
    throw new HttpError(
      403,
      "Verify your email before opening your workspace.",
    );
}
export async function cleanDeletedAccounts(env: Env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT object_key,backend,expires_at,purged FROM account_deletion_objects WHERE next_at<=? LIMIT 2",
  )
    .bind(now)
    .all<any>();
  for (const row of rows.results) {
    try {
      if (!row.purged) {
        await consume(env, "kv-delete:global", 100);
        await documentStore(env, row.backend).delete(row.object_key);
      }
      if (row.expires_at <= now)
        await env.DB.prepare(
          "DELETE FROM account_deletion_objects WHERE object_key=?",
        )
          .bind(row.object_key)
          .run();
      else
        await env.DB.prepare(
          "UPDATE account_deletion_objects SET purged=1,next_at=? WHERE object_key=?",
        )
          .bind(row.expires_at, row.object_key)
          .run();
    } catch {
      await env.DB.prepare(
        "UPDATE account_deletion_objects SET attempts=attempts+1,next_at=? WHERE object_key=?",
      )
        .bind(now + 3600000, row.object_key)
        .run();
    }
  }
  await env.DB.prepare(
    "DELETE FROM account_tokens WHERE token_hash IN (SELECT token_hash FROM account_tokens WHERE expires_at<=? LIMIT 20)",
  )
    .bind(now)
    .run();
}
