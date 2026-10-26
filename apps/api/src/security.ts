import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import {
  type Env,
  HttpError,
  consume,
  hash,
  random,
  base64,
  unbase64,
} from "./runtime";
import { passwordHash, equalHash, validPassword } from "./passwords";
const hour = () => new Date().toISOString().slice(0, 13);
export async function reauthenticate(env: Env, user: string, password: string) {
  await consume(env, "security:reauth:" + user, 10, 1, hour());
  const row = await env.DB.prepare("SELECT password FROM users WHERE id=?")
    .bind(user)
    .first<any>();
  if (
    !row ||
    !equalHash(
      await passwordHash(password, row.password.split(":")[0]),
      row.password,
    )
  )
    throw new HttpError(401, "Reauthentication failed.");
}
const cookie = (req: Request, token: string, age = 604800) =>
  `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;
async function session(req: Request, env: Env, user: string) {
  const token = random();
  await env.DB.prepare(
    "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
  )
    .bind(await hash(token), user, Date.now() + 604800000)
    .run();
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": cookie(req, token) } },
  );
}
async function challenge(
  env: Env,
  purpose: string,
  value: string,
  user: string | null,
) {
  const id = random();
  await env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at<?")
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO auth_challenges(id,user_id,purpose,challenge,expires_at) VALUES(?,?,?,?,?)",
  )
    .bind(await hash(id), user, purpose, value, Date.now() + 300000)
    .run();
  return id;
}
async function take(
  env: Env,
  id: string,
  purpose: string,
  user: string | null,
) {
  const row = await env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id=? AND purpose=? AND user_id IS ? AND expires_at>? RETURNING challenge",
  )
    .bind(await hash(id), purpose, user, Date.now())
    .first<any>();
  if (!row)
    throw new HttpError(
      400,
      "Authentication challenge expired or was already used. Try again.",
    );
  return row.challenge as string;
}
export async function securityPublic(
  req: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (
    ![
      "/api/auth/recovery-code",
      "/api/auth/passkey/options",
      "/api/auth/passkey/verify",
    ].includes(path)
  )
    return null;
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  await consume(
    env,
    "security:public:ip:" +
      (await hash(req.headers.get("CF-Connecting-IP") || "local")),
    30,
    1,
    hour(),
  );
  await consume(env, "security:public:global", 500, 1, hour());
  const data = await req.json();
  if (path.endsWith("recovery-code")) {
    const input = z
      .object({
        email: z
          .string()
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        code: z.string().max(100),
        password: z.string().max(128),
        confirm_password: z.string(),
      })
      .parse(data);
    await consume(
      env,
      "security:recovery:address:" + (await hash(input.email)),
      10,
      1,
      hour(),
    );
    if (input.password !== input.confirm_password)
      throw new HttpError(400, "Passwords do not match.");
    validPassword(input.password, input.email);
    const password = await passwordHash(input.password),
      digest = await hash(input.code.replace(/[-\s]/g, "").toUpperCase());
    const lookup =
      "SELECT r.user_id FROM recovery_codes r JOIN users u ON u.id=r.user_id WHERE u.email=? AND r.code_hash=?";
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password=? WHERE id=(${lookup})`).bind(
        password,
        input.email,
        digest,
      ),
      ...["sessions", "oauth_states", "account_tokens", "auth_challenges"].map(
        (t) =>
          env.DB.prepare(`DELETE FROM ${t} WHERE user_id=(${lookup})`).bind(
            input.email,
            digest,
          ),
      ),
      env.DB.prepare(
        `DELETE FROM recovery_codes WHERE user_id=(${lookup}) AND code_hash=?`,
      ).bind(input.email, digest, digest),
    ]);
    if (!result[0].meta.changes)
      throw new HttpError(
        400,
        "Recovery failed. Check your account and unused recovery code.",
      );
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie(req, "", 0) } },
    );
  }
  const rpID = new URL(env.APP_ORIGIN).hostname;
  if (path.endsWith("options")) {
    const { recovery = false } = z
      .object({ recovery: z.boolean().optional() })
      .parse(data);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    });
    return Response.json({
      options,
      challenge_id: await challenge(
        env,
        recovery ? "recover" : "login",
        options.challenge,
        null,
      ),
    });
  }
  const input = z
    .object({
      challenge_id: z.string().max(128),
      response: z.any(),
      recovery: z.boolean().default(false),
      password: z.string().max(128).optional(),
      confirm_password: z.string().optional(),
    })
    .parse(data);
  const expectedChallenge = await take(
    env,
    input.challenge_id,
    input.recovery ? "recover" : "login",
    null,
  );
  const key = await env.DB.prepare("SELECT * FROM passkeys WHERE id=?")
    .bind(String(input.response?.id || "").slice(0, 2048))
    .first<any>();
  if (!key) throw new HttpError(401, "Passkey authentication failed.");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: key.id,
        publicKey: unbase64(key.public_key),
        counter: key.counter,
        transports: JSON.parse(key.transports),
      },
    });
  } catch {
    throw new HttpError(401, "Passkey authentication failed.");
  }
  if (!verification.verified)
    throw new HttpError(401, "Passkey authentication failed.");
  const updated = await env.DB.prepare(
    "UPDATE passkeys SET counter=? WHERE id=? AND counter=? RETURNING id",
  )
    .bind(verification.authenticationInfo.newCounter, key.id, key.counter)
    .first();
  if (!updated) throw new HttpError(401, "Passkey changed. Try again.");
  if (input.recovery) {
    if (!input.password || input.password !== input.confirm_password)
      throw new HttpError(400, "Passwords do not match.");
    validPassword(input.password);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password=? WHERE id=?").bind(
        await passwordHash(input.password),
        key.user_id,
      ),
      ...["sessions", "oauth_states", "account_tokens", "auth_challenges"].map(
        (t) =>
          env.DB.prepare(`DELETE FROM ${t} WHERE user_id=?`).bind(key.user_id),
      ),
    ]);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": cookie(req, "", 0) } },
    );
  }
  return session(req, env, key.user_id);
}
export async function securityPrivate(
  req: Request,
  env: Env,
  user: string,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/account/security")) return null;
  if (req.method === "GET" && path === "/api/account/security") {
    const keys = await env.DB.prepare(
      "SELECT id,name,created_at FROM passkeys WHERE user_id=?",
    )
      .bind(user)
      .all();
    const codes = await env.DB.prepare(
      "SELECT count(*) remaining FROM recovery_codes WHERE user_id=?",
    )
      .bind(user)
      .first();
    return Response.json({ passkeys: keys.results, ...codes });
  }
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const data = await req.json();
  if (path.endsWith("/passkey/verify")) {
    const input = z
      .object({
        challenge_id: z.string().max(128),
        response: z.any(),
        name: z.string().trim().min(1).max(80),
      })
      .parse(data);
    const expectedChallenge = await take(
      env,
      input.challenge_id,
      "register",
      user,
    );
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge,
        expectedOrigin: env.APP_ORIGIN,
        expectedRPID: new URL(env.APP_ORIGIN).hostname,
        requireUserVerification: true,
      });
    } catch {
      throw new HttpError(400, "Passkey registration failed.");
    }
    if (!result.verified || !result.registrationInfo)
      throw new HttpError(400, "Passkey registration failed.");
    const key = result.registrationInfo.credential;
    await env.DB.prepare(
      "INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        key.id,
        user,
        base64(key.publicKey),
        key.counter,
        JSON.stringify(key.transports || []),
        input.name,
        Date.now(),
      )
      .run();
    return Response.json({ ok: true });
  }
  const input = z
    .object({
      current_password: z.string().max(128),
      id: z.string().max(2048).optional(),
    })
    .parse(data);
  await reauthenticate(env, user, input.current_password);
  if (path.endsWith("/recovery-codes")) {
    const codes = Array.from({ length: 10 }, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, "0"),
      )
        .join("")
        .toUpperCase(),
    );
    const digests = await Promise.all(codes.map((v) => hash(v)));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recovery_codes WHERE user_id=?").bind(user),
      ...digests.map((v) =>
        env.DB.prepare(
          "INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)",
        ).bind(user, v, Date.now()),
      ),
    ]);
    return Response.json({
      codes: codes.map((v) => v.match(/.{4}/g)!.join("-")),
    });
  }
  if (path.endsWith("/passkey/remove")) {
    if (!input.id) throw new HttpError(400, "Choose a passkey.");
    await env.DB.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?")
      .bind(input.id, user)
      .run();
    return Response.json({ ok: true });
  }
  if (path.endsWith("/passkey/options")) {
    const keys = await env.DB.prepare(
      "SELECT id,transports FROM passkeys WHERE user_id=?",
    )
      .bind(user)
      .all<any>();
    if (keys.results.length >= 10)
      throw new HttpError(
        409,
        "Remove a passkey before adding another (maximum 10).",
      );
    const account = await env.DB.prepare("SELECT email FROM users WHERE id=?")
      .bind(user)
      .first<any>();
    const options = await generateRegistrationOptions({
      rpName: "MS Professor Agent",
      rpID: new URL(env.APP_ORIGIN).hostname,
      userID: Uint8Array.from(new TextEncoder().encode(user)),
      userName: account.email,
      attestationType: "none",
      excludeCredentials: keys.results.map((k) => ({
        id: k.id,
        transports: JSON.parse(k.transports),
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    return Response.json({
      options,
      challenge_id: await challenge(env, "register", options.challenge, user),
    });
  }
  throw new HttpError(404, "Not found");
}
