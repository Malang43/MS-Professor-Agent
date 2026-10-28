const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { build } = require("esbuild");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright-core",
);
(async () => {
  await build({
    define: {
      "import.meta.url": JSON.stringify(
        require("node:url").pathToFileURL(
          path.resolve("apps/api/tests/harness.ts"),
        ).href,
      ),
    },
    stdin: {
      contents:
        "export {harness} from './apps/api/tests/harness'; export {passwordHash} from './apps/api/src/passwords';export {default as worker} from './apps/api/src/index';export {encrypt} from './apps/api/src/oauth';export {runLiveJobs} from './apps/api/src/automation';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "apps/api/.wrangler/browser-account-harness.cjs",
  });
  const {
      harness,
      worker,
      encrypt,
      runLiveJobs,
    } = require("../apps/api/.wrangler/browser-account-harness.cjs"),
    h = harness();
  Object.assign(h.env, {
    MOCK_DELIVERY_ENABLED: "false",
    LIVE_EMAIL_ENABLED: "true",
    OAUTH_ENABLED: "true",
    LIVE_TEST_RECIPIENTS: "controlled@example.com,second@example.com",
    GMAIL_CLIENT_ID: "synthetic-client",
    GMAIL_CLIENT_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  });
  const root = path.resolve("apps/web/out");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      for (const rule of JSON.parse(
        fs.readFileSync("apps/web/vercel.json", "utf8"),
      ).headers) {
        if (
          rule.source === "/:path*" ||
          (rule.source === "/api/:path*" && url.pathname.startsWith("/api/"))
        )
          for (const header of rule.headers)
            res.setHeader(header.key, header.value);
      }
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const fixtureHeaders = { ...req.headers };
        if (fixtureHeaders.origin === base)
          fixtureHeaders.origin = h.env.APP_ORIGIN;
        const response = await worker.fetch(
          new Request(h.env.APP_ORIGIN + req.url, {
            method: req.method,
            headers: fixtureHeaders,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          }),
          h.env,
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      let target = path.resolve(root, "." + decodeURIComponent(url.pathname));
      if (!target.startsWith(root + path.sep) && target !== root) {
        res.writeHead(403).end();
        return;
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory())
        target = path.join(target, "index.html");
      if (!fs.existsSync(target)) {
        res.writeHead(404).end();
        return;
      }
      const ext = path.extname(target);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        }[ext] || "application/octet-stream",
      );
      res.end(fs.readFileSync(target));
    } catch {
      res.writeHead(500).end("Local QA error");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://localhost:" + server.address().port; // HTTPS Worker origin retained in this in-memory transport adapter only.
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.getByLabel("First name", { exact: true }).fill("Amira");
    await page.getByLabel("Last name", { exact: true }).fill("Khan");
    await page.getByLabel("Display name").fill("Amira Research");
    await page.getByLabel("Email address").fill("browser-qa@example.invalid");
    await page
      .locator("input[name=password]")
      .first()
      .fill("Maple river lantern planets 47");
    await page
      .locator("input[name=confirm_password]")
      .fill("Maple river lantern planets 47");
    await page.locator("input[name=accept_terms]").check();
    await page.screenshot({
      path: "apps/api/.wrangler/account-signup-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: "Sign in with password" }).waitFor();
    await page
      .locator("input[name=password]")
      .first()
      .fill("Maple river lantern planets 47");
    await page.getByRole("button", { name: "Sign in with password" }).click();
    await page
      .getByRole("heading", {
        name: "Your private research workspace",
        exact: true,
      })
      .waitFor();
    assert(
      await page.getByText("Email Not Verified", { exact: true }).isVisible(),
    );
    // This is an isolated in-memory fixture, never a public application bypass.
    const owner = h.db
      .prepare("SELECT id FROM users WHERE email=?")
      .get("browser-qa@example.invalid").id;
    h.env.LIVE_OWNER_USER_IDS = owner;
    const connection = require("node:crypto").randomUUID();
    const tokens = await encrypt(h.env, owner + ":gmail:tokens:v1", {
      access_token: "synthetic",
      refresh_token: "synthetic",
      expires_in: 3600,
    });
    h.db
      .prepare(
        "INSERT INTO connections(id,user_id,provider,address,subject,scopes,tokens,expires_at) VALUES(?,?,'gmail','synthetic-sender@example.com','synthetic-subject','https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',?,?)",
      )
      .run(connection, owner, tokens, Date.now() + 3600000);
    h.db
      .prepare(
        "INSERT INTO mailbox_checks(connection_id,checked_at,status,detail) VALUES(?,?,'ready','Synthetic provider fixture')",
      )
      .run(connection, Date.now());
    const verification = require("node:crypto")
      .randomBytes(32)
      .toString("base64url");
    h.db
      .prepare(
        "INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES(?,?,'verify',?)",
      )
      .run(
        require("node:crypto")
          .createHash("sha256")
          .update(verification)
          .digest("hex"),
        owner,
        Date.now() + 600000,
      );
    await page.goto(base + "/#verify=" + verification, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Verify my email" }).click();
    await page.getByText("Email verified. You can now sign in.").waitFor();
    assert.equal(new URL(page.url()).hash, "");
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    await page.getByRole("heading", { name: "Welcome back, Amira." }).waitFor();
    await page.screenshot({
      path: "apps/api/.wrangler/workspace-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Professors", exact: true }).click();
    await page
      .locator('input[accept=".csv,.xlsx"]')
      .setInputFiles("apps/web/public/professors-email-template.xlsx");

    await page
      .getByRole("button", { name: /Manual \/ Use Excel content/ })
      .click();
    await page
      .getByRole("button", { name: "Review entire campaign once", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "APPROVE & SCHEDULE COMPLETE CAMPAIGN",
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", {
        name: "Campaign approved & scheduled",
        exact: true,
      })
      .waitFor();
    assert.equal(
      h.db.prepare("SELECT count(*) n FROM campaign_approvals").get().n,
      1,
    );
    assert.equal(
      h.db
        .prepare("SELECT followup_authorized FROM message_authorizations")
        .get().followup_authorized,
      1,
    );
    assert.equal(h.db.prepare("SELECT days FROM automation").get().days, 3);
    assert.equal(h.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
    assert(
      await page
        .getByRole("button", { name: "Professors", exact: true })
        .isVisible(),
    );
    await page.screenshot({
      path: "apps/api/.wrangler/simplify-success-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Cancel future messages", exact: true })
      .click();
    await page
      .getByText(
        "Future messages cancelled. Previously delivered mail is retained.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      h.db.prepare("SELECT status FROM messages").get().status,
      "cancelled",
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const cancelled = h.db
      .prepare("SELECT * FROM messages ORDER BY rowid LIMIT 1")
      .get();
    const oldAuthorization = JSON.stringify(
      h.db
        .prepare("SELECT * FROM message_authorizations WHERE message_id=?")
        .get(cancelled.id),
    );
    await page
      .locator('input[accept=".csv,.xlsx"]')
      .setInputFiles("apps/web/public/professors-email-template.xlsx");
    await page
      .getByRole("button", { name: /Manual \/ Use Excel content/ })
      .click();
    await page
      .getByRole("button", { name: "Review entire campaign once", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "APPROVE & SCHEDULE COMPLETE CAMPAIGN",
        exact: true,
      })
      .click();
    await page
      .getByRole("heading", {
        name: "Campaign approved & scheduled",
        exact: true,
      })
      .waitFor();
    const repeated = h.db
      .prepare("SELECT * FROM messages ORDER BY rowid DESC LIMIT 1")
      .get();
    assert.notEqual(repeated.id, cancelled.id);
    assert.notEqual(repeated.campaign_import_id, cancelled.campaign_import_id);
    assert.equal(repeated.status, "pending");
    assert.deepEqual(
      h.db.prepare("SELECT * FROM messages WHERE id=?").get(cancelled.id),
      cancelled,
    );
    assert.equal(
      JSON.stringify(
        h.db
          .prepare("SELECT * FROM message_authorizations WHERE message_id=?")
          .get(cancelled.id),
      ),
      oldAuthorization,
    );
    assert.equal(
      h.db.prepare("SELECT count(*) n FROM campaign_approvals").get().n,
      2,
    );
    assert.equal(
      h.db
        .prepare(
          "SELECT count(*) n FROM message_authorizations WHERE followup_authorized=1",
        )
        .get().n,
      2,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const csv =
      "name,email,university,interests,subject,body,scheduled_at,timezone\nSecond Professor,second@example.com,Example U,Robotics,Exact individual subject,Exact individual body,2099-01-01T12:00:00Z,Asia/Karachi";
    await page.locator('input[accept=".csv,.xlsx"]').setInputFiles({
      name: "individual.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page
      .getByRole("button", { name: /Manual \/ Use Excel content/ })
      .click();
    await page
      .getByRole("button", { name: "Review emails individually", exact: true })
      .click();
    await page
      .getByLabel("Initial subject", { exact: true })
      .fill("Edited individual subject");
    await page
      .getByRole("button", {
        name: "Approve & schedule this recipient",
        exact: true,
      })
      .click();
    await page
      .getByText("Approved and scheduled. No further approval required.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      h.db
        .prepare(
          "SELECT count(*) n FROM messages WHERE subject='Edited individual subject' AND approved=1",
        )
        .get().n,
      1,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator('input[accept=".csv,.xlsx"]').setInputFiles({
      name: "ai.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        csv.replace("Exact individual subject", "AI preparation input"),
      ),
    });
    await page.getByRole("button", { name: /AI-assisted preparation/ }).click();
    await page
      .getByRole("button", { name: "Review emails individually", exact: true })
      .click();
    assert.match(
      await page.getByLabel("Initial subject", { exact: true }).inputValue(),
      /MS research inquiry/,
    );
    assert.equal(h.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "apps/api/.wrangler/simplify-mobile.png",
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Mobile viewport overflow",
    );
    assert.equal(errors.length, 0, "Browser runtime errors");
    console.log(
      "PASS browser: actual XLSX upload, Manual, complete review and one approval, cancellation then fresh identical workbook campaign with retained history, individual review, AI safe fallback, mobile layout and no real delivery.",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    h.db.close();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
