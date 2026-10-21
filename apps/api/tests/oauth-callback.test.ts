import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness } from "./harness";
import { startOAuth, finishOAuth, decrypt } from "../src/oauth";
import { hash, base64url } from "../src/runtime";
import { scopes, type ProviderName } from "../src/providers";
import worker from "../src/index";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
  Object.assign(h.env, {
    OAUTH_ENABLED: "true",
    LIVE_EMAIL_ENABLED: "false",
    AI_PROVIDER: "mock",
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
    GMAIL_CLIENT_ID: "synthetic-client",
    GMAIL_CLIENT_SECRET: "synthetic-secret",
    OUTLOOK_CLIENT_ID: "synthetic-client",
    OUTLOOK_CLIENT_SECRET: "synthetic-secret",
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function attempt(
  user: Awaited<ReturnType<typeof h.user>>,
  provider: ProviderName = "gmail",
) {
  const response = await startOAuth(
    h.env,
    user.id,
    new Request(h.env.APP_ORIGIN, { headers: { Cookie: user.session } }),
    provider,
    true,
  );
  const auth = new URL((await response.json()).url);
  const state = auth.searchParams.get("state")!;
  const binding = response.headers.get("Set-Cookie")!.split(";")[0];
  return {
    response,
    auth,
    state,
    binding,
    callback:
      "https://worker.test/api/oauth/" +
      provider +
      "/callback?code=synthetic-code&state=" +
      state,
  };
}
function providerMock(provider: ProviderName) {
  return vi.fn(async (url: any, init: any) => {
    if (String(url).includes("/token")) {
      const body = new URLSearchParams(init.body);
      expect(body.get("redirect_uri")).toBe(
        h.env.APP_ORIGIN + `/api/oauth/${provider}/callback`,
      );
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
        scope: scopes(provider, true).join(" "),
      });
    }
    return Response.json(
      provider === "gmail"
        ? {
            sub: "synthetic-mailbox",
            email: "qa@example.invalid",
            email_verified: true,
          }
        : { id: "synthetic-mailbox", mail: "qa@example.invalid" },
    );
  });
}
describe("OAuth callback lifecycle diagnostics and overlapping starts", () => {
  it.each(["gmail", "outlook"] as const)(
    "keeps overlapping %s attempts independently bound and single-use",
    async (provider) => {
      const user = await h.user();
      const first = await attempt(user, provider),
        second = await attempt(user, provider);
      // Model a browser: later cookies replace earlier cookies with the same name/path.
      const cookies = new Map<string, string>();
      for (const flow of [first, second])
        cookies.set(flow.binding.split("=")[0], flow.binding);
      const jar = [...cookies.values()].reverse().join("; ");
      const network = providerMock(provider);
      for (const current of [first, second]) {
        const row = h.db
          .prepare("SELECT * FROM oauth_states WHERE state_hash=?")
          .get(await hash(current.state))!;
        const verifier = await decrypt<string>(
          h.env,
          `${user.id}:${provider}:pkce`,
          String(row.verifier),
        );
        const challenge = base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          ),
        );
        expect(current.auth.searchParams.get("code_challenge")).toBe(challenge);
        const result = await finishOAuth(
          h.env,
          new Request(current.callback, {
            headers: { Cookie: jar, "X-Forwarded-Host": "attacker.invalid" },
          }),
          provider,
          network as any,
        );
        expect(result.status).toBe(303);
        expect(result.headers.get("Location")).toBe(
          h.env.APP_ORIGIN + "/?connection=connected",
        );
        expect(result.headers.get("Set-Cookie")).toBe(
          current.binding.split("=")[0] +
            `=; HttpOnly; Secure; SameSite=Lax; Path=/api/oauth/${provider}/callback; Max-Age=0`,
        );
        await expect(
          finishOAuth(
            h.env,
            new Request(current.callback, { headers: { Cookie: jar } }),
            provider,
            network as any,
          ),
        ).rejects.toMatchObject({ status: 400 });
      }
      expect(network).toHaveBeenCalledTimes(4);
      expect(
        h.db.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n,
      ).toBe(0);
      const connection = h.db.prepare("SELECT * FROM connections").get()!;
      expect(String(connection.tokens)).not.toContain("synthetic-refresh");
    },
  );
  it.each([
    "state_missing",
    "state_not_found",
    "state_expired",
    "binding_cookie_missing",
    "binding_cookie_mismatch",
    "session_validation",
    "authorization_incomplete",
    "pkce_decryption",
  ])("logs only category %s and never exchanges a code", async (category) => {
    const user = await h.user();
    const flow = await attempt(user);
    let callback = flow.callback,
      binding = flow.binding;
    if (category === "state_missing")
      callback =
        "https://worker.test/api/oauth/gmail/callback?code=synthetic-code";
    if (category === "state_not_found")
      h.db.prepare("DELETE FROM oauth_states").run();
    if (category === "state_expired")
      h.db.prepare("UPDATE oauth_states SET expires_at=?").run(Date.now() - 1);
    if (category === "binding_cookie_missing") binding = user.session; // Cookie header exists, but the required binding is absent.
    if (category === "binding_cookie_mismatch")
      binding = binding.split("=")[0] + "=synthetic-wrong-binding";
    if (category === "session_validation")
      h.db.prepare("DELETE FROM sessions").run();
    if (category === "authorization_incomplete")
      callback = callback.replace("code=synthetic-code", "error=access_denied");
    if (category === "pkce_decryption")
      h.db
        .prepare(
          "UPDATE oauth_states SET verifier='synthetic-corrupt-ciphertext'",
        )
        .run();
    const network = vi.fn();
    await expect(
      finishOAuth(
        h.env,
        new Request(callback, { headers: { Cookie: binding } }),
        "gmail",
        network as any,
      ),
    ).rejects.toMatchObject({
      status:
        category === "session_validation"
          ? 401
          : category === "pkce_decryption"
            ? 503
            : 400,
    });
    expect(network).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "oauth_callback_failure",
      category,
    );
  });
  it("rejects another attempt's binding without consuming either valid state", async () => {
    const user = await h.user();
    const first = await attempt(user),
      second = await attempt(user);
    const renamedWrongCookie =
      first.binding.split("=")[0] + "=" + second.binding.split("=")[1];
    const network = vi.fn();
    await expect(
      finishOAuth(
        h.env,
        new Request(first.callback, {
          headers: { Cookie: renamedWrongCookie },
        }),
        "gmail",
        network as any,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "oauth_callback_failure",
      "binding_cookie_mismatch",
    );
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()!.n,
    ).toBe(2);
    expect(network).not.toHaveBeenCalled();
  });
  it("uses the configured redirect through a rewritten Worker URL without a Strict session cookie", async () => {
    const user = await h.user();
    const flow = await attempt(user);
    const network = providerMock("gmail");
    vi.stubGlobal("fetch", network);
    const result = await worker.fetch(
      new Request(flow.callback, {
        headers: {
          Cookie: flow.binding,
          "X-Forwarded-Host": "untrusted.invalid",
          "X-Forwarded-Proto": "http",
        },
      }),
      h.env,
    );
    expect(result.status).toBe(303);
    expect(result.headers.get("Location")).toBe(
      h.env.APP_ORIGIN + "/?connection=connected",
    );
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    expect(flow.auth.searchParams.get("redirect_uri")).toBe(
      h.env.APP_ORIGIN + "/api/oauth/gmail/callback",
    );
  });
});
