import { beforeEach, afterEach, it, expect } from "vitest";
import { harness } from "./harness";
let h: ReturnType<typeof harness>, u: any;
const row = {
  name: "Fresh professor",
  email: "reused@example.com",
  subject: "New inquiry",
  body: "  Exact content\n\n",
  scheduled_at: "2099-01-01T12:00:00Z",
  timezone: "Asia/Karachi",
  follow_up_days: "3",
  follow_up_subject: "Exact follow-up",
  follow_up_body: "  Follow-up\n",
};
beforeEach(async () => {
  h = harness();
  u = await h.user("reimport-owner@example.com");
});
afterEach(() => h.db.close());
async function upload() {
  const r = await h.request("/imports/drafts", "POST", [row], u.session);
  expect(r.status).toBe(200);
  return (await r.json()) as any;
}
async function remove(id: string) {
  expect(
    (
      await h.request(
        `/professors/${id}/delete`,
        "POST",
        { confirmed: true },
        u.session,
      )
    ).status,
  ).toBe(200);
}
it("reimports deleted email as a fresh active record without reviving old drafts or authorization", async () => {
  const first = await upload(),
    old = first.drafts[0];
  await remove(old.professor_id);
  const next = await upload();
  expect(next.created).toBe(1);
  expect(next.reimported).toEqual([row.email]);
  expect(next.drafts[0].professor_id).not.toBe(old.professor_id);
  expect(
    h.db
      .prepare("SELECT deleted_at,deleted_email FROM professors WHERE id=?")
      .get(old.professor_id),
  ).toMatchObject({ deleted_email: row.email });
  expect(
    h.db.prepare("SELECT status,approved FROM messages WHERE id=?").get(old.id),
  ).toMatchObject({ status: "cancelled", approved: 0 });
  expect(h.db.prepare("SELECT count(*) n FROM suppressions").get()!.n).toBe(0);
  expect(
    h.db.prepare("SELECT count(*) n FROM message_authorizations").get()!.n,
  ).toBe(0);
  expect((await upload()).created).toBe(0);
  expect(
    h.db
      .prepare("SELECT count(*) n FROM professors WHERE deleted_at IS NULL")
      .get()!.n,
  ).toBe(1);
});
it.each(["manual opt-out", "decline", "opt_out", "account block"])(
  "preserves explicit %s protection across reimport",
  async (reason) => {
    const first = await upload();
    await remove(first.drafts[0].professor_id);
    h.db
      .prepare(
        "INSERT OR IGNORE INTO suppressions(user_id,address,reason) VALUES(?,?,?)",
      )
      .run(u.id, row.email, reason);
    await upload();
    expect(
      h.db
        .prepare(
          "SELECT reason FROM suppressions WHERE user_id=? AND address=?",
        )
        .get(u.id, row.email)!.reason,
    ).toBe(reason);
  },
);
it("professor-only reimport is atomic, deduplicated and isolated", async () => {
  const first = await upload();
  await remove(first.drafts[0].professor_id);
  const other = await h.user("other-reimport@example.com");
  const r = await h.request(
    "/professors",
    "POST",
    [
      { name: row.name, email: row.email },
      { name: row.name, email: row.email },
    ],
    u.session,
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ imported: 1 });
  expect(
    h.db
      .prepare(
        "SELECT count(*) n FROM professors WHERE user_id=? AND deleted_at IS NULL",
      )
      .get(other.id)!.n,
  ).toBe(0);
});
it("rolls back tombstone release and suppression removal if fresh import fails", async () => {
  const first = await upload();
  await remove(first.drafts[0].professor_id);
  h.db.exec(
    "CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'storage failure'); END",
  );
  expect(
    (await h.request("/imports/drafts", "POST", [row], u.session)).status,
  ).toBe(500);
  expect(
    h.db.prepare("SELECT email,deleted_email FROM professors").get(),
  ).toMatchObject({ email: row.email, deleted_email: null });
  expect(h.db.prepare("SELECT reason FROM suppressions").get()!.reason).toBe(
    "professor_deleted",
  );
});
it("preserves exact spreadsheet whitespace and permits editing only private unapproved drafts", async () => {
  const result = await upload(),
    d = result.drafts[0];
  expect(d.body).toBe(row.body);
  expect(JSON.parse(d.followup_proposal).body).toBe(row.follow_up_body);
  const other = await h.user("other-editor@example.com");
  expect(
    (
      await h.request(
        `/messages/${d.id}`,
        "PUT",
        { subject: "Edited", body: "Reviewed" },
        other.session,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await h.request(
        `/messages/${d.id}`,
        "PUT",
        { subject: "Edited", body: "Reviewed" },
        u.session,
      )
    ).status,
  ).toBe(200);
  expect(
    h.db.prepare("SELECT subject,body FROM messages WHERE id=?").get(d.id),
  ).toMatchObject({ subject: "Edited", body: "Reviewed" });
  await h.request(`/messages/${d.id}/cancel`, "POST", {}, u.session);
  expect(
    (
      await h.request(
        `/messages/${d.id}`,
        "PUT",
        { subject: "Replay", body: "No" },
        u.session,
      )
    ).status,
  ).toBe(409);
});
it("disabled transactional delivery neither sends nor marks an account verified", async () => {
  h.env.MAIL_PROVIDER = "disabled";
  h.env.MAIL_DELIVERY_ENABLED = "false";
  const r = await h.request("/auth/resend-verification", "POST", {}, u.session);
  expect(await r.json()).toMatchObject({ available: false });
  expect(h.db.prepare("SELECT count(*) n FROM account_tokens").get()!.n).toBe(
    0,
  );
});
it("retains historical recipient decline evidence from before suppression precedence existed", async () => {
  const first = await upload(),
    d = first.drafts[0];
  await remove(d.professor_id);
  h.db
    .prepare("INSERT INTO audit(id,user_id,action,entity_id) VALUES(?,?,?,?)")
    .run(crypto.randomUUID(), u.id, "recipient.decline", d.id);
  await upload();
  expect(
    h.db
      .prepare(
        "SELECT count(*) n FROM suppressions WHERE user_id=? AND address=?",
      )
      .get(u.id, row.email)!.n,
  ).toBe(1);
});
