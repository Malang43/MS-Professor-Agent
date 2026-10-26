import { type Env, HttpError, consume, hash } from "./runtime";
export function turnstileConfigured(env: Env) {
  return !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY;
}
export function turnstileReady(env: Env) {
  return env.TURNSTILE_ENABLED === "true" && turnstileConfigured(env);
}
export async function verifyTurnstile(
  req: Request,
  env: Env,
  token: unknown,
  network: typeof fetch = fetch,
) {
  // During rollout, verify genuine widget responses without requiring a token yet.
  if (env.TURNSTILE_ENABLED !== "true" && !token) return;
  if (!turnstileConfigured(env))
    throw new HttpError(
      503,
      "Signup protection is temporarily unavailable. Try again later.",
    );
  if (typeof token !== "string" || !token || token.length > 2048)
    throw new HttpError(400, "Complete the bot protection check.");
  let result: any;
  try {
    const response = await network(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY!,
          response: token,
          remoteip: req.headers.get("CF-Connecting-IP") || "",
        }),
      },
    );
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new HttpError(
      503,
      "Bot protection is temporarily unavailable. Try again.",
    );
  }
  const age = Date.now() - Date.parse(result.challenge_ts);
  if (
    !result.success ||
    result.hostname !== new URL(env.APP_ORIGIN).hostname ||
    result.action !== "signup" ||
    !Number.isFinite(age) ||
    age < -30000 ||
    age > 300000
  )
    throw new HttpError(
      400,
      "Bot protection expired or failed. Please try again.",
    );
  // Siteverify also enforces single use. D1 adds a local concurrent-replay fence.
  await consume(env, "turnstile:" + (await hash(token)), 1);
}
