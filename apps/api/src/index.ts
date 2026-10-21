import { z } from "zod";
export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  APP_ORIGIN: string;
}
const id = () => crypto.randomUUID();
const json = (data: unknown, status = 200) => Response.json(data, { status });
const email = z
  .string()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const professorSchema = z.object({
  name: z.string().min(1).max(200),
  email,
  university: z.string().max(300).default(""),
  interests: z.string().max(2000).default(""),
});
const profileSchema = z.object({
  name: z.string().max(200),
  university: z.string().max(300),
  degree: z.string().max(200),
  gpa: z.string().max(30),
  interests: z.string().max(2000),
  timezone: z.string().refine(validTimezone),
});
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const messageSchema = z.object({
  professor_id: z.string().uuid(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  mode: z.enum(["manual", "review", "auto"]),
  authorized: z.boolean().default(false),
  scheduled_at: z.string().datetime(),
  timezone: z.string().refine(validTimezone),
  attachments: z.array(z.string().uuid()).max(10).default([]),
});
export function canQueue(m: { mode: string; authorized: boolean }) {
  return m.mode === "auto" && m.authorized;
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function passwordHash(password: string, salt = id()) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return (
    salt +
    ":" +
    Array.from(new Uint8Array(bits), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
const audit = (env: Env, user: string, action: string, entity = "") =>
  env.DB.prepare(
    "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,?)",
  ).bind(id(), user, action, entity);
async function authenticated(req: Request, env: Env) {
  const raw = req.headers
    .get("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("session="))
    ?.slice(8);
  if (!raw) throw new Error("Unauthorized");
  const session = await env.DB.prepare(
    "SELECT user_id FROM sessions WHERE token=? AND expires_at>?",
  )
    .bind(await digest(raw), Date.now())
    .first<{ user_id: string }>();
  if (!session) throw new Error("Unauthorized");
  return session.user_id;
}
async function owned(
  env: Env,
  table: "professors" | "documents" | "messages",
  entity: string,
  user: string,
) {
  const row = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE id=? AND user_id=?`,
  )
    .bind(entity, user)
    .first();
  if (!row) throw new Error("Not found");
  return row;
}
export async function runJobs(env: Env) {
  // The mock delivery and status transition share one atomic SQL transaction.
  // A UNIQUE message_id is the idempotency boundary, even across overlapping ticks.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO deliveries(message_id,provider_id)
      SELECT m.id,'mock-' || m.id FROM messages m JOIN profiles p ON p.user_id=m.user_id
      WHERE m.status='pending' AND m.approved=1 AND (m.mode!='auto' OR m.authorized=1)
      AND m.scheduled_at<=? AND p.paused=0 AND p.stopped=0`,
    ).bind(new Date().toISOString()),
    env.DB.prepare(
      `INSERT INTO audit(id,user_id,action,entity_id) SELECT lower(hex(randomblob(16))),user_id,'mock.sent',id FROM messages WHERE status='pending' AND id IN (SELECT message_id FROM deliveries)`,
    ),
    env.DB.prepare(
      `UPDATE messages SET status='sent',sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND id IN (SELECT message_id FROM deliveries)`,
    ),
  ]);
}
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  if (path === "/api/health") return json({ ok: true, provider: "mock" });
  if (path === "/api/auth/signup" || path === "/api/auth/login") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const input = z
      .object({ email, password: z.string().min(12).max(128) })
      .parse(await req.json());
    const key = await digest(
      (req.headers.get("CF-Connecting-IP") || "local") + ":" + input.email,
    );
    await env.DB.prepare(
      "INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END",
    )
      .bind(key, Date.now() + 900000, Date.now(), Date.now())
      .run();
    const attempt = await env.DB.prepare(
      "SELECT count FROM login_attempts WHERE key=?",
    )
      .bind(key)
      .first<{ count: number }>();
    if ((attempt?.count || 0) > 15)
      return json(
        { error: "Too many attempts. Try again in 15 minutes." },
        429,
      );
    let user = await env.DB.prepare("SELECT * FROM users WHERE email=?")
      .bind(input.email)
      .first<{ id: string; password: string }>();
    if (path.endsWith("signup")) {
      if (user)
        return json(
          { error: "Unable to create account with those details." },
          409,
        );
      const userId = id();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users(id,email,password) VALUES(?,?,?)",
        ).bind(userId, input.email, await passwordHash(input.password)),
        env.DB.prepare("INSERT INTO profiles(user_id) VALUES(?)").bind(userId),
        audit(env, userId, "account.created"),
      ]);
      user = { id: userId, password: "" };
    } else if (
      !user ||
      (await passwordHash(input.password, user.password.split(":")[0])) !==
        user.password
    )
      return json({ error: "Invalid email or password" }, 401);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    await env.DB.prepare(
      "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
    )
      .bind(await digest(token), user.id, Date.now() + 7 * 86400000)
      .run();
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
      },
    });
  }
  const user = await authenticated(req, env);
  if (path === "/api/auth/logout") {
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    const raw = req.headers
      .get("Cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("session="))
      ?.slice(8);
    await env.DB.prepare("DELETE FROM sessions WHERE token=?")
      .bind(await digest(raw!))
      .run();
    return new Response("{}", {
      headers: {
        "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      },
    });
  }
  if (path === "/api/state" && method === "GET") {
    const [profile, professors, documents, messages, history, account] =
      await Promise.all([
        env.DB.prepare("SELECT * FROM profiles WHERE user_id=?")
          .bind(user)
          .first(),
        env.DB.prepare("SELECT * FROM professors WHERE user_id=? ORDER BY name")
          .bind(user)
          .all(),
        env.DB.prepare(
          "SELECT id,name,size,content_type FROM documents WHERE user_id=?",
        )
          .bind(user)
          .all(),
        env.DB.prepare(
          "SELECT m.*,p.name professor_name,p.email professor_email FROM messages m JOIN professors p ON p.id=m.professor_id WHERE m.user_id=? ORDER BY m.created_at DESC",
        )
          .bind(user)
          .all(),
        env.DB.prepare(
          "SELECT * FROM audit WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
        )
          .bind(user)
          .all(),
        env.DB.prepare("SELECT email FROM users WHERE id=?").bind(user).first(),
      ]);
    const attachments = await env.DB.prepare(
      "SELECT * FROM message_attachments WHERE user_id=?",
    )
      .bind(user)
      .all();
    return json({
      profile,
      professors: professors.results,
      documents: documents.results,
      messages: messages.results.map((m) => ({
        ...m,
        attachments: attachments.results
          .filter((a) => a.message_id === m.id)
          .map((a) => a.document_id),
      })),
      audit: history.results,
      account,
    });
  }
  if (path === "/api/profile" && method === "PUT") {
    const p = profileSchema.parse(await req.json());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE profiles SET name=?,university=?,degree=?,gpa=?,interests=?,timezone=? WHERE user_id=?",
      ).bind(
        p.name,
        p.university,
        p.degree,
        p.gpa,
        p.interests,
        p.timezone,
        user,
      ),
      audit(env, user, "profile.updated"),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/professors" && method === "POST") {
    const rows = z
      .array(professorSchema)
      .min(1)
      .max(500)
      .parse(await req.json());
    const results = await env.DB.batch([
      ...rows.map((p) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO professors(id,user_id,name,email,university,interests) VALUES(?,?,?,?,?,?)",
        ).bind(id(), user, p.name, p.email, p.university, p.interests),
      ),
      audit(env, user, "professors.imported"),
    ]);
    return json({
      imported: results.slice(0, -1).reduce((n, r) => n + r.meta.changes, 0),
    });
  }
  if (path === "/api/draft" && method === "POST") {
    const { professor_id } = z
      .object({ professor_id: z.string().uuid() })
      .parse(await req.json());
    const p = await owned(env, "professors", professor_id, user);
    const profile = await env.DB.prepare(
      "SELECT * FROM profiles WHERE user_id=?",
    )
      .bind(user)
      .first();
    return json({
      subject: `MS research inquiry — ${p.interests || "research opportunities"}`,
      body: `Dear Professor ${p.name},\n\nMy name is ${profile?.name || "[your name]"}, and I am studying ${profile?.degree || "[degree]"} at ${profile?.university || "[university]"}. I am interested in ${p.interests || profile?.interests || "[research area]"} and would appreciate learning about potential MS research opportunities in your group.\n\nI would be grateful to discuss how my background could contribute to your research and whether funded positions or scholarships may be available.\n\nThank you for your time.\nBest regards,\n${profile?.name || "[your name]"}`,
      provider: "mock",
    });
  }
  if (path === "/api/messages" && method === "POST") {
    const m = messageSchema.parse(await req.json());
    await owned(env, "professors", m.professor_id, user);
    for (const attachment of m.attachments)
      await owned(env, "documents", attachment, user);
    const messageId = id(),
      queued = canQueue(m);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO messages(id,user_id,professor_id,subject,body,mode,authorized,approved,status,scheduled_at,timezone) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        messageId,
        user,
        m.professor_id,
        m.subject,
        m.body,
        m.mode,
        +m.authorized,
        +queued,
        queued ? "pending" : "draft",
        m.scheduled_at,
        m.timezone,
      ),
      ...Array.from(new Set(m.attachments)).map((doc) =>
        env.DB.prepare(
          "INSERT INTO message_attachments(message_id,document_id,user_id) VALUES(?,?,?)",
        ).bind(messageId, doc, user),
      ),
      audit(
        env,
        user,
        queued ? "auto.explicitly_authorized" : "draft.created",
        messageId,
      ),
    ]);
    return json({ id: messageId });
  }
  if (path === "/api/messages/approve" && method === "POST") {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(500) })
      .parse(await req.json());
    const rows = await Promise.all(
      ids.map((x) => owned(env, "messages", x, user)),
    );
    if (
      rows.some((m) => m.status !== "draft" || m.mode === "auto") ||
      (rows.length > 1 && rows.some((m) => m.mode !== "manual"))
    )
      return json(
        {
          error:
            "AI drafts require individual review. Auto mode requires authorization at creation.",
        },
        400,
      );
    await env.DB.batch(
      ids.flatMap((x) => [
        env.DB.prepare(
          "UPDATE messages SET approved=1,status='pending' WHERE id=? AND user_id=? AND status='draft'",
        ).bind(x, user),
        audit(env, user, "draft.approved", x),
      ]),
    );
    return json({ ok: true });
  }
  if (path === "/api/control" && method === "POST") {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop"]) })
      .parse(await req.json());
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE profiles SET paused=?,stopped=? WHERE user_id=?",
      ).bind(action === "pause" ? 1 : 0, action === "stop" ? 1 : 0, user),
      ...(action === "stop"
        ? [
            env.DB.prepare(
              "UPDATE messages SET status='cancelled' WHERE user_id=? AND status IN ('draft','pending')",
            ).bind(user),
          ]
        : []),
      audit(env, user, `outreach.${action}`),
    ]);
    return json({ ok: true });
  }
  const failureMatch = path.match(
    /^\/api\/messages\/([^/]+)\/simulate-failure$/,
  );
  if (failureMatch && method === "POST") {
    await owned(env, "messages", failureMatch[1], user);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET status='failed',error='Simulated provider failure — no email sent' WHERE id=? AND user_id=? AND status='pending' AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=messages.id)",
      ).bind(failureMatch[1], user),
      audit(env, user, "mock.failure_simulated", failureMatch[1]),
    ]);
    return json({ ok: true });
  }
  const messageMatch = path.match(
    /^\/api\/messages\/([^/]+)\/(cancel|reply|followup)$/,
  );
  if (messageMatch && method === "POST") {
    const [, messageId, action] = messageMatch;
    const m = await owned(env, "messages", messageId, user);
    if (action === "cancel") {
      if (!["draft", "pending"].includes(String(m.status)))
        throw new Error("Invalid state");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE messages SET status='cancelled' WHERE id=? AND user_id=? AND status IN ('draft','pending')",
        ).bind(messageId, user),
        audit(env, user, "message.cancelled", messageId),
      ]);
    } else if (action === "reply") {
      if (m.status !== "sent") throw new Error("Invalid state");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE messages SET status='replied',followup_at=NULL WHERE id=? AND user_id=? AND status='sent'",
        ).bind(messageId, user),
        audit(env, user, "reply.manually_recorded", messageId),
      ]);
    } else {
      const { date } = z
        .object({ date: z.string().datetime() })
        .parse(await req.json());
      if (m.status !== "sent") throw new Error("Invalid state");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE messages SET followup_at=? WHERE id=? AND user_id=? AND status='sent'",
        ).bind(date, messageId, user),
        audit(env, user, "followup.reminder_set", messageId),
      ]);
    }
    return json({ ok: true });
  }
  if (path === "/api/jobs/run" && method === "POST") {
    // User-scoped manual tick; global cron remains isolated by each row's approval/control state.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO deliveries(message_id,provider_id) SELECT m.id,'mock-' || m.id FROM messages m JOIN profiles p ON p.user_id=m.user_id WHERE m.user_id=? AND m.status='pending' AND m.approved=1 AND (m.mode!='auto' OR m.authorized=1) AND m.scheduled_at<=? AND p.paused=0 AND p.stopped=0`,
      ).bind(user, new Date().toISOString()),
      env.DB.prepare(
        "INSERT INTO audit(id,user_id,action,entity_id) SELECT lower(hex(randomblob(16))),user_id,'mock.sent',id FROM messages WHERE user_id=? AND status='pending' AND id IN (SELECT message_id FROM deliveries)",
      ).bind(user),
      env.DB.prepare(
        "UPDATE messages SET status='sent',sent_at=? WHERE user_id=? AND status='pending' AND id IN (SELECT message_id FROM deliveries)",
      ).bind(new Date().toISOString(), user),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/documents" && method === "POST") {
    const form = await req.formData(),
      file = form.get("file") as unknown as File | string | null;
    if (!file || typeof file === "string")
      return json({ error: "Choose a document" }, 400);
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ];
    if (
      !allowed.includes(file.type) ||
      file.size > 10 * 1024 * 1024 ||
      !file.size
    )
      return json({ error: "Use PDF, DOCX or TXT, up to 10 MB" }, 400);
    const docId = id(),
      key = `${user}/${docId}`;
    await env.DOCUMENTS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO documents(id,user_id,name,object_key,content_type,size) VALUES(?,?,?,?,?,?)",
        ).bind(docId, user, file.name.slice(0, 200), key, file.type, file.size),
        audit(env, user, "document.uploaded", docId),
      ]);
    } catch (e) {
      await env.DOCUMENTS.delete(key);
      throw e;
    }
    return json({ id: docId });
  }
  const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch && method === "GET") {
    const d = await owned(env, "documents", docMatch[1], user);
    const obj = await env.DOCUMENTS.get(String(d.object_key));
    if (!obj) throw new Error("Not found");
    return new Response(obj.body, {
      headers: {
        "Content-Type": String(d.content_type),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(String(d.name))}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return json({ error: "Not found" }, 404);
}
export default {
  async fetch(req: Request, env: Env) {
    const origin = req.headers.get("Origin");
    if (origin && origin !== env.APP_ORIGIN)
      return json({ error: "Origin denied" }, 403);
    let res: Response;
    try {
      if (req.method === "OPTIONS") res = new Response(null, { status: 204 });
      else if (
        !["GET", "HEAD"].includes(req.method) &&
        origin !== env.APP_ORIGIN
      )
        res = json({ error: "Origin required" }, 403);
      else if (
        Number(req.headers.get("Content-Length") || 0) >
        11 * 1024 * 1024
      )
        res = json({ error: "Request too large" }, 413);
      else res = await route(req, env);
    } catch (e) {
      if (e instanceof z.ZodError)
        res = json(
          {
            error: e.issues
              .map((x) => `${x.path.join(".")}: ${x.message}`)
              .join("; "),
          },
          400,
        );
      else {
        const message = e instanceof Error ? e.message : "";
        const status =
          message === "Unauthorized"
            ? 401
            : message === "Not found"
              ? 404
              : message === "Invalid state"
                ? 409
                : 500;
        res = json(
          { error: status === 500 ? "Unable to complete request" : message },
          status,
        );
      }
    }
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", env.APP_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    headers.set("Vary", "Origin");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(res.body, { status: res.status, headers });
  },
  async scheduled(_event: ScheduledEvent, env: Env) {
    await runJobs(env);
  },
};
