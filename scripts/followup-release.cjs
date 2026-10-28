const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const directory = "apps/api/.wrangler";
const account = JSON.parse(
  fs.readFileSync(directory + "/live-release-baseline.json", "utf8"),
).account;
const login = fs.readFileSync(
  path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"),
  "utf8",
);
const token = /oauth_token\s*=\s*"([^"\r\n]+)"/.exec(login)?.[1];
assert(token, "Wrangler login required");
const base = "/accounts/" + account;
const worker = base + "/workers/scripts/ms-professor-outreach-api";
const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function api(route, init = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + route, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json();
  assert(
    response.ok && data.success,
    "Cloudflare request failed: " + response.status,
  );
  return data.result;
}
const query = (sql) =>
  api(base + "/d1/database/684cb48c-3f43-4cef-8217-cf9624d23522/query", {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
async function main() {
  const settings = await api(worker + "/settings");
  const schedules = await api(worker + "/schedules");
  const protectedRows = await query(
    "SELECT 'users' kind,id,password value FROM users UNION ALL SELECT 'documents',id,json_object('user_id',user_id,'key',object_key,'size',size,'state',storage_state) FROM documents UNION ALL SELECT 'connections',id,json_object('status',status,'tokens',tokens,'scopes',scopes) FROM connections UNION ALL SELECT 'approvals',message_id,snapshot FROM message_authorizations ORDER BY kind,id",
  );
  const state = {
    settings,
    schedules,
    protectedHash: digest(protectedRows[0].results),
  };
  if (process.argv[2] === "baseline") {
    fs.writeFileSync(
      directory + "/followup-baseline.json",
      JSON.stringify(state),
    );
    const config = JSON.parse(
      fs
        .readFileSync(directory + "/simplify-config.json", "utf8")
        .replace(/^\uFEFF/, ""),
    );
    config.vars = Object.fromEntries(
      settings.bindings
        .filter((binding) => binding.type === "plain_text")
        .map((binding) => [binding.name, binding.text]),
    );
    config.account_id = account;
    config.triggers = { crons: ["* * * * *"] };
    fs.writeFileSync(
      directory + "/followup-config.json",
      JSON.stringify(config, null, 2),
    );
    console.log(
      JSON.stringify({
        cron: schedules,
        live: config.vars.LIVE_EMAIL_ENABLED,
        mock: config.vars.MOCK_DELIVERY_ENABLED,
        mailProvider: config.vars.MAIL_PROVIDER,
        usageModel: settings.usage_model,
        modified_on: settings.modified_on,
      }),
    );
    console.log(
      "PASS captured deployed variables, binding metadata and protected-data hashes; no mailbox traffic.",
    );
  } else {
    const before = JSON.parse(
      fs.readFileSync(directory + "/followup-baseline.json", "utf8"),
    );
    const bindings = (value) =>
      value.bindings.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
    assert.deepEqual(
      bindings(settings),
      bindings(before.settings),
      "Production bindings changed",
    );
    assert.equal(
      state.protectedHash,
      before.protectedHash,
      "Protected production records changed",
    );
    assert(
      schedules.schedules?.some((schedule) => schedule.cron === "* * * * *") ||
        (Array.isArray(schedules) &&
          schedules.some((schedule) => schedule.cron === "* * * * *")),
      "Minute cron missing",
    );
    const health = await query(
      "SELECT * FROM scheduler_health; SELECT root_id,step,queued FROM followup_steps; SELECT message_id,generated,due_at,cancel_reason FROM automation WHERE message_id='893084fc-92e2-4acf-a33b-d52931700a11'",
    );
    console.log(
      JSON.stringify({
        schedules,
        health: health.map((result) => result.results),
      }),
    );
    console.log(
      "PASS production variables, secrets/bindings, protected records and historical authorizations preserved.",
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
