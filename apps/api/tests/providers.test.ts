import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { harness } from "./harness";
import {
  encrypt,
  decrypt,
  startOAuth,
  finishOAuth,
  accessToken,
  cookie,
} from "../src/oauth";
import { emailProvider, mime, scopes, ProviderError } from "../src/providers";
import { generateDraft } from "../src/ai";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
  h.env.APP_ORIGIN = "https://unit-test.vercel.app";
  h.env.OAUTH_ENABLED = "true";
  h.env.TOKEN_ENCRYPTION_KEY = btoa(
    String.fromCharCode(...new Uint8Array(32).fill(7)),
  );
  h.env.GMAIL_CLIENT_ID = "synthetic-client";
  h.env.GMAIL_CLIENT_SECRET = "synthetic-secret";
  h.env.OUTLOOK_CLIENT_ID = "synthetic-client";
  h.env.OUTLOOK_CLIENT_SECRET = "synthetic-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network forbidden");
    }),
  );
});
afterEach(() => {
  h.db.close();
  vi.unstubAllGlobals();
});
describe("OAuth security and provider adapters", () => {
  it("binds PKCE/state to browser and active session, encrypts tokens, and rejects callback replay", async () => {
    const a = await h.user();
    const start = await startOAuth(
      h.env,
      a.id,
      new Request(h.env.APP_ORIGIN, { headers: { Cookie: a.session } }),
      "gmail",
      true,
    );
    const { url } = await start.json();
    const auth = new URL(url);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("scope")).toContain("gmail.readonly");
    expect(start.headers.get("Set-Cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
    const binding = start.headers.get("Set-Cookie")!.split(";")[0],
      state = auth.searchParams.get("state");
    const callbackUrl =
      h.env.APP_ORIGIN +
      "/api/oauth/gmail/callback?code=synthetic-code&state=" +
      state;
    const row = h.db.prepare("SELECT * FROM oauth_states").get()!;
    expect(row.state_hash).not.toBe(state);
    const verifier = await decrypt<string>(
      h.env,
      a.id + ":gmail:pkce",
      String(row.verifier),
    );
    expect(auth.searchParams.get("code_challenge")).not.toBe(verifier);
    const calls = vi.fn(async (url: any, init: any) => {
      if (String(url).includes("/token")) {
        expect(new URLSearchParams(init.body).get("code_verifier")).toBe(
          verifier,
        );
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
          scope: scopes("gmail", true).join(" "),
        });
      }
      return Response.json({
        sub: "mailbox-id",
        email: "controlled@example.com",
        email_verified: true,
      });
    });
    await expect(
      finishOAuth(h.env, new Request(callbackUrl), "gmail", calls as any),
    ).rejects.toThrow("Invalid or expired");
    const finished = await finishOAuth(
      h.env,
      new Request(callbackUrl, { headers: { Cookie: binding } }),
      "gmail",
      calls as any,
    );
    expect(finished.status).toBe(303);
    const connection = h.db.prepare("SELECT * FROM connections").get()!;
    expect(String(connection.tokens)).not.toContain("synthetic-refresh");
    const tokens = await decrypt<any>(
      h.env,
      a.id + ":gmail:tokens:v1",
      String(connection.tokens),
    );
    expect(tokens.refresh_token).toBe("synthetic-refresh");
    await expect(
      decrypt(h.env, "another-user:gmail:tokens:v1", String(connection.tokens)),
    ).rejects.toThrow();
    await expect(
      finishOAuth(
        h.env,
        new Request(callbackUrl, { headers: { Cookie: binding } }),
        "gmail",
        calls as any,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it("rejects callback after session revocation without exchanging a code", async () => {
    const a = await h.user();
    const start = await startOAuth(
      h.env,
      a.id,
      new Request(h.env.APP_ORIGIN, { headers: { Cookie: a.session } }),
      "outlook",
      false,
    );
    const { url } = await start.json();
    h.db.prepare("DELETE FROM sessions").run();
    const callback =
      h.env.APP_ORIGIN +
      "/api/oauth/outlook/callback?code=synthetic&state=" +
      new URL(url).searchParams.get("state");
    const network = vi.fn();
    await expect(
      finishOAuth(
        h.env,
        new Request(callback, {
          headers: { Cookie: start.headers.get("Set-Cookie")!.split(";")[0] },
        }),
        "outlook",
        network as any,
      ),
    ).rejects.toThrow("Session expired");
    expect(network).not.toHaveBeenCalled();
  });
  it("rotates refresh tokens under a lease and wipes revoked credentials", async () => {
    const a = await h.user();
    const id = crypto.randomUUID(),
      tokens = await encrypt(h.env, a.id + ":outlook:tokens:v1", {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_in: 1,
      });
    h.db
      .prepare(
        "INSERT INTO connections(id,user_id,provider,address,subject,scopes,tokens,expires_at) VALUES(?,?,?,?,?,?,?,0)",
      )
      .run(
        id,
        a.id,
        "outlook",
        "controlled@example.com",
        "subject",
        "Mail.Send Mail.Read",
        tokens,
      );
    const connection = h.db.prepare("SELECT * FROM connections").get();
    const network = vi.fn(async () =>
      Response.json({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    );
    expect(await accessToken(h.env, connection, network as any)).toBe(
      "new-access",
    );
    const stored = h.db.prepare("SELECT * FROM connections").get()!;
    expect(
      (
        await decrypt<any>(
          h.env,
          a.id + ":outlook:tokens:v1",
          String(stored.tokens),
        )
      ).refresh_token,
    ).toBe("rotated-refresh");
    h.db.prepare("UPDATE connections SET expires_at=0").run();
    const revoked = vi.fn(async () => new Response("{}", { status: 400 }));
    await expect(
      accessToken(
        h.env,
        h.db.prepare("SELECT * FROM connections").get(),
        revoked as any,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(
      h.db.prepare("SELECT status,tokens FROM connections").get(),
    ).toMatchObject({ status: "reconnect", tokens: null });
  });
  it("builds MIME safely, sends Gmail attachments and treats Graph 202 as unconfirmed", async () => {
    const envelope = {
      recipient: "controlled@example.com",
      subject: "Unicode r\u00e9sum\u00e9",
      body: "Hello",
      messageKey: "synthetic@ms-professor-agent.invalid",
      attachments: [
        {
          name: "cv.txt",
          type: "text/plain",
          bytes: new TextEncoder().encode("CV").buffer,
        },
      ],
    };
    const mimeText = mime(envelope);
    expect(mimeText).toContain("Content-Disposition: attachment;");
    expect(mimeText).toContain(
      "Message-ID: <synthetic@ms-professor-agent.invalid>",
    );
    expect(() =>
      mime({ ...envelope, subject: "Hello\r\nBcc: victim@example.com" }),
    ).toThrow("Invalid mail header");
    const gmail = vi.fn(async () =>
      Response.json({ id: "gmail-message", threadId: "thread" }),
    );
    expect(
      await emailProvider("gmail", gmail as any).send("synthetic", envelope),
    ).toEqual({ id: "gmail-message", threadId: "thread" });
    const request = JSON.parse((gmail.mock.calls[0] as any)[1].body);
    expect(request.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const graph = vi.fn(async () => new Response(null, { status: 202 }));
    expect(
      await emailProvider("outlook", graph as any).send("synthetic", envelope),
    ).toEqual({ id: null, threadId: null });
  });
  it("distinguishes safe rate-limit retries from uncertain sends and blocks cursor SSRF", async () => {
    const envelope = {
      recipient: "controlled@example.com",
      subject: "s",
      body: "b",
      messageKey: "key",
      attachments: [],
    };
    await expect(
      emailProvider(
        "gmail",
        (async () => new Response(null, { status: 429 })) as any,
      ).send("synthetic", envelope),
    ).rejects.toMatchObject({ kind: "retry" });
    await expect(
      emailProvider(
        "gmail",
        (async () => new Response(null, { status: 500 })) as any,
      ).send("synthetic", envelope),
    ).rejects.toMatchObject({ kind: "uncertain" });
    const network = vi.fn();
    await expect(
      emailProvider("outlook", network as any).replies(
        "synthetic",
        "thread",
        "https://attacker.example/steal",
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it("keeps AI optional, constrains model output to factual templates, and enforces daily request budgets", async () => {
    const a = await h.user();
    h.env.AI_PROVIDER = "groq";
    h.env.GROQ_API_KEY = "synthetic-key";
    h.env.GROQ_MODEL = "synthetic-model";
    h.env.GROQ_FREE_PLAN_CONFIRMED = "true";
    const network = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: '{"template":1}' } }],
        usage: { total_tokens: 35 },
      }),
    );
    for (let i = 0; i < 5; i++) {
      const draft = await generateDraft(
        h.env,
        a.id,
        { name: "Student", university: "Given University" },
        {
          name: "Professor",
          interests: "Given Topic",
          verified_at: Date.now(),
          source_url: "https://example.edu/profile",
        },
        network as any,
      );
      expect(draft.provider).toBe("groq");
      expect(draft.body).toContain("Given Topic");
    }
    const fallback = await generateDraft(
      h.env,
      a.id,
      {},
      { verified_at: Date.now(), source_url: "https://example.edu/profile" },
      network as any,
    );
    expect(fallback.provider).toBe("mock");
    expect(network).toHaveBeenCalledTimes(5);
    expect(h.db.prepare("SELECT SUM(tokens) n FROM ai_usage").get()!.n).toBe(
      175,
    );
    h.env.GROQ_API_KEY = "";
    expect(
      (
        await generateDraft(
          h.env,
          a.id,
          {},
          {
            verified_at: Date.now(),
            source_url: "https://example.edu/profile",
          },
          network as any,
        )
      ).provider,
    ).toBe("mock");
  });
  it("rejects model prose and never sends internal account identifiers or recipient email to AI", async () => {
    const a = await h.user();
    h.env.AI_PROVIDER = "groq";
    h.env.GROQ_API_KEY = "synthetic";
    h.env.GROQ_MODEL = "synthetic";
    h.env.GROQ_FREE_PLAN_CONFIRMED = "true";
    const network = vi.fn(async (_url: any, init: any) => {
      const content = JSON.parse(init.body).messages[1].content;
      expect(content).not.toContain("private-user-id");
      expect(content).not.toContain("prof-private@example.edu");
      return Response.json({
        choices: [
          {
            message: {
              content: '{"template":0,"invented_publication":"Fabricated"}',
            },
          },
        ],
      });
    });
    const result = await generateDraft(
      h.env,
      a.id,
      { name: "Student", user_id: "private-user-id" } as any,
      {
        name: "Professor",
        email: "prof-private@example.edu",
        verified_at: Date.now(),
        source_url: "https://example.edu/profile",
      } as any,
      network as any,
    );
    expect(result.provider).toBe("mock");
    expect(result.body).not.toContain("Fabricated");
  });
  it("does not call Groq with professor facts lacking source confirmation", async () => {
    const a = await h.user();
    h.env.AI_PROVIDER = "groq";
    h.env.GROQ_API_KEY = "synthetic";
    h.env.GROQ_MODEL = "synthetic";
    h.env.GROQ_FREE_PLAN_CONFIRMED = "true";
    const network = vi.fn();
    const result = await generateDraft(
      h.env,
      a.id,
      {},
      { name: "Unconfirmed" },
      network as any,
    );
    expect(result.provider).toBe("mock");
    expect(result.warning).toContain("Confirm professor");
    expect(network).not.toHaveBeenCalled();
  });
  it("requires owned professor facts, HTTPS source and explicit confirmation", async () => {
    const a = await h.user(),
      b = await h.user("other@example.com"),
      id = crypto.randomUUID();
    h.db
      .prepare("INSERT INTO professors(id,user_id,name,email) VALUES(?,?,?,?)")
      .run(id, a.id, "Test", "prof@example.edu");
    expect(
      (
        await h.request(
          "/professors/" + id + "/verify",
          "POST",
          { source_url: "https://example.edu/profile", confirmed: true },
          b.session,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          "/professors/" + id + "/verify",
          "POST",
          { source_url: "http://example.edu/profile", confirmed: true },
          a.session,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          "/professors/" + id + "/verify",
          "POST",
          { source_url: "https://example.edu/profile", confirmed: true },
          a.session,
        )
      ).status,
    ).toBe(200);
    expect(
      Number(
        h.db.prepare("SELECT verified_at FROM professors").get()!.verified_at,
      ),
    ).toBeGreaterThan(0);
  });
});
