import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { harness } from "./harness";
import { mailReady } from "../src/account-mail";
import { certify } from "../../../scripts/mailjet-certification";
let h: ReturnType<typeof harness>, links: string[];
const password = "Maple river lantern planets 47";
const signup = {
  email: "owner@example.invalid",
  first_name: "Owner",
  last_name: "Test",
  password,
  confirm_password: password,
  accept_terms: true,
};
const success = () =>
  new Response(
    '{"Messages":[{"Status":"success","To":[{"MessageID":1234567890123456789,"MessageUUID":"synthetic-uuid"}]}]}',
    { status: 200 },
  );
beforeEach(() => {
  h = harness();
  links = [];
  Object.assign(h.env, {
    MAIL_PROVIDER: "mailjet",
    MAIL_DELIVERY_ENABLED: "true",
    MAIL_FREE_PLAN_CONFIRMED: "true",
    MAIL_SENDER_VERIFIED: "true",
    MAIL_FROM: signup.email,
    MAILJET_API_KEY: "synthetic-public",
    MAILJET_SECRET_KEY: "synthetic-private",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      expect(url).toBe("https://api.mailjet.com/v3.1/send");
      expect(init.headers.Authorization).toBe(
        "Basic " + btoa("synthetic-public:synthetic-private"),
      );
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const m = JSON.parse(init.body).Messages[0];
      expect(m.From).toEqual({
        Email: signup.email,
        Name: "MS Professor Agent",
      });
      expect(m.To).toEqual([{ Email: signup.email }]);
      expect(m.HTMLPart).toContain("MS PROFESSOR AGENT");
      expect(m.TrackClicks).toBe("disabled");
      expect(m.TrackOpens).toBe("disabled");
      links.push(m.TextPart.match(/https:\/\/\S+/)[0]);
      return success();
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  h.db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const token = (i = 0) =>
  new URLSearchParams(new URL(links[i]).hash.slice(1)).values().next().value!;
async function create() {
  return h.request("/auth/signup", "POST", signup);
}
it("sends Mailjet signup verification and records exact 64-bit provider ID without tokens", async () => {
  expect((await create()).status).toBe(200);
  expect(links).toHaveLength(1);
  const audit = h.db
    .prepare("SELECT * FROM audit WHERE action='account.mail.verify.accepted'")
    .get()!;
  expect(audit.entity_id).toBe("mailjet:1234567890123456789");
  expect(JSON.stringify(audit)).not.toContain(token());
  expect(
    (await h.request("/auth/verify-email", "POST", { token: token() })).status,
  ).toBe(200);
  expect(
    (await h.request("/auth/verify-email", "POST", { token: token() })).status,
  ).toBe(400);
});
it("completes reset and confirmation using the same Mailjet adapter", async () => {
  await create();
  await h.request("/auth/forgot-password", "POST", { email: signup.email });
  const replacement = "Ocean amber research horizons 92";
  expect(
    (
      await h.request("/auth/reset-password", "POST", {
        token: token(1),
        password: replacement,
        confirm_password: replacement,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request("/auth/login", "POST", {
        email: signup.email,
        password: replacement,
      })
    ).status,
  ).toBe(200);
  const last = JSON.parse(
    vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string,
  ).Messages[0];
  expect(last.Subject).toContain("Your password was reset");
  expect(last.TextPart).not.toContain(token(1));
});
it.each(["MAILJET_API_KEY", "MAILJET_SECRET_KEY"])(
  "requires both secret bindings: %s",
  (key) => {
    delete (h.env as any)[key];
    expect(mailReady(h.env)).toBe(false);
  },
);
it.each([400, 401, 403, 429])(
  "handles Mailjet HTTP %s without leaking its body",
  async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ ErrorMessage: "PRIVATE" }, { status }),
    );
    await create();
    expect(h.db.prepare("SELECT count(*) n FROM account_tokens").get()!.n).toBe(
      0,
    );
    expect(console.warn).toHaveBeenCalledWith(
      "account_mail_failure",
      "provider_rejected",
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "PRIVATE",
    );
  },
);
it("rejects per-message errors even when the HTTP status is 200", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      Messages: [{ Status: "error", Errors: [{ ErrorMessage: "PRIVATE" }] }],
    }),
  );
  await create();
  expect(h.db.prepare("SELECT count(*) n FROM account_tokens").get()!.n).toBe(
    0,
  );
});
it.each(["server", "malformed", "missing-receipt"])(
  "retains token without duplicate retry on ambiguous %s",
  async (kind) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      kind === "server"
        ? new Response(null, { status: 503 })
        : kind === "malformed"
          ? new Response("invalid", { status: 200 })
          : Response.json({ Messages: [{ Status: "success" }] }),
    );
    await create();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT count(*) n FROM account_tokens").get()!.n).toBe(
      1,
    );
  },
);
it("enforces the Mailjet Free shared daily cap", async () => {
  await create();
  h.db
    .prepare(
      "UPDATE usage_counters SET amount=180 WHERE scope='account:mail:global'",
    )
    .run();
  await h.request("/auth/forgot-password", "POST", { email: signup.email });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("uses a one-shot owner-only cron certification without enabling public delivery", async () => {
  const owner = await h.user(signup.email);
  h.env.MAIL_DELIVERY_ENABLED = "false";
  const env = {
    ...h.env,
    MAILJET_CERTIFICATION_RUN: "synthetic-operator-run",
    MAILJET_CERTIFICATION_STAGE: "verify",
    MAILJET_CERTIFICATION_RECIPIENT: signup.email,
  };
  const sender = vi.fn(async () =>
    Response.json({ Data: [{ Email: signup.email, Status: "Active" }] }),
  );
  await certify(env, sender);
  await certify(env, sender);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sender).toHaveBeenCalledTimes(1);
  expect(env.MAIL_DELIVERY_ENABLED).toBe("false");
  expect(
    h.db
      .prepare("SELECT email_verified_at FROM users WHERE id=?")
      .get(owner.id)!.email_verified_at,
  ).toBe(null);
});
it("does not certify an inactive sender or a different recipient", async () => {
  await h.user(signup.email);
  const env = {
    ...h.env,
    MAILJET_CERTIFICATION_RUN: "synthetic-operator-run",
    MAILJET_CERTIFICATION_STAGE: "verify",
    MAILJET_CERTIFICATION_RECIPIENT: "different@example.invalid",
  };
  const sender = vi.fn(async () =>
    Response.json({ Data: [{ Email: signup.email, Status: "Inactive" }] }),
  );
  await certify(env, sender);
  expect(sender).not.toHaveBeenCalled();
  env.MAILJET_CERTIFICATION_RECIPIENT = signup.email;
  await certify(env, sender);
  expect(fetch).not.toHaveBeenCalled();
});
