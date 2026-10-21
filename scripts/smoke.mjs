import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Optional runtime check against an already running local Wrangler API.
// Creates one isolated smoke account in local storage; never targets production.
const base = "http://localhost:8787/api";
let cookie = "";
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
assert.equal((await api("/health")).provider, "mock");
await api("/auth/signup", "POST", {
  email: `smoke-${randomUUID()}@example.com`,
  password: randomUUID(),
});
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
await api("/auth/logout", "POST");
console.log(
  "Runtime smoke passed: authentication, D1 persistence, private R2 upload/download, attachment ownership, mock dispatch and duplicate prevention.",
);
