import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { harness } from "./harness";
import { encrypt } from "../src/oauth";
import {
  runLiveJobs,
  queueFollowups,
  syncReplies,
  transportSnapshot,
} from "../src/automation";
import { runJobs } from "../src/index";
import { checkGmail } from "../src/live-controls";
let h: ReturnType<typeof harness>,
  owner: Awaited<ReturnType<ReturnType<typeof harness>["user"]>>,
  connection: string;
const recipient = "controlled@example.com";
const row = {
  name: "Campaign professor",
  email: recipient,
  university: "Synthetic University",
  interests: "Robotics",
  subject: "Exact campaign inquiry",
  body: "Exact initial content",
  scheduled_at: "2000-01-01T00:00:00Z",
  timezone: "Asia/Karachi",
  follow_up_days: "1",
  follow_up_subject: "Exact campaign inquiry",
  follow_up_body: "Exact preapproved conditional follow-up",
};
beforeEach(async () => {
  h = harness();
  owner = await h.user("owner@example.com");
  connection = crypto.randomUUID();
  Object.assign(h.env, {
    OAUTH_ENABLED: "true",
    LIVE_EMAIL_ENABLED: "true",
    MOCK_DELIVERY_ENABLED: "false",
    LIVE_OWNER_USER_IDS: owner.id,
    LIVE_TEST_RECIPIENTS: recipient + ",second@example.com",
    GMAIL_CLIENT_ID: "synthetic-client",
    GMAIL_CLIENT_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(9)),
    ),
  });
  const tokens = await encrypt(h.env, owner.id + ":gmail:tokens:v1", {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
  });
  h.db
    .prepare(
      "INSERT INTO connections(id,user_id,provider,address,subject,scopes,tokens,expires_at) VALUES(?,?,'gmail','sender@example.com','synthetic-google-subject',?,?,?)",
    )
    .run(
      connection,
      owner.id,
      "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
      tokens,
      Date.now() + 3600000,
    );
  h.db
    .prepare(
      "INSERT INTO mailbox_checks(connection_id,checked_at,status,detail) VALUES(?,?,'ready','Synthetic provider fixture')",
    )
    .run(connection, Date.now());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden");
    }),
  );
});
afterEach(() => {
  h.db.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function importRows(rows = [row]) {
  const r = await h.request("/imports/drafts", "POST", rows, owner.session);
  expect(r.status).toBe(200);
  return h.db.prepare("SELECT * FROM messages ORDER BY rowid").all() as any[];
}
async function approve(ids: string[], followups = false) {
  return h.request(
    "/messages/approve",
    "POST",
    { ids, sending_account_id: connection, authorize_followups: followups },
    owner.session,
  );
}
const send = () =>
  vi.fn(async () =>
    Response.json({ id: "gmail-accepted", threadId: "gmail-thread" }),
  );

function provider(reply = false, failedRead = false) {
  let submitted = 0;
  const network = vi.fn(async (url: string) => {
    if (url.includes("/messages/send")) {
      submitted++;
      return Response.json({
        id: "accepted-" + submitted,
        threadId: "gmail-thread",
      });
    }
    if (url.includes("/threads/"))
      return failedRead
        ? new Response(null, { status: 503 })
        : Response.json({
            messages: reply
              ? [
                  {
                    id: "inbound-reply",
                    internalDate: String(Date.now() - 1000),
                    snippet: "Thank you, received",
                    payload: { headers: [{ name: "From", value: recipient }] },
                  },
                ]
              : [],
          });
    throw new Error("Unexpected synthetic request");
  });
  return { network, submissions: () => submitted };
}
function advance(ms: number) {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  h.db.prepare("UPDATE connections SET expires_at=?").run(now + 35 * 86400000);
  h.db.prepare("UPDATE sessions SET expires_at=?").run(now + 35 * 86400000);
  vi.setSystemTime(now + ms);
}
async function approvedInitial() {
  const [draft] = await importRows();
  expect((await approve([draft.id], true)).status).toBe(200);
  const p = provider();
  await runLiveJobs(h.env, p.network as any);
  return { draft, p };
}
async function dueChild() {
  const result = await approvedInitial();
  advance(86400000 + 1000);
  await syncReplies(h.env, result.p.network as any, owner.id, result.draft.id);
  await queueFollowups(h.env);
  return result;
}
describe("one-time campaign lifecycle", () => {
  it("preserves combined approval of a manually composed exact follow-up", async () => {
    const [draft] = await importRows();
    const created = await h.request(
      "/messages",
      "POST",
      {
        professor_id: draft.professor_id,
        subject: "Composed inquiry",
        body: "Composed exact body",
        mode: "manual",
        authorized: false,
        scheduled_at: new Date().toISOString(),
        timezone: "Asia/Karachi",
        sending_account_id: connection,
        followup: {
          days: 2,
          subject: "Composed follow-up",
          body: "Exact composed follow-up",
          authorized: true,
        },
      },
      owner.session,
    );
    expect(created.status).toBe(200);
    const { id } = await created.json();
    const state = await (
      await h.request("/state", "GET", undefined, owner.session)
    ).json();
    expect(
      JSON.parse(
        state.messages.find((m: any) => m.id === id).followup_proposal,
      ),
    ).toMatchObject({ days: 2, subject: "Composed follow-up" });
    expect((await approve([id], true)).status).toBe(200);
    expect(
      h.db
        .prepare(
          "SELECT followup_authorized FROM message_authorizations WHERE message_id=?",
        )
        .get(id)!.followup_authorized,
    ).toBe(1);
  });

  it("cancels a fully approved campaign before its initial send without losing the authorization audit", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    expect(
      (
        await h.request(
          `/messages/${draft.id}/cancel`,
          "POST",
          {},
          owner.session,
        )
      ).status,
    ).toBe(200);
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    await queueFollowups(h.env);
    expect(p.submissions()).toBe(0);
    expect(
      h.db.prepare("SELECT generated FROM automation").get()!.generated,
    ).toBe(1);
    expect(
      h.db.prepare("SELECT count(*) n FROM message_authorizations").get()!.n,
    ).toBe(1);
  });
  it("uses Gmail's acceptance time when reconciling an uncertain initial delivery", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    const original = Date.now();
    await runLiveJobs(h.env, (async () => {
      throw new Error("uncertain response");
    }) as any);
    advance(2 * 86400000);
    const network = vi.fn(async (url: string) =>
      url.includes("messages?maxResults")
        ? Response.json({ messages: [{ id: "accepted-before-timeout" }] })
        : Response.json({
            id: "accepted-before-timeout",
            threadId: "original-thread",
            internalDate: String(original),
          }),
    );
    await runLiveJobs(h.env, network as any);
    expect(
      network.mock.calls.every(([url]) => !url.includes("/messages/send")),
    ).toBe(true);
    expect(
      h.db.prepare("SELECT sent_at FROM messages WHERE id=?").get(draft.id)!
        .sent_at,
    ).toBe(new Date(original).toISOString());
    expect(h.db.prepare("SELECT due_at FROM automation").get()!.due_at).toBe(
      original + 86400000,
    );
  });
  it("blocks submission if deletion races with a token refresh before the final sending fence", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    h.db.prepare("UPDATE connections SET expires_at=0").run();
    let sends = 0;
    const network = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com")) {
        expect(
          (
            await h.request(
              `/professors/${draft.professor_id}/delete`,
              "POST",
              { confirmed: true },
              owner.session,
            )
          ).status,
        ).toBe(200);
        return Response.json({
          access_token: "refreshed-synthetic",
          expires_in: 3600,
        });
      }
      sends++;
      throw new Error("Must not submit deleted recipient");
    });
    await runLiveJobs(h.env, network as any);
    expect(sends).toBe(0);
    expect(h.db.prepare("SELECT status FROM messages").get()!.status).toBe(
      "cancelled",
    );
    expect(h.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
  it("retains audit on professor removal but supports explicit account erasure without foreign-key corruption", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    const { passwordHash } = await import("../src/passwords");
    const password = "Maple river lantern planets 47";
    h.db
      .prepare("UPDATE users SET password=? WHERE id=?")
      .run(await passwordHash(password), owner.id);
    const other = await h.user("remaining-account@example.com");
    const response = await h.request(
      "/account/delete",
      "POST",
      { current_password: password, confirmation: "DELETE MY ACCOUNT" },
      owner.session,
    );
    expect(response.status).toBe(200);
    for (const table of [
      "message_authorizations",
      "campaign_approvals",
      "messages",
      "connections",
    ])
      expect(h.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(h.db.prepare("SELECT id FROM users").get()!.id).toBe(other.id);
    expect(h.db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("imports requested follow_up columns while preserving legacy compatibility", async () => {
    const [draft] = await importRows();
    expect(JSON.parse(draft.followup_proposal)).toEqual({
      days: 1,
      subject: row.follow_up_subject,
      body: row.follow_up_body,
    });
    expect(draft.approved).toBe(0);
    const legacy = {
      ...row,
      email: "second@example.com",
      follow_up_days: "",
      follow_up_subject: "",
      follow_up_body: "",
      followup_days: "3",
      followup_subject: "Legacy",
      followup_body: "Legacy exact body",
    };
    await importRows([legacy]);
    expect(h.db.prepare("SELECT count(*) n FROM messages").get()!.n).toBe(2);
  });
  it("marks incomplete follow-up content without authorizing it or inventing a body", async () => {
    const [draft] = await importRows([{ ...row, follow_up_body: "" }]);
    expect(draft.followup_proposal).toBeNull();
    expect(draft.followup_issue).toContain("Missing follow-up body");
    expect(JSON.parse(draft.followup_draft).body).toBe("");
    expect((await approve([draft.id], true)).status).toBe(400);
    expect((await approve([draft.id], false)).status).toBe(200);
    expect(
      h.db
        .prepare("SELECT followup_authorized FROM message_authorizations")
        .get()!.followup_authorized,
    ).toBe(0);
    expect(h.db.prepare("SELECT count(*) n FROM automation").get()!.n).toBe(0);
  });
  it("rejects conflicting alias values atomically", async () => {
    expect(
      (
        await h.request(
          "/imports/drafts",
          "POST",
          [{ ...row, followup_days: "2" }],
          owner.session,
        )
      ).status,
    ).toBe(400);
    expect(h.db.prepare("SELECT count(*) n FROM messages").get()!.n).toBe(0);
  });
  it("approves a complete 25-row campaign once within the D1 query budget", async () => {
    h.db
      .prepare(
        "INSERT INTO outreach_settings(user_id,production_enabled) VALUES(?,1)",
      )
      .run(owner.id);
    const drafts = await importRows(
      Array.from({ length: 25 }, (_, i) => ({
        ...row,
        email: `synthetic-${i}@example.com`,
      })),
    );
    const prepare = h.env.DB.prepare.bind(h.env.DB);
    let queries = 0;
    h.env.DB.prepare = ((sql: string) => {
      queries++;
      return prepare(sql);
    }) as typeof h.env.DB.prepare;
    const response = await approve(
      drafts.map((d) => d.id),
      true,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scheduled: 25,
      authorized_followups: 25,
      total_messages: 50,
    });
    expect(queries).toBeLessThan(50);
    expect(
      h.db.prepare("SELECT count(*) n FROM campaign_approvals").get()!.n,
    ).toBe(1);
    expect(
      h.db.prepare("SELECT count(*) n FROM message_authorizations").get()!.n,
    ).toBe(25);
    expect(h.db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(0);
  });
  it("does not expand approval to an unselected recipient or an initial-only follow-up", async () => {
    const drafts = await importRows([
      row,
      { ...row, email: "second@example.com" },
    ]);
    expect((await approve([drafts[0].id], false)).status).toBe(200);
    expect(
      h.db
        .prepare("SELECT approved FROM messages WHERE id=?")
        .get(drafts[1].id)!.approved,
    ).toBe(0);
    expect(() =>
      h.db
        .prepare(
          "INSERT INTO automation(message_id,days,subject,body) VALUES(?,1,'s','b')",
        )
        .run(drafts[0].id),
    ).toThrow(/authorized/);
    expect((await approve([drafts[0].id], true)).status).toBe(409);
  });
  it("stores immutable recipient/content/rule snapshots and blocks edits to approved messages", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    const auth = h.db.prepare("SELECT * FROM message_authorizations").get()!;
    const snapshot = JSON.parse(String(auth.snapshot));
    expect(snapshot.initial.recipient).toBe(recipient);
    expect(snapshot.followup).toEqual({
      days: 1,
      subject: row.follow_up_subject,
      body: row.follow_up_body,
    });
    expect(snapshot.maximum_followups).toBe(1);
    for (const sql of [
      "UPDATE messages SET subject='Changed'",
      "UPDATE messages SET scheduled_at='2099-01-01T00:00:00Z'",
      "UPDATE automation SET days=2",
      "UPDATE transports SET snapshot='{}'",
      "UPDATE message_authorizations SET snapshot='{}'",
      "UPDATE campaign_approvals SET followup_count=2",
    ])
      expect(() => h.db.exec(sql)).toThrow(/immutable/);
    expect(() => h.db.exec("DELETE FROM message_authorizations")).toThrow(
      /retained/,
    );
  });
  it("sends a preapproved one-day follow-up without another approval and creates only one child", async () => {
    const { draft, p } = await approvedInitial();
    const initial = h.db
      .prepare("SELECT sent_at FROM messages WHERE id=?")
      .get(draft.id)!;
    expect(h.db.prepare("SELECT due_at FROM automation").get()!.due_at).toBe(
      Date.parse(String(initial.sent_at)) + 86400000,
    );
    advance(23 * 3600000);
    await syncReplies(h.env, p.network as any, owner.id, draft.id);
    await queueFollowups(h.env);
    expect(
      h.db
        .prepare("SELECT count(*) n FROM messages WHERE parent_id IS NOT NULL")
        .get()!.n,
    ).toBe(0);
    advance(3600000 + 1000);
    await syncReplies(h.env, p.network as any, owner.id, draft.id);
    await Promise.all([queueFollowups(h.env), queueFollowups(h.env)]);
    expect(
      h.db
        .prepare("SELECT count(*) n FROM messages WHERE parent_id IS NOT NULL")
        .get()!.n,
    ).toBe(1);
    await runLiveJobs(h.env, p.network as any);
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(2);
    const child = h.db
      .prepare(
        "SELECT m.*,t.provider_id FROM messages m JOIN transports t ON t.message_id=m.id WHERE m.parent_id=?",
      )
      .get(draft.id)!;
    expect(child.status).toBe("sent");
    expect(child.provider_id).toBe("accepted-2");
    const auth = h.db
      .prepare(
        "SELECT kind,campaign_id FROM message_authorizations WHERE message_id=?",
      )
      .get(child.id)!;
    expect(auth.kind).toBe("followup");
    expect(auth.campaign_id).toBe(
      h.db
        .prepare(
          "SELECT campaign_id FROM message_authorizations WHERE message_id=?",
        )
        .get(draft.id)!.campaign_id,
    );
    const sends = p.network.mock.calls.filter(([url]) =>
      url.includes("/messages/send"),
    );
    const payload = JSON.parse((sends[1] as any)[1].body);
    expect(payload.threadId).toBe("gmail-thread");
    expect(Buffer.from(payload.raw, "base64url").toString()).toContain(
      "In-Reply-To:",
    );
  });
  it("permanently cancels an authorized follow-up on a detected reply", async () => {
    const { draft, p } = await approvedInitial();
    advance(3600000);
    const reply = provider(true);
    await syncReplies(h.env, reply.network as any, owner.id, draft.id);
    expect(
      h.db.prepare("SELECT generated,cancel_reason FROM automation").get(),
    ).toMatchObject({ generated: 1, cancel_reason: "reply" });
    expect(() => h.db.exec("UPDATE automation SET generated=0")).toThrow(
      /cannot be rearmed/,
    );
    advance(86400000);
    await queueFollowups(h.env);
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(1);
  });
  it("checks replies immediately before follow-up submission and cancels an already queued child", async () => {
    const { draft, p } = await dueChild();
    const replies = provider(true);
    await runLiveJobs(h.env, replies.network as any);
    expect(replies.submissions()).toBe(0);
    expect(p.submissions()).toBe(1);
    expect(
      h.db
        .prepare("SELECT status FROM messages WHERE parent_id=?")
        .get(draft.id)!.status,
    ).toBe("cancelled");
  });
  it("fails safely if the final reply verification is unavailable, then recovers without a duplicate", async () => {
    const { p } = await dueChild();
    const failed = provider(false, true);
    await runLiveJobs(h.env, failed.network as any);
    expect(failed.submissions()).toBe(0);
    expect(
      h.db
        .prepare("SELECT attempts FROM transports WHERE state='waiting'")
        .get()!.attempts,
    ).toBe(0);
    await runLiveJobs(h.env, p.network as any);
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(2);
  });
  it("records opt-out cancellation and prevents sends or retries to suppressed recipients", async () => {
    const { draft, p } = await dueChild();
    await h.request(
      "/suppressions",
      "POST",
      { address: recipient },
      owner.session,
    );
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(1);
    expect(
      h.db.prepare("SELECT cancel_reason FROM automation").get()!.cancel_reason,
    ).toBe("opt_out");
    expect(
      h.db
        .prepare("SELECT status FROM messages WHERE parent_id=?")
        .get(draft.id)!.status,
    ).toBe("cancelled");
  });
  it("cancels queued mail and follow-ups when a professor is permanently deleted, preserving receipts/audit", async () => {
    const { draft, p } = await dueChild();
    expect(
      (
        await h.request(
          `/professors/${draft.professor_id}/delete`,
          "POST",
          { confirmed: false },
          owner.session,
        )
      ).status,
    ).toBe(400);
    const response = await h.request(
      `/professors/${draft.professor_id}/delete`,
      "POST",
      { confirmed: true },
      owner.session,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recalls_delivered_mail: false,
    });
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(1);
    expect(h.db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(1);
    expect(
      h.db.prepare("SELECT count(*) n FROM message_authorizations").get()!.n,
    ).toBe(2);
    expect(
      h.db
        .prepare("SELECT status FROM messages WHERE parent_id=?")
        .get(draft.id)!.status,
    ).toBe("cancelled");
    expect(
      h.db.prepare("SELECT interests,name FROM professors").get(),
    ).toMatchObject({ interests: "", name: "Deleted professor" });
    expect(
      (
        await h.request(
          `/messages/${draft.id}/retry`,
          "POST",
          { confirmed: true },
          owner.session,
        )
      ).status,
    ).toBe(409);
  });
  it("never sends an unsent initial email after professor deletion", async () => {
    const [draft] = await importRows();
    await approve([draft.id], true);
    await h.request(
      `/professors/${draft.professor_id}/delete`,
      "POST",
      { confirmed: true },
      owner.session,
    );
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(0);
    expect((await approve([draft.id], true)).status).toBe(409);
  });
  it("archives and restores records without modifying approved content or provider evidence", async () => {
    const { draft } = await approvedInitial();
    for (const path of [
      `/professors/${draft.professor_id}/archive`,
      `/messages/${draft.id}/archive`,
    ])
      expect((await h.request(path, "POST", {}, owner.session)).status).toBe(
        200,
      );
    expect(
      h.db.prepare("SELECT archived_at FROM messages").get()!.archived_at,
    ).toBeTruthy();
    expect(h.db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(1);
    expect(
      (
        await h.request(
          `/messages/${draft.id}/restore`,
          "POST",
          {},
          owner.session,
        )
      ).status,
    ).toBe(200);
    expect(
      h.db.prepare("SELECT archived_at FROM messages").get()!.archived_at,
    ).toBeNull();
  });
  it("removes sent mail from the dashboard without recalling it or erasing sending/opt-out history", async () => {
    const { draft } = await approvedInitial();
    const response = await h.request(
      `/messages/${draft.id}/remove`,
      "POST",
      { confirmed: true },
      owner.session,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recalls_delivered_mail: false,
      retained_operational_audit: true,
    });
    expect(
      h.db
        .prepare("SELECT hidden_at,status FROM messages WHERE id=?")
        .get(draft.id),
    ).toMatchObject({ status: "sent" });
    expect(
      h.db.prepare("SELECT hidden_at FROM messages").get()!.hidden_at,
    ).toBeTruthy();
    expect(h.db.prepare("SELECT count(*) n FROM deliveries").get()!.n).toBe(1);
    expect(
      h.db.prepare("SELECT cancel_reason FROM automation").get()!.cancel_reason,
    ).toBe("dashboard_removed");
  });
  it("requires cancellation before removing unsent mail and never hides uncertain deliveries", async () => {
    const [draft] = await importRows();
    expect(
      (
        await h.request(
          `/messages/${draft.id}/remove`,
          "POST",
          { confirmed: true },
          owner.session,
        )
      ).status,
    ).toBe(409);
    await h.request(`/messages/${draft.id}/cancel`, "POST", {}, owner.session);
    expect(
      (
        await h.request(
          `/messages/${draft.id}/remove`,
          "POST",
          { confirmed: true },
          owner.session,
        )
      ).status,
    ).toBe(200);
  });
  it("isolates archive/delete actions and retains a coherent database on authorization storage failure", async () => {
    const [draft] = await importRows();
    const other = await h.user("other-campaign@example.com");
    expect(
      (
        await h.request(
          `/professors/${draft.professor_id}/delete`,
          "POST",
          { confirmed: true },
          other.session,
        )
      ).status,
    ).toBe(404);
    h.db.exec(
      "CREATE TRIGGER synthetic_authorization_failure BEFORE INSERT ON message_authorizations BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END;",
    );
    expect((await approve([draft.id], true)).status).toBe(500);
    for (const table of [
      "campaign_approvals",
      "message_authorizations",
      "automation",
      "transports",
    ])
      expect(h.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    expect(
      h.db.prepare("SELECT approved,status FROM messages").get(),
    ).toMatchObject({ approved: 0, status: "draft" });
    h.db.exec("DROP TRIGGER synthetic_authorization_failure");
    expect((await approve([draft.id], true)).status).toBe(200);
  });
});
