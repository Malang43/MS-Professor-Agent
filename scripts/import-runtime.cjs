const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require(
  require.resolve("miniflare", {
    paths: [require.resolve("wrangler/package.json")],
  }),
);
(async () => {
  const bundled = await build({
    entryPoints: ["apps/api/src/index.ts"],
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
      d1Databases: ["DB"],
      kvNamespaces: ["DOCUMENTS_KV"],
      bindings: {
        APP_ORIGIN: "https://synthetic.invalid",
        LIVE_EMAIL_ENABLED: "false",
        MOCK_DELIVERY_ENABLED: "false",
        OAUTH_ENABLED: "false",
      },
      outboundService: () => {
        throw Error("All outbound traffic forbidden");
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of fs
      .readdirSync("apps/api/migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(
        fs
          .readFileSync("apps/api/migrations/" + file, "utf8")
          .replace(/--[^\n]*/g, "")
          .replace(/\r?\n/g, " "),
      );
    const session = "synthetic-import-session";
    await db.batch([
      db.prepare(
        "INSERT INTO users(id,email,password,legacy_access) VALUES('import-qa','qa@example.invalid','synthetic',1)",
      ),
      db.prepare("INSERT INTO profiles(user_id) VALUES('import-qa')"),
      db
        .prepare(
          "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,'import-qa',?)",
        )
        .bind(
          crypto.createHash("sha256").update(session).digest("hex"),
          Date.now() + 600000,
        ),
    ]);
    const steps = Array.from({ length: 4 }, (_, i) => ({
      subject: "Conditional " + i,
      body: "Synthetic follow-up " + i,
      delay_value: 3,
      delay_unit: "days",
      relative_to: "previous",
    }));
    const rows = [1, 2].map((i) => ({
      name: "Synthetic " + i,
      email: `import-${i}@example.invalid`,
      subject: "Unsent initial",
      body: "Synthetic draft",
      scheduled_at: "2099-01-01T00:00:00Z",
      university: null,
      follow_up_sequence: JSON.stringify(steps),
    }));
    const import_id = crypto.randomUUID();
    const post = async (body) => {
      const r = await mf.dispatchFetch(
        "https://synthetic.invalid/api/imports/drafts",
        {
          method: "POST",
          headers: {
            Origin: "https://synthetic.invalid",
            Cookie: "session=" + session,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return { status: r.status, body: await r.json() };
    };
    let r = await post({ import_id, rows });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.body.created, 2);
    for (const d of r.body.drafts)
      assert.equal(JSON.parse(d.followup_proposal).steps.length, 4);
    const repeated = await Promise.all([
      post({ import_id, rows }),
      post({ import_id, rows }),
    ]);
    for (const r of repeated) {
      assert.equal(r.status, 200);
      assert.equal(r.body.created, 0);
    }
    assert.equal(
      (await post({ import_id, rows: [{ ...rows[0], body: "changed" }] }))
        .status,
      409,
    );
    await db.exec(
      "CREATE TRIGGER reject_import BEFORE INSERT ON messages WHEN NEW.approved_recipient='fail@example.invalid' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;",
    );
    assert.equal(
      (
        await post({
          import_id: crypto.randomUUID(),
          rows: [
            { ...rows[0], email: "rollback@example.invalid" },
            { ...rows[1], email: "fail@example.invalid" },
          ],
        })
      ).status,
      500,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM campaign_imports").first()).n,
      1,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM messages").first()).n,
      2,
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM professors WHERE email='rollback@example.invalid'",
          )
          .first()
      ).n,
      0,
    );
    for (const t of [
      "message_authorizations",
      "campaign_approvals",
      "followup_steps",
      "deliveries",
    ])
      assert.equal(
        (await db.prepare(`SELECT count(*) n FROM ${t}`).first()).n,
        0,
      );
    console.log(
      "PASS native Workers/D1: two recipients, four conditional follow-ups each, concurrent retries, changed-payload rejection, forced failure rollback, zero approvals and deliveries. All outbound network forbidden.",
    );
  } finally {
    await mf.dispose();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
