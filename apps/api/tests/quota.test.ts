import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { harness } from "./harness";
import { consume, HttpError } from "../src/runtime";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T12:00:30.250Z"));
  h = harness();
  Object.assign(h.env, {
    OAUTH_ENABLED: "true",
    LIVE_EMAIL_ENABLED: "false",
    AI_PROVIDER: "mock",
    GMAIL_CLIENT_ID: "synthetic-client",
    GMAIL_CLIENT_SECRET: "synthetic-secret",
    OUTLOOK_CLIENT_ID: "synthetic-client",
    OUTLOOK_CLIENT_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network forbidden");
    }),
  );
});
afterEach(() => {
  h.db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const start = (session: string, provider = "gmail") =>
  h.request(
    `/connections/${provider}/start`,
    "POST",
    { read_replies: true },
    session,
  );
describe("production quota reporting and outreach independence", () => {
  it("reports next UTC midnight instead of a misleading one-minute retry", async () => {
    await consume(h.env, "daily-test", 1);
    let error: unknown;
    try {
      await consume(h.env, "daily-test", 1);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: 43170 });
    expect(
      h.db
        .prepare("SELECT amount FROM usage_counters WHERE scope='daily-test'")
        .get()!.amount,
    ).toBe(1);
  });
  it("reports the actual next calendar-minute boundary for minute quotas", async () => {
    const period = new Date().toISOString().slice(0, 16);
    await consume(h.env, "minute-test", 1, 1, period);
    await expect(
      consume(h.env, "minute-test", 1, 1, period),
    ).rejects.toMatchObject({ status: 429, retryAfter: 30 });
    vi.setSystemTime(new Date("2026-10-21T12:01:00.000Z"));
    await consume(
      h.env,
      "minute-test",
      1,
      1,
      new Date().toISOString().slice(0, 16),
    );
  });
  it("keeps the five-start shared Gmail/Outlook limit and resets by new UTC period", async () => {
    const user = await h.user();
    h.db
      .prepare("UPDATE sessions SET expires_at=?")
      .run(Date.parse("2026-10-23T00:00:00Z"));
    for (const provider of ["gmail", "outlook", "gmail", "outlook", "gmail"])
      expect((await start(user.session, provider)).status).toBe(200);
    const blocked = await start(user.session);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("43170");
    expect((await blocked.json()).error).toContain(
      "5 starts per account (shared by Gmail and Outlook) per UTC day. Resets at 2026-10-22T00:00:00.000Z",
    );
    expect(console.warn).toHaveBeenCalledWith(
      "oauth_start_failure",
      "account_quota",
    );
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n,
    ).toBe(5);
    expect(
      h.db
        .prepare(
          "SELECT amount FROM usage_counters WHERE scope=? AND period='2026-10-21'",
        )
        .get("oauth:" + user.id)!.amount,
    ).toBe(5);
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    expect((await start(user.session)).status).toBe(200);
    expect(
      h.db
        .prepare(
          "SELECT amount FROM usage_counters WHERE scope=? AND period='2026-10-22'",
        )
        .get("oauth:" + user.id)!.amount,
    ).toBe(1);
  });
  it("retains the independent global fifty-start limit and names it safely", async () => {
    const user = await h.user();
    h.db
      .prepare(
        "INSERT INTO usage_counters VALUES('oauth:global','2026-10-21',50)",
      )
      .run();
    const response = await start(user.session);
    expect(response.status).toBe(429);
    expect((await response.json()).error).toContain(
      "50 starts application-wide",
    );
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "oauth_start_failure",
      "global_quota",
    );
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n,
    ).toBe(0);
    expect(
      h.db
        .prepare("SELECT amount FROM usage_counters WHERE scope='oauth:global'")
        .get()!.amount,
    ).toBe(50);
  });
  it("does not apply the OAuth quota to dashboard reads or login sessions", async () => {
    const user = await h.user();
    h.db
      .prepare("INSERT INTO usage_counters VALUES(?,'2026-10-21',5)")
      .run("oauth:" + user.id);
    expect((await start(user.session)).status).toBe(429);
    const dashboard = await h.request("/state", "GET", undefined, user.session);
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json()).capabilities.gmail).toBe(true);
  });
  it("keeps stopped outreach independent of OAuth and does not revive cancelled drafts on resume", async () => {
    const user = await h.user();
    const professor = crypto.randomUUID();
    h.db
      .prepare("INSERT INTO professors(id,user_id,name,email) VALUES(?,?,?,?)")
      .run(professor, user.id, "QA", "qa@example.invalid");
    for (const status of ["draft", "pending"])
      h.db
        .prepare(
          "INSERT INTO messages(id,user_id,professor_id,subject,body,mode,status,scheduled_at,timezone) VALUES(?,?,?,?,?,'manual',?,'2026-10-22T00:00:00Z','UTC')",
        )
        .run(
          crypto.randomUUID(),
          user.id,
          professor,
          "Synthetic",
          "Synthetic",
          status,
        );
    expect(
      (await h.request("/control", "POST", { action: "stop" }, user.session))
        .status,
    ).toBe(200);
    expect(
      h.db.prepare("SELECT stopped FROM profiles WHERE user_id=?").get(user.id)!
        .stopped,
    ).toBe(1);
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE status='cancelled'")
        .get()!.n,
    ).toBe(2);
    expect((await start(user.session)).status).toBe(200);
    await h.request("/control", "POST", { action: "resume" }, user.session);
    expect(
      h.db.prepare("SELECT stopped FROM profiles WHERE user_id=?").get(user.id)!
        .stopped,
    ).toBe(0);
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE status='cancelled'")
        .get()!.n,
    ).toBe(2);
  });
  it("counts a denied consent attempt without refunding or bypassing its security budget", async () => {
    const user = await h.user();
    const response = await start(user.session);
    const state = new URL((await response.json()).url).searchParams.get(
      "state",
    )!;
    const binding = response.headers.get("Set-Cookie")!.split(";")[0];
    const denied = await h.request(
      "/oauth/gmail/callback?" +
        new URLSearchParams({ state, error: "access_denied" }),
      "GET",
      undefined,
      binding,
      null,
    );
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toBe(
      "Account authorization was not completed.",
    );
    expect(
      h.db
        .prepare("SELECT amount FROM usage_counters WHERE scope=?")
        .get("oauth:" + user.id)!.amount,
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid encryption configuration before charging a connection attempt", async () => {
    const user = await h.user();
    h.env.TOKEN_ENCRYPTION_KEY = "synthetic-invalid-base64";
    expect((await start(user.session)).status).toBe(503);
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM usage_counters").get()!.n,
    ).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
