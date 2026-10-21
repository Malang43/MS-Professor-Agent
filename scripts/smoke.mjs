import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Optional runtime check against an already running local Wrangler API.
// Creates one isolated smoke account in local storage; never targets production.
const base = process.env.SMOKE_API_URL || "http://localhost:8787/api";
const smokeUrl = new URL(base);
if (
  smokeUrl.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(smokeUrl.hostname) ||
  smokeUrl.pathname !== "/api" ||
  smokeUrl.username ||
  smokeUrl.password ||
  smokeUrl.search ||
  smokeUrl.hash
)
  throw new Error("Smoke checks must target a local /api endpoint only.");
const persist = process.env.SMOKE_D1_PERSIST_PATH;
if (!persist)
  throw new Error(
    "Set SMOKE_D1_PERSIST_PATH to the same isolated local Wrangler state directory used by the API.",
  );
let cookie = "";
async function verifiedLocalSignup() {
  const email = "smoke-" + randomUUID() + "@example.invalid",
    password = randomUUID();
  await api("/auth/signup", "POST", {
    email,
    password,
    confirm_password: password,
    first_name: "Local",
    last_name: "Smoke",
    accept_terms: true,
  });
  // Explicit local fixture only: there is no production verification bypass endpoint.
  execFileSync(
    process.execPath,
    [
      "../../node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "outreach",
      "--env",
      "local",
      "--local",
      "--persist-to",
      resolve(persist),
      "--command",
      "UPDATE users SET email_verified_at=" +
        Date.now() +
        " WHERE email='" +
        email +
        "'",
    ],
    { cwd: resolve("apps/api"), stdio: "pipe" },
  );
  await api("/auth/login", "POST", { email, password });
}
async function api(path, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: "http://localhost:3000",
      Cookie: cookie,
      ...(body && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.has("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
const health = await api("/health");
assert.equal(health.provider, "mock");
assert.equal(
  health.live_email,
  false,
  "Smoke checks require real sending disabled",
);
await verifiedLocalSignup();
await api("/professors", "POST", [
  { name: "Runtime Smoke Professor", email: "prof@example.edu" },
]);
const professor = (await api("/state")).professors[0];
const form = new FormData();
form.set(
  "file",
  new File(["private runtime smoke CV"], "cv.txt", { type: "text/plain" }),
);
const doc = await api("/documents", "POST", form);
const download = await fetch(base + "/documents/" + doc.id, {
  headers: { Cookie: cookie },
});
assert.equal(await download.text(), "private runtime smoke CV");
await api("/messages", "POST", {
  professor_id: professor.id,
  subject: "Mock runtime test",
  body: "No real email.",
  mode: "auto",
  authorized: true,
  scheduled_at: "2020-01-01T00:00:00.000Z",
  timezone: "Asia/Karachi",
  attachments: [doc.id],
});
await api("/jobs/run", "POST");
await api("/jobs/run", "POST");
const state = await api("/state");
assert.equal(state.messages[0].status, "sent");
assert.equal(state.audit.filter((a) => a.action === "mock.sent").length, 1);
const ownerCookie = cookie;
await verifiedLocalSignup();
assert.equal((await api("/state")).documents.length, 0);
assert.equal(
  (await fetch(base + "/documents/" + doc.id, { headers: { Cookie: cookie } }))
    .status,
  404,
);
await api("/auth/logout", "POST");
cookie = ownerCookie;
await api("/documents/" + doc.id + "/delete", "POST");
assert.equal(
  (await fetch(base + "/documents/" + doc.id, { headers: { Cookie: cookie } }))
    .status,
  404,
);
await api("/auth/logout", "POST");
assert.equal(
  (await fetch(base + "/state", { headers: { Cookie: ownerCookie } })).status,
  401,
);
console.log(
  "Runtime smoke passed: authentication, D1 persistence, private KV upload/download/deletion, user isolation, session revocation, mock dispatch and duplicate prevention.",
);
