import { assertBindings } from "./sql";
import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { FILE_LIMIT } from "../src/storage";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import worker, { runJobs, type Env, validTimezone } from "../src/index";

// Execute the actual migration and SQL against SQLite; only Cloudflare's transport
// adapter and object storage are replaced. No application routes are stubbed.
let db: DatabaseSync, env: Env;
function statement(sql: string, params: unknown[] = []): any {
  return {
    bind: (...p: unknown[]) => statement(sql, p),
    first: async () => {
      assertBindings(sql, params);
      return db.prepare(sql).get(...(params as any[])) || null;
    },
    all: async () => {
      assertBindings(sql, params);
      return { results: db.prepare(sql).all(...(params as any[])) };
    },
    run: async () => {
      assertBindings(sql, params);
      const r = db.prepare(sql).run(...(params as any[]));
      return { meta: { changes: Number(r.changes) } };
    },
    _sql: sql,
    _params: params,
  };
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
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
            assertBindings(s._sql, s._params);
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
    DOCUMENTS_KV: {
      put: async (key: string, bytes: ArrayBuffer) => {
        objects.set(key, { body: bytes });
      },
      get: async (key: string) => objects.get(key)?.body || null,
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
  // Historical workspace tests use explicitly verified signup fixtures; account tests exercise pending users.
  if (
    path === "/auth/signup" &&
    data &&
    typeof data === "object" &&
    "password" in data &&
    String(data.password).length >= 15
  )
    data = {
      ...data,
      first_name: "Test",
      last_name: "Student",
      confirm_password: data.password,
      accept_terms: true,
    };
  const response = await worker.fetch(
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
  if (path === "/auth/signup" && response.status === 200) {
    db.prepare("UPDATE users SET email_verified_at=? WHERE email=?").run(
      Date.now(),
      (data as any).email,
    );
    return call(
      "/auth/login",
      "POST",
      { email: (data as any).email, password: (data as any).password },
      "",
      origin,
    );
  }
  return response;
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

// Real local HTTP hops exercise request bodies and Cookie/Set-Cookie transport.
// This models the checked-in rewrite; it does not emulate Vercel's CDN/browser.
const proxyConfig = JSON.parse(
  readFileSync(new URL("../../web/vercel.json", import.meta.url), "utf8"),
);
const frontendOrigin = "https://ms-professor-agent.vercel.app";
function expectPrivate(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe(
    "private, no-store, max-age=0",
  );
  expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
}
async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  return bytes.length ? bytes : undefined;
}
function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value && !["host", "connection", "transfer-encoding"].includes(key))
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}
async function sendResponse(response: Response, outgoing: ServerResponse) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") outgoing.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function withProxy(run: (base: string) => Promise<void>) {
  env.APP_ORIGIN = frontendOrigin;
  const upstream = createServer(async (incoming, outgoing) => {
    try {
      const response = await worker.fetch(
        new Request(
          new URL(incoming.url!, proxyConfig.rewrites[0].destination),
          {
            method: incoming.method,
            headers: requestHeaders(incoming),
            body: await requestBody(incoming),
          },
        ),
        env,
      );
      await sendResponse(response, outgoing);
    } catch {
      outgoing.statusCode = 500;
      outgoing.end("Test upstream failed");
    }
  });
  const upstreamBase = await listen(upstream);
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, "http://proxy.test");
      if (!url.pathname.startsWith("/api/")) {
        outgoing.statusCode = 404;
        outgoing.end();
        return;
      }
      const destination = new URL(
        proxyConfig.rewrites[0].destination.replace(
          ":path*",
          url.pathname.slice(5),
        ),
      );
      const response = await fetch(
        upstreamBase + destination.pathname + url.search,
        {
          method: incoming.method,
          headers: requestHeaders(incoming),
          body: await requestBody(incoming),
          redirect: "manual",
        },
      );
      const forwarded = new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
      for (const header of proxyConfig.headers[0].headers)
        forwarded.headers.set(header.key, header.value);
      await sendResponse(forwarded, outgoing);
    } catch {
      outgoing.statusCode = 502;
      outgoing.end("Test proxy failed");
    }
  });
  try {
    await run(await listen(proxy));
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

describe("same-origin API reverse proxy", () => {
  it("preserves HTTPS login/logout, private bounded uploads, downloads and account isolation over HTTP hops", async () => {
    await withProxy(async (base) => {
      const api = async (
        path: string,
        method = "GET",
        body?: unknown,
        cookie = "",
        origin: string | null = frontendOrigin,
      ): Promise<Response> => {
        const headers = new Headers(cookie ? { Cookie: cookie } : {});
        if (origin !== null) headers.set("Origin", origin);
        if (body && !(body instanceof FormData))
          headers.set("Content-Type", "application/json");
        if (
          path === "/auth/signup" &&
          body &&
          typeof body === "object" &&
          "password" in body
        )
          body = {
            ...body,
            first_name: "Proxy",
            last_name: "Student",
            confirm_password: body.password,
            accept_terms: true,
          };
        const response = await fetch(base + "/api" + path, {
          method,
          headers,
          body:
            body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
          redirect: "manual",
        });
        if (path === "/auth/signup" && response.status === 200) {
          db.prepare("UPDATE users SET email_verified_at=? WHERE email=?").run(
            Date.now(),
            (body as any).email,
          );
          return api(
            "/auth/login",
            "POST",
            { email: (body as any).email, password: (body as any).password },
            "",
            origin,
          );
        }
        return response;
      };
      const signupResponse = await api("/auth/signup", "POST", {
        email: "proxy-a@example.com",
        password: "proxy-test-password-123",
      });
      expect(signupResponse.status).toBe(200);
      expectPrivate(signupResponse);
      const cookieHeader = signupResponse.headers.get("Set-Cookie")!;
      expect(cookieHeader).toContain(
        "HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure",
      );
      expect(cookieHeader).not.toMatch(/Domain=/i);
      const cookieA = cookieHeader.split(";")[0];
      const signupB = await api("/auth/signup", "POST", {
        email: "proxy-b@example.com",
        password: "proxy-test-password-123",
      });
      expect(signupB.status).toBe(200);
      const cookieB = signupB.headers.get("Set-Cookie")!.split(";")[0];
      // Same URL, alternating sessions: user-specific state must never be reused.
      for (const [cookie, email] of [
        [cookieA, "proxy-a@example.com"],
        [cookieB, "proxy-b@example.com"],
        [cookieA, "proxy-a@example.com"],
      ]) {
        const response = await api("/state", "GET", undefined, cookie);
        expectPrivate(response);
        expect((await response.json()).account.email).toBe(email);
      }
      // A malicious or origin-less logout must not revoke a valid session.
      for (const origin of ["https://evil.example", null]) {
        const csrf = await api(
          "/auth/logout",
          "POST",
          undefined,
          cookieA,
          origin,
        );
        expect(csrf.status).toBe(403);
        expectPrivate(csrf);
      }
      expect(
        (await api("/auth/logout", "GET", undefined, cookieA, null)).status,
      ).toBe(405);
      expect((await api("/state", "GET", undefined, cookieA)).status).toBe(200);
      const rootHeaders = proxyConfig.headers.find(
        (rule: { source: string }) => rule.source === "/",
      )?.headers;
      expect(rootHeaders).toEqual(
        expect.arrayContaining([
          { key: "X-Frame-Options", value: "DENY" },
          expect.objectContaining({
            key: "Content-Security-Policy",
            value: expect.stringContaining("frame-ancestors 'none'"),
          }),
        ]),
      );
      const configuredHeaders = Object.fromEntries(
        proxyConfig.headers
          .find((rule: { source: string }) => rule.source === "/api/:path*")!
          .headers.map((header: { key: string; value: string }) => [
            header.key,
            header.value,
          ]),
      );
      expect(configuredHeaders["x-vercel-enable-rewrite-caching"]).toBe("0");
      const bytes = new Uint8Array(FILE_LIMIT).fill(65);
      const upload = new FormData();
      upload.set(
        "file",
        new File([bytes], "synthetic-private.txt", { type: "text/plain" }),
      );
      const uploaded = await api("/documents", "POST", upload, cookieA);
      expect(uploaded.status).toBe(200);
      expectPrivate(uploaded);
      const { id: documentId } = await uploaded.json();
      // An ordinary same-origin download link may omit Origin entirely.
      const downloaded = await api(
        `/documents/${documentId}?download=1`,
        "GET",
        undefined,
        cookieA,
        null,
      );
      expect(downloaded.status).toBe(200);
      expectPrivate(downloaded);
      expect(downloaded.headers.get("Content-Disposition")).toContain(
        "attachment;",
      );
      expect(downloaded.headers.get("Content-Type")).toBe("text/plain");
      expect(
        Buffer.compare(
          Buffer.from(await downloaded.arrayBuffer()),
          Buffer.from(bytes),
        ),
      ).toBe(0);
      for (const [cookie, status] of [
        [cookieB, 404],
        ["", 401],
      ] as const) {
        const denied = await api(
          `/documents/${documentId}`,
          "GET",
          undefined,
          cookie,
          null,
        );
        expect(denied.status).toBe(status);
        expectPrivate(denied);
      }
      const otherState = await api("/state", "GET", undefined, cookieB);
      expect((await otherState.json()).documents).toEqual([]);
      expect(
        (
          await api(
            `/documents/${documentId}/delete`,
            "POST",
            undefined,
            cookieA,
          )
        ).status,
      ).toBe(200);
      expect(
        (await api(`/documents/${documentId}`, "GET", undefined, cookieA, null))
          .status,
      ).toBe(404);
      const logout = await api("/auth/logout", "POST", undefined, cookieA);
      expect(logout.status).toBe(200);
      expectPrivate(logout);
      expect(logout.headers.get("Set-Cookie")).toBe(
        "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure",
      );
      expect((await api("/state", "GET", undefined, cookieA)).status).toBe(401);
      expect(
        (await api(`/documents/${documentId}`, "GET", undefined, cookieA))
          .status,
      ).toBe(401);
      const wrongPassword = await api("/auth/login", "POST", {
        email: "proxy-a@example.com",
        password: "wrong-password-123456",
      });
      expect(wrongPassword.status).toBe(401);
      expectPrivate(wrongPassword);
      const login = await api("/auth/login", "POST", {
        email: "proxy-a@example.com",
        password: "proxy-test-password-123",
      });
      expect(login.status).toBe(200);
      const freshCookie = login.headers.get("Set-Cookie")!.split(";")[0];
      expect(freshCookie).not.toBe(cookieA);
      expect((await api("/state", "GET", undefined, freshCookie)).status).toBe(
        200,
      );
    });
  }, 20000);

  it("rejects cross-site, absent and null origins and never trusts forwarded origins", async () => {
    await withProxy(async (base) => {
      for (const origin of [
        "https://evil.example",
        "https://preview.vercel.app",
        "null",
        null,
      ]) {
        const headers = new Headers({
          "Content-Type": "application/json",
          "X-Forwarded-Host": new URL(frontendOrigin).host,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Origin": frontendOrigin,
        });
        if (origin !== null) headers.set("Origin", origin);
        const response = await fetch(base + "/api/auth/signup", {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: "csrf@example.com",
            password: "csrf-test-password-123",
          }),
        });
        expect(response.status).toBe(403);
        expectPrivate(response);
      }
      expect(db.prepare("SELECT count(*) n FROM users").get()!.n).toBe(0);
      const preflight = await fetch(base + "/api/auth/login", {
        method: "OPTIONS",
        headers: {
          Origin: frontendOrigin,
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
        frontendOrigin,
      );
      expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
      expectPrivate(preflight);
    });
  });

  it("keeps Worker successes, errors and preflights private before proxy headers are applied", async () => {
    env.APP_ORIGIN = frontendOrigin;
    for (const [path, method, headers, status] of [
      ["/health", "GET", {}, 200],
      ["/state", "GET", {}, 401],
      ["/auth/login", "OPTIONS", { Origin: frontendOrigin }, 204],
      ["/state", "GET", { Origin: "https://evil.example" }, 403],
      ["/auth/login", "POST", {}, 403],
      ["/auth/login", "POST", { Origin: frontendOrigin }, 400],
      [
        "/auth/login",
        "POST",
        { Origin: frontendOrigin, "Content-Length": String(12 * 1024 * 1024) },
        413,
      ],
    ] as const) {
      const response = await worker.fetch(
        new Request("https://api.test/api" + path, {
          method,
          headers,
          body: method === "POST" ? "{}" : undefined,
        }),
        env,
      );
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    const originalDb = env.DB;
    env.DB = {
      prepare() {
        throw new Error("synthetic DB failure");
      },
    } as any;
    try {
      const response = await worker.fetch(
        new Request("https://api.test/api/state", {
          headers: { Cookie: "session=synthetic" },
        }),
        env,
      );
      expect(response.status).toBe(500);
      expectPrivate(response);
      expect(await response.text()).not.toContain("synthetic DB failure");
    } finally {
      env.DB = originalDb;
    }
  });
});
