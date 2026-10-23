// Native Workers/D1 regression. Every provider HTTP request is intercepted.
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve("miniflare", {
    paths: [require.resolve("wrangler/package.json")],
  }),
);
(async () => {
  const bundled = await build({
    stdin: {
      contents: `import {sendAccountLink} from './apps/api/src/account-mail';export default {async fetch(_req,env){await sendAccountLink(env,{id:'synthetic-owner',email:'owner@example.invalid'},'verify');const token=await env.DB.prepare('SELECT count(*) n FROM account_tokens').first();const receipt=await env.DB.prepare('SELECT entity_id FROM audit').first();return Response.json({tokens:token.n,providerId:receipt.entity_id});}}`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  let calls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings: {
        APP_ORIGIN: "https://synthetic.vercel.app",
        MAIL_PROVIDER: "mailjet",
        MAIL_DELIVERY_ENABLED: "true",
        MAIL_FREE_PLAN_CONFIRMED: "true",
        MAIL_SENDER_VERIFIED: "true",
        MAIL_FROM: "sender@example.invalid",
        MAILJET_API_KEY: "synthetic-public",
        MAILJET_SECRET_KEY: "synthetic-private",
      },
      outboundService: async (req) => {
        calls++;
        assert.equal(req.url, "https://api.mailjet.com/v3.1/send");
        assert.equal(
          req.headers.get("Authorization"),
          "Basic " +
            Buffer.from("synthetic-public:synthetic-private").toString(
              "base64",
            ),
        );
        const m = (await req.json()).Messages[0];
        assert.equal(m.To[0].Email, "owner@example.invalid");
        assert.equal(m.From.Name, "MS Professor Agent");
        assert.match(m.TextPart, /https:\/\/synthetic.vercel.app\/#verify=/);
        assert.equal(m.TrackClicks, "disabled");
        assert.match(m.HTMLPart, /Verify email/);
        return new Response(
          '{"Messages":[{"Status":"success","To":[{"MessageID":1234567890123456789,"MessageUUID":"synthetic"}]}]}',
          { status: 200 },
        );
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    await db.exec(
      "CREATE TABLE account_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT,purpose TEXT,expires_at INTEGER); CREATE TABLE usage_counters(scope TEXT,period TEXT,amount INTEGER,PRIMARY KEY(scope,period)); CREATE TABLE audit(id TEXT PRIMARY KEY,user_id TEXT,action TEXT,entity_id TEXT);",
    );
    const r = await mf.dispatchFetch("http://localhost/mailjet-runtime");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      tokens: 1,
      providerId: "mailjet:1234567890123456789",
    });
    assert.equal(calls, 1);
    console.log(
      "PASS native Workers/D1 Mailjet Basic authentication, branded link delivery and exact provider receipt; all outbound traffic intercepted.",
    );
  } finally {
    await mf.dispose();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
