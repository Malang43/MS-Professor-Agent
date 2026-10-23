// Temporary operator entrypoint. Deploy only for an explicitly authorized inbox
// certification, then redeploy src/index.ts. It adds no HTTP routes or sessions.
import worker from "../apps/api/src/index";
import { accountPrivate, accountPublic } from "../apps/api/src/accounts";
import { type Env } from "../apps/api/src/runtime";
export type CertificationEnv = Env & {
  MAILJET_CERTIFICATION_RUN?: string;
  MAILJET_CERTIFICATION_STAGE?: string;
  MAILJET_CERTIFICATION_RECIPIENT?: string;
};
export async function certify(
  env: CertificationEnv,
  network: typeof fetch = fetch,
) {
  const run = env.MAILJET_CERTIFICATION_RUN,
    stage = env.MAILJET_CERTIFICATION_STAGE;
  if (
    !run ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(run) ||
    !["inspect", "verify", "reset"].includes(stage || "")
  )
    return;
  const recipient = env.MAILJET_CERTIFICATION_RECIPIENT;
  if (
    !recipient ||
    recipient !== env.MAIL_FROM ||
    !env.MAILJET_API_KEY ||
    !env.MAILJET_SECRET_KEY
  )
    return;
  const user = await env.DB.prepare(
    "SELECT id,email,email_verified_at FROM users WHERE email=?",
  )
    .bind(recipient)
    .first<{ id: string; email: string; email_verified_at: number | null }>();
  if (!user) return;
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO audit(id,user_id,action,entity_id) VALUES(?,?,'mailjet.certification.claimed',?)",
  )
    .bind("mailjet-cert:" + run + ":" + stage, user.id, run)
    .run();
  if (!claimed.meta.changes) return; // One attempt, including interrupted/ambiguous outcomes.
  const record = async (status: string, entity = run) => {
    await env.DB.prepare(
      "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        user.id,
        "mailjet.certification." + status,
        entity,
      )
      .run();
  };
  const get = async (path: string) => {
    const r = await network("https://api.mailjet.com/v3/REST/" + path, {
      headers: {
        Authorization:
          "Basic " + btoa(env.MAILJET_API_KEY + ":" + env.MAILJET_SECRET_KEY),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error("http_" + r.status);
    }
    return r.json() as Promise<any>;
  };
  try {
    const senders = await get("sender?Email=" + encodeURIComponent(recipient));
    if (
      !senders.Data?.some(
        (s: any) =>
          s.Email?.toLowerCase() === recipient.toLowerCase() &&
          s.Status === "Active",
      )
    ) {
      await record("sender_not_active");
      return;
    }
    await record("sender_active");
    if (stage === "inspect") {
      const receipts = await env.DB.prepare(
        "SELECT entity_id FROM audit WHERE user_id=? AND action IN ('account.mail.verify.accepted','account.mail.reset.accepted') ORDER BY created_at DESC LIMIT 4",
      )
        .bind(user.id)
        .all<{ entity_id: string }>();
      for (const receipt of receipts.results) {
        const id = /^mailjet:(\d+)$/.exec(receipt.entity_id)?.[1];
        if (!id) continue;
        const result = await get("message/" + id);
        const status = result.Data?.[0]?.Status;
        await record(
          "delivery." +
            ([
              "queued",
              "sent",
              "opened",
              "clicked",
              "bounce",
              "blocked",
              "spam",
              "deferred",
              "retrying",
            ].includes(status)
              ? status
              : "unknown"),
          receipt.entity_id,
        );
      }
    } else {
      // Only this owner-requested account operation gets the scoped enabled env.
      // The public Worker stays disabled until genuine delivery is demonstrated.
      const scoped = {
        ...env,
        MAIL_PROVIDER: "mailjet",
        MAIL_FREE_PLAN_CONFIRMED: "true",
        MAIL_SENDER_VERIFIED: "true",
        MAIL_DELIVERY_ENABLED: "true",
      };
      const request = new Request(
        env.APP_ORIGIN +
          "/api/auth/" +
          (stage === "verify" ? "resend-verification" : "forgot-password"),
        {
          method: "POST",
          headers: {
            Origin: env.APP_ORIGIN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: recipient }),
        },
      );
      const response =
        stage === "verify"
          ? await accountPrivate(request, scoped, user.id)
          : await accountPublic(request, scoped);
      await record("workflow_" + response?.status);
    }
  } catch (error) {
    const message =
      error instanceof Error && /^http_\d{3}$/.test(error.message)
        ? error.message
        : "unavailable";
    await record(message);
  }
}
export default {
  fetch: worker.fetch,
  async scheduled(event: ScheduledEvent, env: CertificationEnv) {
    await certify(env);
    await worker.scheduled(event, env);
  },
};
