// Offline Workers-runtime regression. Every outbound request is intercepted locally.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve("miniflare", {
    paths: [require.resolve("wrangler/package.json")],
  }),
);
async function check(baseline, status) {
  const entry = `import {oauthTokenRequest} from './apps/api/src/providers';
    export default {async fetch(){try {
      await oauthTokenRequest('https://oauth2.googleapis.com/token', {
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:'synthetic',client_secret:'synthetic',code:'synthetic',code_verifier:'synthetic',grant_type:'authorization_code',redirect_uri:'https://app.example/api/oauth/gmail/callback'})
      }); return Response.json({ok:true});
    }catch(error){return Response.json({ok:false,kind:error.kind});}}};`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    plugins: baseline
      ? [
          {
            name: "historical-redirect-option",
            setup(build) {
              build.onLoad({ filter: /providers\.ts$/ }, (args) => ({
                contents: fs
                  .readFileSync(args.path, "utf8")
                  .replace('redirect: "manual"', 'redirect: "error"'),
                loader: "ts",
              }));
            },
          },
        ]
      : [],
  });
  let calls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate: "2026-10-01",
      outboundService: async (request) => {
        calls++;
        assert.equal(request.url, "https://oauth2.googleapis.com/token");
        assert.equal(request.method, "POST");
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("code_verifier"), "synthetic");
        assert.equal(
          form.get("redirect_uri"),
          "https://app.example/api/oauth/gmail/callback",
        );
        return status === 200
          ? Response.json({
              access_token: "synthetic",
              refresh_token: "synthetic",
              expires_in: 3600,
            })
          : new Response(null, {
              status,
              headers: { Location: "https://attacker.invalid/" },
            });
      },
    }),
  );
  try {
    const result = await (await mf.dispatchFetch("http://localhost/")).json();
    assert.equal(result.ok, !baseline && status === 200);
    assert.equal(calls, baseline ? 0 : 1);
    if (!baseline && status !== 200) assert.equal(result.kind, "rejected");
    console.log(
      `PASS ${baseline ? "historical error mode rejected before network" : status === 200 ? "fixed exchange succeeds with synthetic response" : "fixed redirect rejected without following"}; mock calls=${calls}`,
    );
  } finally {
    await mf.dispose();
  }
}
(async () => {
  process.chdir(path.resolve(__dirname, ".."));
  await check(true, 200);
  await check(false, 200);
  for (const status of [301, 302, 303, 307, 308]) await check(false, status);
})().catch(() => {
  console.error("Offline OAuth runtime regression failed.");
  process.exitCode = 1;
});
