const assert = require("node:assert/strict"),
  { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve("miniflare", {
    paths: [require.resolve("wrangler/package.json")],
  }),
);
(async () => {
  const { encodeCBOR } = await import("@levischuck/tiny-cbor");
  const origin = "https://ms-professor-agent-malang43.vercel.app",
    rpID = new URL(origin).hostname,
    challenge = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64url");
  const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
    pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = Buffer.from(
    encodeCBOR(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(pub.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(pub.y, "base64url"))],
      ]),
    ),
  );
  const rpHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", Buffer.from(rpID)),
    ),
    id = crypto.getRandomValues(new Uint8Array(32));
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge, origin }),
  ).toString("base64url");
  const authData = Buffer.concat([
    rpHash,
    Buffer.from([69, 0, 0, 0, 0]),
    Buffer.alloc(16),
    Buffer.from([0, 32]),
    id,
    cose,
  ]);
  const attestationObject = Buffer.from(
    encodeCBOR(
      new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]),
    ),
  ).toString("base64url");
  const response = {
    id: Buffer.from(id).toString("base64url"),
    rawId: Buffer.from(id).toString("base64url"),
    type: "public-key",
    response: { clientDataJSON, attestationObject, transports: ["internal"] },
    clientExtensionResults: {},
  };
  const authClient = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin }),
    ),
    data = Buffer.concat([rpHash, Buffer.from([5, 0, 0, 0, 1])]);
  const raw = Buffer.from(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      Buffer.concat([
        data,
        Buffer.from(await crypto.subtle.digest("SHA-256", authClient)),
      ]),
    ),
  );
  function integer(v) {
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 128) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([2, v.length]), v]);
  }
  const der = Buffer.concat([
    integer(raw.subarray(0, 32)),
    integer(raw.subarray(32)),
  ]);
  const assertion = {
    id: response.id,
    rawId: response.id,
    type: "public-key",
    response: {
      clientDataJSON: authClient.toString("base64url"),
      authenticatorData: data.toString("base64url"),
      signature: Buffer.concat([Buffer.from([48, der.length]), der]).toString(
        "base64url",
      ),
    },
    clientExtensionResults: {},
  };
  const bundled = await build({
    stdin: {
      contents: `import {generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} from '@simplewebauthn/server'; import {verifyTurnstile} from './apps/api/src/turnstile';export default {async fetch(req){const v=await req.json();const options=await generateAuthenticationOptions({rpID:v.rpID,userVerification:'required'});const registration=await verifyRegistrationResponse({response:v.response,expectedChallenge:v.challenge,expectedOrigin:v.origin,expectedRPID:v.rpID,requireUserVerification:true});const authentication=await verifyAuthenticationResponse({response:v.assertion,expectedChallenge:v.challenge,expectedOrigin:v.origin,expectedRPID:v.rpID,requireUserVerification:true,credential:registration.registrationInfo.credential});let consumed=false;await verifyTurnstile(new Request(v.origin),{APP_ORIGIN:v.origin,TURNSTILE_ENABLED:'true',TURNSTILE_SITE_KEY:'test',TURNSTILE_SECRET_KEY:'synthetic',DB:{prepare(){return {bind(){return {first:async()=>{consumed=true;return {amount:1}}}}}}}},'synthetic-token');return Response.json({registration:registration.verified,authentication:authentication.verified,uv:options.userVerification,turnstile:consumed});}}`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      outboundService: async (req) => {
        assert.equal(
          req.url,
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        );
        return Response.json({
          success: true,
          hostname: rpID,
          action: "signup",
          challenge_ts: new Date().toISOString(),
        });
      },
    }),
  );
  try {
    const r = await mf.dispatchFetch("http://localhost/runtime", {
      method: "POST",
      body: JSON.stringify({ response, assertion, challenge, origin, rpID }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), {
      registration: true,
      authentication: true,
      uv: "required",
      turnstile: true,
    });
    console.log(
      "PASS native Workers runtime: signed WebAuthn registration/authentication and intercepted Turnstile Siteverify.",
    );
  } finally {
    await mf.dispose();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
