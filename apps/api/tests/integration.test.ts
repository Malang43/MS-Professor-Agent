import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { runJobs, type Env, validTimezone } from "../src/index";

// Execute the actual migration and SQL against SQLite; only Cloudflare's transport
// adapter and object storage are replaced. No application routes are stubbed.
let db: DatabaseSync, env: Env;
function statement(sql: string, params: unknown[] = []): any {
  return {
    bind: (...p: unknown[]) => statement(sql, p),
    first: async () => db.prepare(sql).get(...(params as any[])) || null,
    all: async () => ({ results: db.prepare(sql).all(...(params as any[])) }),
    run: async () => {
      const r = db.prepare(sql).run(...(params as any[]));
      return { meta: { changes: Number(r.changes) } };
    },
    _sql: sql,
    _params: params,
  };
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const objects = new Map<string, { body: ArrayBuffer }>();
  env = {
    APP_ORIGIN: "http://localhost:3000",
    DB: {
      prepare: statement,
      batch: async (stmts: any[]) => {
        db.exec("BEGIN");
        try {
          const results = stmts.map((s) => {
            const r = db.prepare(s._sql).run(...s._params);
            return { meta: { changes: Number(r.changes) } };
          });
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as any,
    DOCUMENTS: {
      put: async (key: string, stream: ReadableStream) => {
        objects.set(key, { body: await new Response(stream).arrayBuffer() });
      },
      get: async (key: string) => objects.get(key) || null,
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as any,
  };
});
async function call(
  path: string,
  method = "GET",
  data?: unknown,
  cookie = "",
  origin = "http://localhost:3000",
) {
  return worker.fetch(
    new Request("http://localhost:8787/api" + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data && !(data instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        data instanceof FormData
          ? data
          : data
            ? JSON.stringify(data)
            : undefined,
    }),
    env,
  );
}
async function signup(email = "student@example.com") {
  const r = await call("/auth/signup", "POST", {
    email,
    password: "a-strong-password-123",
  });
  expect(r.status).toBe(200);
  return r.headers.get("Set-Cookie")!.split(";")[0];
}
async function professor(cookie: string) {
  await call(
    "/professors",
    "POST",
    [
      {
        name: "Alex Morgan",
        email: "prof@example.edu",
        university: "Example U",
        interests: "Robotics",
      },
    ],
    cookie,
  );
  return (
    (await (await call("/state", "GET", undefined, cookie)).json()) as any
  ).professors[0].id;
}
async function message(cookie: string, p: string, extra: any = {}) {
  const r = await call(
    "/messages",
    "POST",
    {
      professor_id: p,
      subject: "Research inquiry",
      body: "A thoughtful email",
      mode: "manual",
      scheduled_at: "2020-01-01T12:00:00.000Z",
      timezone: "Asia/Karachi",
      ...extra,
    },
    cookie,
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as any).id;
}
async function state(cookie: string) {
  return (await (await call("/state", "GET", undefined, cookie)).json()) as any;
}
describe("student identity and tenant isolation", () => {
  it("rejects unauthenticated access, bad origins, and weak passwords", async () => {
    expect((await call("/state")).status).toBe(401);
    expect(
      (
        await call("/auth/signup", "POST", {
          email: "x@example.com",
          password: "short",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("/auth/login", "POST", {}, "", "https://evil.example"))
        .status,
    ).toBe(403);
  });
  it("persists profiles, verifies passwords, and revokes sessions", async () => {
    const cookie = await signup();
    expect(
      (
        await call("/auth/login", "POST", {
          email: "student@example.com",
          password: "wrong-password-long",
        })
      ).status,
    ).toBe(401);
    await call(
      "/profile",
      "PUT",
      {
        name: "Student",
        university: "University",
        degree: "CS",
        gpa: "3.9",
        interests: "Robotics",
        timezone: "Europe/London",
      },
      cookie,
    );
    expect((await state(cookie)).profile.name).toBe("Student");
    await call("/auth/logout", "POST", undefined, cookie);
    expect((await call("/state", "GET", undefined, cookie)).status).toBe(401);
  });
  it("cannot create drafts or download documents owned by another student", async () => {
    const a = await signup(),
      b = await signup("b@example.com"),
      p = await professor(a);
    expect((await state(b)).professors).toEqual([]);
    expect(
      (
        await call(
          "/messages",
          "POST",
          {
            professor_id: p,
            subject: "x",
            body: "x",
            mode: "manual",
            scheduled_at: "2020-01-01T12:00:00.000Z",
            timezone: "UTC",
          },
          b,
        )
      ).status,
    ).toBe(404);
    const form = new FormData();
    form.set(
      "file",
      new File(["private CV"], "cv.txt", { type: "text/plain" }),
    );
    const doc = (await (
      await call("/documents", "POST", form, a)
    ).json()) as any;
    expect(
      (await call("/documents/" + doc.id, "GET", undefined, b)).status,
    ).toBe(404);
    expect(
      await (await call("/documents/" + doc.id, "GET", undefined, a)).text(),
    ).toBe("private CV");
    expect((await state(b)).documents).toEqual([]);
  });
  it("deduplicates imports and refuses cross-user attachments", async () => {
    const a = await signup(),
      b = await signup("b@example.com"),
      p = await professor(a);
    await professor(a);
    expect((await state(a)).professors.length).toBe(1);
    const bp = await professor(b),
      form = new FormData();
    form.set("file", new File(["CV"], "cv.txt", { type: "text/plain" }));
    const doc = (await (
      await call("/documents", "POST", form, a)
    ).json()) as any;
    expect(
      (
        await call(
          "/messages",
          "POST",
          {
            professor_id: bp,
            subject: "x",
            body: "x",
            mode: "manual",
            scheduled_at: "2020-01-01T12:00:00.000Z",
            timezone: "UTC",
            attachments: [doc.id],
          },
          b,
        )
      ).status,
    ).toBe(404);
  });
});
describe("approval, scheduling, and controls", () => {
  it("tracks a simulated provider failure without a delivery record", async () => {
    const c = await signup(),
      p = await professor(c),
      m = await message(c, p, { mode: "auto", authorized: true });
    await call(`/messages/${m}/simulate-failure`, "POST", undefined, c);
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("failed");
    expect((await state(c)).messages[0].error).toContain("Simulated");
    expect(db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(0);
  });
  it("requires manual approval and prevents duplicate mock sends across retries", async () => {
    const c = await signup(),
      p = await professor(c),
      m = await message(c, p);
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("draft");
    await call("/messages/approve", "POST", { ids: [m] }, c);
    await Promise.all([runJobs(env), runJobs(env)]);
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("sent");
    expect(db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(1);
    expect(
      db.prepare("SELECT count(*) n FROM audit WHERE action='mock.sent'").get()!
        .n,
    ).toBe(1);
  });
  it("allows manual batch approvals but rejects AI batch approval", async () => {
    const c = await signup(),
      p = await professor(c),
      a = await message(c, p),
      b = await message(c, p);
    expect(
      (await call("/messages/approve", "POST", { ids: [a, b] }, c)).status,
    ).toBe(200);
    const x = await message(c, p, { mode: "review" }),
      y = await message(c, p, { mode: "review" });
    expect(
      (await call("/messages/approve", "POST", { ids: [x, y] }, c)).status,
    ).toBe(400);
    expect(
      (await call("/messages/approve", "POST", { ids: [x] }, c)).status,
    ).toBe(200);
  });
  it("auto mode requires explicit authorization; future jobs wait", async () => {
    const c = await signup(),
      p = await professor(c);
    await message(c, p, { mode: "auto", authorized: false });
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("draft");
    await message(c, p, { mode: "auto", authorized: true });
    await message(c, p, {
      mode: "auto",
      authorized: true,
      scheduled_at: "2099-01-01T12:00:00.000Z",
    });
    await runJobs(env);
    expect((await state(c)).messages.map((m: any) => m.status).sort()).toEqual([
      "draft",
      "pending",
      "sent",
    ]);
  });
  it("pause blocks jobs; resume allows; cancel and stop are final", async () => {
    const c = await signup(),
      p = await professor(c);
    await message(c, p, { mode: "auto", authorized: true });
    await call("/control", "POST", { action: "pause" }, c);
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("pending");
    await call("/control", "POST", { action: "resume" }, c);
    await runJobs(env);
    expect((await state(c)).messages[0].status).toBe("sent");
    const x = await message(c, p, { mode: "auto", authorized: true });
    await call(`/messages/${x}/cancel`, "POST", undefined, c);
    await message(c, p, { mode: "auto", authorized: true });
    await call("/control", "POST", { action: "stop" }, c);
    await call("/control", "POST", { action: "resume" }, c);
    await runJobs(env);
    expect(
      (await state(c)).messages.filter((m: any) => m.status === "cancelled"),
    ).toHaveLength(2);
  });
  it("keeps a student manual tick scoped to that student", async () => {
    const a = await signup(),
      b = await signup("b@example.com");
    await message(a, await professor(a), { mode: "auto", authorized: true });
    await message(b, await professor(b), { mode: "auto", authorized: true });
    await call("/jobs/run", "POST", undefined, a);
    expect((await state(a)).messages[0].status).toBe("sent");
    expect((await state(b)).messages[0].status).toBe("pending");
  });
  it("records follow-up reminders and manual replies without sending follow-ups", async () => {
    const c = await signup(),
      p = await professor(c),
      m = await message(c, p, { mode: "auto", authorized: true });
    await runJobs(env);
    await call(
      `/messages/${m}/followup`,
      "POST",
      { date: "2020-02-01T12:00:00.000Z" },
      c,
    );
    expect((await state(c)).messages[0].followup_at).toBeTruthy();
    await runJobs(env);
    expect(db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(1);
    await call(`/messages/${m}/reply`, "POST", undefined, c);
    expect((await state(c)).messages[0].status).toBe("replied");
    expect((await state(c)).messages[0].followup_at).toBeNull();
  });
  it("generates mock drafts and validates IANA timezones", async () => {
    const c = await signup(),
      p = await professor(c);
    const draft = (await (
      await call("/draft", "POST", { professor_id: p }, c)
    ).json()) as any;
    expect(draft.provider).toBe("mock");
    expect(draft.body).toContain("Alex Morgan");
    expect(validTimezone("Asia/Karachi")).toBe(true);
    expect(validTimezone("invalid/zone")).toBe(false);
  });
});
