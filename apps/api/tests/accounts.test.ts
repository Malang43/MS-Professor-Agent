import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, fileForm } from "./harness";
import { hash } from "../src/runtime";
import { passwordHash } from "../src/passwords";
import { cleanDeletedAccounts } from "../src/accounts";
let h: ReturnType<typeof harness>;
const password = "Maple river lantern planets 47";
const signup = {
  email: "new@example.com",
  password,
  confirm_password: password,
  first_name: "Amira",
  last_name: "Khan",
  display_name: "Amira K",
  accept_terms: true,
};
let links: string[];
beforeEach(() => {
  h = harness();
  links = [];
  Object.assign(h.env, {
    MAIL_PROVIDER: "brevo",
    MAIL_DELIVERY_ENABLED: "true",
    MAIL_FREE_PLAN_CONFIRMED: "true",
    MAIL_FROM: "operator@example.com",
    BREVO_API_KEY: "synthetic-secret",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      expect(url).toBe("https://api.brevo.com/v3/smtp/email");
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(init.body);
      links.push(body.textContent.match(/https:\/\/\S+/)[0]);
      return Response.json({ messageId: "synthetic" });
    }),
  );
});
afterEach(() => {
  h.db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function create() {
  expect((await h.request("/auth/signup", "POST", signup)).status).toBe(200);
  return login();
}
async function login(email = signup.email, pw = password) {
  const r = await h.request("/auth/login", "POST", { email, password: pw });
  expect(r.status).toBe(200);
  return r.headers.get("Set-Cookie")!.split(";")[0];
}
const token = (link: string) =>
  new URLSearchParams(new URL(link).hash.slice(1)).values().next().value!;
async function verify() {
  return h.request("/auth/verify-email", "POST", { token: token(links[0]) });
}
describe("account lifecycle", () => {
  it("requires names, confirmation, terms and guess-resistant passwords", async () => {
    for (const change of [
      { first_name: "" },
      { last_name: "" },
      { accept_terms: false },
      { confirm_password: "different" },
      { password: "password123456789", confirm_password: "password123456789" },
    ])
      expect(
        (await h.request("/auth/signup", "POST", { ...signup, ...change }))
          .status,
      ).toBe(400);
    expect(h.db.prepare("SELECT COUNT(*) n FROM users").get()!.n).toBe(0);
  });
  it("stores hashed verification tokens and gates new users without leaking token data", async () => {
    const session = await create();
    expect((await h.request("/state", "GET", undefined, session)).status).toBe(
      403,
    );
    expect((await h.request("/professors", "POST", [], session)).status).toBe(
      403,
    );
    const row = h.db.prepare("SELECT * FROM account_tokens").get()!;
    expect(row.token_hash).toBe(await hash(token(links[0])));
    expect(JSON.stringify(row)).not.toContain(token(links[0]));
    expect((await verify()).status).toBe(200);
    expect((await h.request("/state", "GET", undefined, session)).status).toBe(
      200,
    );
    expect((await verify()).status).toBe(400);
  });
  it("does not consume tokens with a GET or wrong Origin", async () => {
    await create();
    const raw = token(links[0]);
    expect((await h.request("/auth/verify-email", "GET")).status).toBe(405);
    expect(
      (
        await h.request(
          "/auth/verify-email",
          "POST",
          { token: raw },
          "",
          "https://evil.invalid",
        )
      ).status,
    ).toBe(403);
    expect((await verify()).status).toBe(200);
  });
  it("rejects expired tokens and permits a rate-limited resend", async () => {
    const session = await create();
    h.db.exec("UPDATE account_tokens SET expires_at=0");
    expect((await verify()).status).toBe(400);
    expect(
      (await h.request("/auth/resend-verification", "POST", undefined, session))
        .status,
    ).toBe(200);
    expect(
      (
        await h.request("/auth/verify-email", "POST", {
          token: token(links[1]),
        })
      ).status,
    ).toBe(200);
  });
  it("limits recovery requests identically for unknown accounts", async () => {
    const bodies = [];
    for (const email of [signup.email, "missing@example.com"]) {
      const r = await h.request("/auth/forgot-password", "POST", { email });
      bodies.push(await r.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await h.request("/auth/forgot-password", "POST", {
            email: signup.email,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await h.request("/auth/forgot-password", "POST", {
          email: signup.email,
        })
      ).status,
    ).toBe(429);
  });
  it("returns the same signup response for an existing address", async () => {
    const a = await h.request("/auth/signup", "POST", signup),
      b = await h.request("/auth/signup", "POST", signup);
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
    expect(a.headers.get("Set-Cookie")).toBe(null);
    expect(b.headers.get("Set-Cookie")).toBe(null);
  });
  it("fails closed on missing delivery without falsely verifying", async () => {
    h.env.MAIL_DELIVERY_ENABLED = "false";
    const session = await create();
    expect(links).toHaveLength(0);
    expect((await h.request("/state", "GET", undefined, session)).status).toBe(
      403,
    );
    const me = (await (
      await h.request("/auth/me", "GET", undefined, session)
    ).json()) as any;
    expect(me.mail_delivery_ready).toBe(false);
    expect(me.account.email_verified_at).toBe(null);
  });
  it("resets a password once and revokes every session and OAuth state", async () => {
    const session = await create();
    await verify();
    const other = await login();
    await h.request("/auth/forgot-password", "POST", { email: signup.email });
    const raw = token(links[1]);
    const replacement = "Ocean amber research horizons 92";
    const body = {
      token: raw,
      password: replacement,
      confirm_password: replacement,
    };
    expect((await h.request("/auth/reset-password", "POST", body)).status).toBe(
      200,
    );
    expect((await h.request("/auth/reset-password", "POST", body)).status).toBe(
      400,
    );
    for (const s of [session, other])
      expect((await h.request("/auth/me", "GET", undefined, s)).status).toBe(
        401,
      );
    expect(
      (
        await h.request("/auth/login", "POST", {
          email: signup.email,
          password,
        })
      ).status,
    ).toBe(401);
    await login(signup.email, replacement);
  });
  it("cannot redeem verification tokens for recovery or vice versa", async () => {
    await create();
    const raw = token(links[0]);
    expect(
      (
        await h.request("/auth/reset-password", "POST", {
          token: raw,
          password,
          confirm_password: password,
        })
      ).status,
    ).toBe(400);
    expect((await verify()).status).toBe(200);
  });
  it("allows exactly one concurrent redemption", async () => {
    await create();
    const responses = await Promise.all([verify(), verify()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  });
  it("keeps grandfathered accounts working without marking them verified", async () => {
    const user = await h.user("legacy@example.com");
    expect(
      (await h.request("/state", "GET", undefined, user.session)).status,
    ).toBe(200);
    const me = (await (
      await h.request("/auth/me", "GET", undefined, user.session)
    ).json()) as any;
    expect(me.account.legacy_access).toBe(1);
    expect(me.account.email_verified_at).toBe(null);
  });
  it("isolates names and professor editing by authenticated identity", async () => {
    const a = await h.user(),
      b = await h.user("other@example.com");
    expect(
      (
        await h.request(
          "/account/profile",
          "PUT",
          {
            first_name: "Amira",
            last_name: "Khan",
            display_name: "A K",
            user_id: b.id,
          },
          a.session,
        )
      ).status,
    ).toBe(200);
    expect(
      h.db.prepare("SELECT display_name FROM users WHERE id=?").get(b.id)!
        .display_name,
    ).toBe("");
    await h.request(
      "/professors",
      "POST",
      [{ name: "Test", email: "prof@example.edu" }],
      a.session,
    );
    const id = h.db.prepare("SELECT id FROM professors").get()!.id;
    expect(
      (
        await h.request(
          "/professors/" + id,
          "PUT",
          { name: "Edited", email: "prof@example.edu" },
          b.session,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          "/professors/" + id,
          "PUT",
          { name: "Edited", email: "prof@example.edu" },
          a.session,
        )
      ).status,
    ).toBe(200);
  });
  it("requires current password to change password and revokes all sessions", async () => {
    const session = await create();
    await verify();
    const replacement = "Ocean amber research horizons 92";
    const input = {
      current_password: "wrong",
      password: replacement,
      confirm_password: replacement,
    };
    expect(
      (await h.request("/auth/change-password", "POST", input, session)).status,
    ).toBe(401);
    expect(
      (
        await h.request(
          "/auth/change-password",
          "POST",
          { ...input, current_password: password },
          session,
        )
      ).status,
    ).toBe(200);
    expect((await h.request("/state", "GET", undefined, session)).status).toBe(
      401,
    );
    await login(signup.email, replacement);
  });
  it("logout all cannot revoke another tenant", async () => {
    const a = await h.user(),
      b = await h.user("other@example.com");
    expect(
      (
        await h.request(
          "/auth/logout-all",
          "POST",
          { user_id: b.id },
          a.session,
        )
      ).status,
    ).toBe(200);
    expect(
      (await h.request("/state", "GET", undefined, a.session)).status,
    ).toBe(401);
    expect(
      (await h.request("/state", "GET", undefined, b.session)).status,
    ).toBe(200);
  });
  it("requires reauthentication and explicit confirmation for deletion", async () => {
    const session = await create();
    await verify();
    for (const input of [
      { current_password: "wrong", confirmation: "DELETE MY ACCOUNT" },
      { current_password: password, confirmation: "DELETE" },
    ])
      expect([400, 401]).toContain(
        (await h.request("/account/delete", "POST", input, session)).status,
      );
    expect(h.db.prepare("SELECT COUNT(*) n FROM users").get()!.n).toBe(1);
  });
  it("atomically deletes private data, isolates another user and retries opaque KV cleanup", async () => {
    const session = await create();
    await verify();
    const other = await h.user("other@example.com");
    const doc = (await (
      await h.request("/documents", "POST", fileForm(), session)
    ).json()) as any;
    await h.request(
      "/professors",
      "POST",
      [{ name: "Test", email: "prof@example.edu" }],
      session,
    );
    const p = h.db.prepare("SELECT id FROM professors").get()!.id;
    await h.request(
      "/messages",
      "POST",
      {
        professor_id: p,
        subject: "Test",
        body: "Unsent",
        mode: "auto",
        authorized: true,
        scheduled_at: "2099-01-01T00:00:00.000Z",
        timezone: "UTC",
        attachments: [doc.id],
      },
      session,
    );
    const owner = h.db
      .prepare("SELECT id FROM users WHERE email=?")
      .get(signup.email)!.id;
    const connection = crypto.randomUUID();
    h.db
      .prepare(
        "INSERT INTO connections(id,user_id,provider,address,subject,scopes,tokens,expires_at) VALUES(?,?,'gmail','synthetic@example.invalid','synthetic','gmail.send','synthetic-encrypted-test-token',0)",
      )
      .run(connection, owner);
    const messageId = h.db.prepare("SELECT id FROM messages").get()!.id;
    h.db
      .prepare(
        "INSERT INTO transports(message_id,user_id,connection_id,snapshot) VALUES(?,?,?,'{}')",
      )
      .run(messageId, owner, connection);
    h.db
      .prepare(
        "INSERT INTO automation(message_id,days,subject,body) VALUES(?,7,'Test','Test')",
      )
      .run(messageId);
    h.db
      .prepare(
        "INSERT INTO mailbox_events(connection_id,provider_id,message_id,kind,received_at) VALUES(?,'synthetic',?,'reply','2026-01-01')",
      )
      .run(connection, messageId);
    const response = await h.request(
      "/account/delete",
      "POST",
      {
        current_password: password,
        confirmation: "DELETE MY ACCOUNT",
        user_id: other.id,
      },
      session,
    );
    expect(response.status).toBe(200);
    expect(
      (
        await h.request("/auth/login", "POST", {
          email: signup.email,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (await h.request("/documents/" + doc.id, "GET", undefined, session))
        .status,
    ).toBe(401);
    expect(
      (await h.request("/state", "GET", undefined, other.session)).status,
    ).toBe(200);
    for (const table of [
      "messages",
      "professors",
      "documents",
      "connections",
      "notifications",
    ])
      expect(h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(h.bytes.size).toBe(1);
    h.db.exec("UPDATE account_deletion_objects SET next_at=0");
    h.flags.failDelete = true;
    await cleanDeletedAccounts(h.env);
    expect(
      h.db.prepare("SELECT attempts FROM account_deletion_objects").get()!
        .attempts,
    ).toBe(1);
    h.flags.failDelete = false;
    h.db.exec("UPDATE account_deletion_objects SET next_at=0");
    await cleanDeletedAccounts(h.env);
    expect(h.bytes.size).toBe(0);
    expect(
      h.db.prepare("SELECT purged FROM account_deletion_objects").get()!.purged,
    ).toBe(1);
    expect(h.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
  it("does not log provider responses or recovery tokens on delivery failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "PRIVATE" }, { status: 400 })),
    );
    await create();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "account_mail_failure",
      "provider_rejected",
    );
  });
});

it("conservatively retains deleted-account byte reservations until TTL expiry", async () => {
  const user = await h.user();
  h.db
    .prepare(
      "INSERT INTO account_deletion_objects(object_key,backend,size,expires_at,next_at,purged) VALUES('opaque','kv',?,?,?,1)",
    )
    .run(100 * 1024 * 1024, Date.now() + 86400000, Date.now() + 86400000);
  expect(
    (await h.request("/documents", "POST", fileForm(), user.session)).status,
  ).toBe(429);
});
it("does not claim a one-minute retry for an hourly recovery limit", async () => {
  for (let i = 0; i < 3; i++)
    expect(
      (
        await h.request("/auth/forgot-password", "POST", {
          email: "missing@example.com",
        })
      ).status,
    ).toBe(200);
  const response = await h.request("/auth/forgot-password", "POST", {
    email: "missing@example.com",
  });
  const expected = Math.ceil(
    (Math.floor(Date.now() / 3600000) * 3600000 + 3600000 - Date.now()) / 1000,
  );
  expect(response.status).toBe(429);
  expect(
    Math.abs(Number(response.headers.get("Retry-After")) - expected),
  ).toBeLessThanOrEqual(1);
});

it("keeps existing data and credentials byte-for-byte through the additive migration", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of ["0001_initial.sql", "0002_storage_integrations.sql"])
      db.exec(
        readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
      );
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users(id,email,password) VALUES(?,'legacy@example.invalid','synthetic-existing-password-hash')",
    ).run(id);
    db.prepare(
      "INSERT INTO profiles(user_id,name) VALUES(?,'Existing Researcher')",
    ).run(id);
    db.prepare(
      "INSERT INTO connections(id,user_id,provider,address,subject,scopes,tokens,expires_at) VALUES(?,?,'gmail','synthetic@example.invalid','existing','gmail.send','synthetic-encrypted-existing-token',123)",
    ).run(crypto.randomUUID(), id);
    db.exec(
      readFileSync(
        new URL("../migrations/0003_account_security.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      db
        .prepare(
          "SELECT password,legacy_access,email_verified_at,display_name FROM users",
        )
        .get(),
    ).toMatchObject({
      password: "synthetic-existing-password-hash",
      legacy_access: 1,
      email_verified_at: null,
      display_name: "Existing Researcher",
    });
    expect(db.prepare("SELECT tokens FROM connections").get()!.tokens).toBe(
      "synthetic-encrypted-existing-token",
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("attempts Google revocation only through a bounded non-redirecting request", async () => {
  const { encrypt, revokeMailboxTokens } = await import("../src/oauth");
  h.env.TOKEN_ENCRYPTION_KEY = btoa(
    String.fromCharCode(...new Uint8Array(32).fill(9)),
  );
  const user = await h.user();
  const tokens = await encrypt(h.env, `${user.id}:gmail:tokens:v1`, {
    refresh_token: "synthetic-refresh",
  });
  const network = vi.fn(async (_url: any, init: any) => {
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(init.body).get("token")).toBe(
      "synthetic-refresh",
    );
    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.invalid/" },
    });
  });
  expect(
    await revokeMailboxTokens(
      h.env,
      user.id,
      { provider: "gmail", tokens },
      network,
    ),
  ).toBe(false);
  expect(network).toHaveBeenCalledTimes(1);
});
