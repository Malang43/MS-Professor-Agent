import { z } from "zod";
import { type Env, random, hash, consume } from "./runtime";
const address = z.string().email().max(254);
export function mailReady(env: Env) {
  return (
    env.MAIL_DELIVERY_ENABLED === "true" &&
    env.MAIL_FREE_PLAN_CONFIRMED === "true" &&
    env.MAIL_SENDER_VERIFIED === "true" &&
    ((env.MAIL_PROVIDER === "brevo" && !!env.BREVO_API_KEY) ||
      (env.MAIL_PROVIDER === "mailjet" &&
        !!env.MAILJET_API_KEY &&
        !!env.MAILJET_SECRET_KEY)) &&
    address.safeParse(env.MAIL_FROM).success
  );
}
function origin(env: Env) {
  const url = new URL(env.APP_ORIGIN);
  if (url.protocol !== "https:" || url.origin !== env.APP_ORIGIN)
    throw new Error("Invalid mail origin");
  return url.origin;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function accountEmail(
  kind: "verify" | "reset" | "changed",
  link: string,
) {
  const title =
    kind === "verify"
      ? "Verify your email address"
      : kind === "reset"
        ? "Reset your password"
        : "Your password was reset";
  const action =
    kind === "verify"
      ? "Verify email"
      : kind === "reset"
        ? "Reset password"
        : "Open account security";
  const description =
    kind === "verify"
      ? "Confirm your email address to open your private research workspace."
      : kind === "reset"
        ? "Choose a new password for your MS Professor Agent account."
        : "Your password was successfully reset. Existing sessions have been signed out. If this was not you, reset your password immediately and contact the operator.";
  const expiry =
    kind === "changed"
      ? "This notification contains no password or recovery token."
      : `This single-use link expires in ${kind === "verify" ? "24 hours" : "30 minutes"}. If you did not request it, you can ignore this email.`;
  return {
    subject: `${title} | MS Professor Agent`,
    textContent: `MS Professor Agent\n\n${title}\n${description}\n\n${action}:\n${link}\n\n${expiry}\nNever share your password or this link.`,
    htmlContent: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f1f5f9;color:#172033;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:40px 16px"><table role="presentation" width="100%" style="max-width:560px;margin:auto;background:white;border:1px solid #dbe3ed;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="padding:32px"><p style="color:#3155ba;font-weight:bold;letter-spacing:1px">MS PROFESSOR AGENT</p><h1 style="font-size:26px">${title}</h1><p style="line-height:1.7">${description}</p><p style="padding:18px 0"><a href="${escape(link)}" style="background:#3155ba;color:white;display:inline-block;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${action}</a></p><p style="line-height:1.7">${expiry}</p><p style="font-size:13px;color:#526179">If the button does not work, copy this link into your browser:</p><p style="font-size:13px;word-break:break-all"><a href="${escape(link)}">${escape(link)}</a></p><hr style="border:0;border-top:1px solid #e2e8f0"><p style="font-size:12px;color:#526179">Your private academic workspace. Never share your password or account links.</p></td></tr></table></td></tr></table></body></html>`,
  };
}
async function deliver(
  env: Env,
  user: { email: string },
  kind: "verify" | "reset" | "changed",
  link: string,
  network: typeof fetch,
) {
  const email = accountEmail(kind, link);
  const mailjet = env.MAIL_PROVIDER === "mailjet";
  const response = await network(
    mailjet
      ? "https://api.mailjet.com/v3.1/send"
      : "https://api.brevo.com/v3/smtp/email",
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: mailjet
        ? {
            Authorization:
              "Basic " +
              btoa(env.MAILJET_API_KEY + ":" + env.MAILJET_SECRET_KEY),
            "Content-Type": "application/json",
          }
        : { "api-key": env.BREVO_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify(
        mailjet
          ? {
              Messages: [
                {
                  From: { Email: env.MAIL_FROM, Name: "MS Professor Agent" },
                  To: [{ Email: user.email }],
                  Subject: email.subject,
                  TextPart: email.textContent,
                  HTMLPart: email.htmlContent,
                  TrackOpens: "disabled",
                  TrackClicks: "disabled",
                },
              ],
            }
          : {
              sender: { email: env.MAIL_FROM, name: "MS Professor Agent" },
              to: [{ email: user.email }],
              ...email,
              tags: ["account-" + kind],
            },
      ),
    },
  );
  // 5xx can follow acceptance: do not discard a possibly delivered token.
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new Error("Ambiguous account delivery");
  }
  let accepted = response.status === (mailjet ? 200 : 201),
    providerId = "",
    failureCode = "http_" + response.status;
  if (accepted && mailjet) {
    const raw = await response.text();
    const result = JSON.parse(raw);
    const message = result.Messages?.[0];
    if (
      !Array.isArray(result.Messages) ||
      result.Messages.length !== 1 ||
      !["success", "error"].includes(message?.Status)
    )
      throw new Error("Ambiguous account delivery");
    accepted = message.Status === "success";
    if (
      !accepted &&
      /^[a-z0-9_-]{1,50}$/i.test(message.Errors?.[0]?.ErrorCode || "")
    )
      failureCode = message.Errors[0].ErrorCode;
    if (accepted) {
      // Mailjet IDs can exceed Number.MAX_SAFE_INTEGER: retain the exact digits.
      providerId = /"MessageID"\s*:\s*"?(\d+)"?/.exec(raw)?.[1] || "";
      if (message.To?.length !== 1 || !providerId || !message.To[0].MessageUUID)
        throw new Error("Ambiguous account delivery");
    }
  } else await response.body?.cancel();
  if (!accepted) console.warn("account_mail_failure", "provider_rejected");
  return { accepted, providerId, failureCode };
}

export async function sendAccountLink(
  env: Env,
  user: { id: string; email: string },
  purpose: "verify" | "reset",
  network: typeof fetch = fetch,
) {
  if (!mailReady(env)) return;
  try {
    const canonical = origin(env);
    // Shared across account mail types; Mailjet Free has a 200/day cap.
    await consume(
      env,
      "account:mail:global",
      env.MAIL_PROVIDER === "mailjet" ? 180 : 250,
    );
    const token = random(),
      digest = await hash(token),
      expires = Date.now() + (purpose === "verify" ? 86400000 : 1800000);
    await env.DB.prepare(
      "INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES(?,?,?,?)",
    )
      .bind(digest, user.id, purpose, expires)
      .run();
    const receipt = await deliver(
      env,
      user,
      purpose,
      canonical + "/#" + purpose + "=" + encodeURIComponent(token),
      network,
    );
    // A definite rejection cannot deliver a useful link. Ambiguous network errors
    // retain the expiring token in case the provider accepted before disconnect.
    if (!receipt.accepted)
      await env.DB.prepare("DELETE FROM account_tokens WHERE token_hash=?")
        .bind(digest)
        .run();
    if (env.MAIL_PROVIDER === "mailjet")
      await env.DB.prepare(
        "INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          user.id,
          "account.mail." +
            purpose +
            (receipt.accepted ? ".accepted" : ".rejected"),
          "mailjet:" +
            (receipt.accepted ? receipt.providerId : receipt.failureCode),
        )
        .run();
  } catch {
    console.warn("account_mail_failure", "transport_or_setup");
  }
}
export async function sendPasswordChanged(
  env: Env,
  user: { email: string },
  network: typeof fetch = fetch,
) {
  if (!mailReady(env)) return;
  try {
    const canonical = origin(env);
    await consume(
      env,
      "account:mail:global",
      env.MAIL_PROVIDER === "mailjet" ? 180 : 250,
    );
    await deliver(env, user, "changed", canonical, network);
  } catch {
    console.warn("account_mail_failure", "transport_or_setup");
  }
}
