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
import { queueSequence } from "../src/followup-sequence";
let h: ReturnType<typeof harness>,
  owner: Awaited<ReturnType<ReturnType<typeof harness>["user"]>>,
  connection: string;
const recipient = "controlled@example.com";
const sequenceRow = (steps: unknown[]) => ({
  ...row,
  follow_up_days: "",
  follow_up_subject: "",
  follow_up_body: "",
  follow_up_sequence: JSON.stringify(steps),
});
const sequenceStep = (
  delay_value: number,
  delay_unit = "minutes",
  relative_to = "previous",
) => ({
  subject: row.subject,
  body: "Exact conditional sequence content",
  delay_value,
  delay_unit,
  relative_to,
});

describe("precise conditional sequences", () => {
  it.each([
    "completed",
    "cancelled",
    "archived",
    "deleted",
    "removed",
    "replied",
  ])(
    "creates a fresh fully approved campaign after a %s campaign without changing its history",
    async (previousState) => {
      const upload = async (importId = crypto.randomUUID()) => {
        const response = await h.request(
          "/imports/drafts",
          "POST",
          { import_id: importId, rows: [row] },
          owner.session,
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const first = await upload();
      const old = first.drafts[0];
      expect((await approve([old.id], true)).status).toBe(200);
      if (["completed", "removed", "replied"].includes(previousState))
        await runLiveJobs(h.env, provider().network as any);
      if (previousState === "cancelled")
        await h.request(
          `/messages/${old.id}/cancel`,
          "POST",
          {},
          owner.session,
        );
      if (previousState === "archived")
        await h.request(
          `/professors/${old.professor_id}/archive`,
          "POST",
          {},
          owner.session,
        );
      if (previousState === "deleted")
        await h.request(
          `/professors/${old.professor_id}/delete`,
          "POST",
          { confirmed: true },
          owner.session,
        );
      if (previousState === "removed")
        await h.request(
          `/messages/${old.id}/remove`,
          "POST",
          { confirmed: true },
          owner.session,
        );
      if (previousState === "replied") {
        advance(2000);
        await syncReplies(
          h.env,
          provider(true).network as any,
          owner.id,
          old.id,
        );
        expect(
          h.db.prepare("SELECT status FROM messages WHERE id=?").get(old.id)!
            .status,
        ).toBe("replied");
      }
      const history = () =>
        JSON.stringify({
          message: h.db
            .prepare("SELECT * FROM messages WHERE id=?")
            .get(old.id),
          transport: h.db
            .prepare("SELECT * FROM transports WHERE message_id=?")
            .get(old.id),
          authorization: h.db
            .prepare("SELECT * FROM message_authorizations WHERE message_id=?")
            .get(old.id),
          automation: h.db
            .prepare("SELECT * FROM automation WHERE message_id=?")
            .get(old.id),
        });
      const before = history();
      const next = await upload();
      expect(next.created).toBe(1);
      expect(next.import_id).not.toBe(first.import_id);
      expect(next.drafts).toHaveLength(1);
      expect(next.drafts[0].id).not.toBe(old.id);
      expect(next.drafts[0]).toMatchObject({
        status: "draft",
        scheduled_at: new Date(row.scheduled_at).toISOString(),
      });
      const approval = await approve([next.drafts[0].id], true);
      expect(approval.status).toBe(200);
      expect(await approval.json()).toMatchObject({
        scheduled: 1,
        authorized_followups: 1,
        total_messages: 2,
      });
      const authorizations = h.db
        .prepare(
          "SELECT campaign_id FROM message_authorizations WHERE message_id IN (?,?)",
        )
        .all(old.id, next.drafts[0].id);
      expect(
        new Set(
          authorizations.map((authorization) => authorization.campaign_id),
        ).size,
      ).toBe(2);
      expect(history()).toBe(before);
    },
  );

  it("deduplicates concurrent and retried submissions only within their import and rejects conflicting reused IDs", async () => {
    const importId = crypto.randomUUID();
    const upload = (rows = [row]) =>
      h.request(
        "/imports/drafts",
        "POST",
        { import_id: importId, rows },
        owner.session,
      );
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(results.reduce((count, result) => count + result.created, 0)).toBe(
      1,
    );
    expect(results[0].drafts[0].id).toBe(results[1].drafts[0].id);
    expect(
      (await upload([{ ...row, body: "Changed submission" }])).status,
    ).toBe(409);
    const old = results[0].drafts[0];
    await h.request(`/messages/${old.id}/cancel`, "POST", {}, owner.session);
    expect(await (await upload()).json()).toMatchObject({
      created: 0,
      drafts: [{ id: old.id, status: "cancelled" }],
    });
    const fresh = await h.request(
      "/imports/drafts",
      "POST",
      { import_id: crypto.randomUUID(), rows: [row] },
      owner.session,
    );
    expect(await fresh.json()).toMatchObject({ created: 1 });
    expect(h.db.prepare("SELECT count(*) n FROM messages").get()!.n).toBe(2);
  });

  it.each(["decline", "opt_out", "manual opt-out", "account block"])(
    "keeps genuine %s protection when a deleted recipient starts a new campaign",
    async (reason) => {
      const [old] = await importRows();
      await h.request(
        `/professors/${old.professor_id}/delete`,
        "POST",
        { confirmed: true },
        owner.session,
      );
      h.db
        .prepare(
          "INSERT INTO suppressions(user_id,address,reason) VALUES(?,?,?)",
        )
        .run(owner.id, recipient, reason);
      const response = await h.request(
        "/imports/drafts",
        "POST",
        { import_id: crypto.randomUUID(), rows: [row] },
        owner.session,
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect((await approve([result.drafts[0].id], true)).status).toBe(409);
      expect(
        h.db.prepare("SELECT reason FROM suppressions").get()!.reason,
      ).toBe(reason);
      expect(h.db.prepare("SELECT count(*) n FROM transports").get()!.n).toBe(
        0,
      );
    },
  );

  it("approves every step of a new five-step campaign once after cancelling the old identical campaign", async () => {
    const rows = [
      sequenceRow(Array.from({ length: 5 }, () => sequenceStep(5))),
    ];
    const upload = async () => {
      const response = await h.request(
        "/imports/drafts",
        "POST",
        { import_id: crypto.randomUUID(), rows },
        owner.session,
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await upload();
    const old = first.drafts[0];
    await approve([old.id], true);
    await h.request(`/messages/${old.id}/cancel`, "POST", {}, owner.session);
    const next = await upload();
    const fresh = next.drafts[0];
    const approval = await approve([fresh.id], true);
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      authorized_followups: 5,
      total_messages: 6,
    });
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    for (let step = 0; step < 5; step++) {
      advance(301000);
      await queueSequence(h.env, p.network as any);
      await runLiveJobs(h.env, p.network as any);
    }
    expect(p.submissions()).toBe(6);
    expect(
      h.db.prepare("SELECT status FROM messages WHERE id=?").get(old.id)!
        .status,
    ).toBe("cancelled");
    expect(
      h.db
        .prepare(
          "SELECT count(*) n FROM followup_steps WHERE root_id=? AND cancel_reason='cancelled'",
        )
        .get(old.id)!.n,
    ).toBe(5);
    expect(
      h.db
        .prepare(
          "SELECT count(*) n FROM message_authorizations WHERE campaign_id=(SELECT campaign_id FROM message_authorizations WHERE message_id=?)",
        )
        .get(fresh.id)!.n,
    ).toBe(6);
    expect((await approve([fresh.id], true)).status).toBe(409);
  });

  it("rejects duplicate recipients selected together from separate new imports", async () => {
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const response = await h.request(
        "/imports/drafts",
        "POST",
        { import_id: crypto.randomUUID(), rows: [row] },
        owner.session,
      );
      ids.push((await response.json()).drafts[0].id);
    }
    expect((await approve(ids, true)).status).toBe(400);
    expect(
      h.db.prepare("SELECT count(*) n FROM campaign_approvals").get()!.n,
    ).toBe(0);
  });
  it("checks replies in earlier distinct follow-up threads before submitting the next step", async () => {
    const [draft] = await importRows([
      sequenceRow([
        sequenceStep(5),
        { ...sequenceStep(5), subject: "A different subject" },
      ]),
    ]);
    expect((await approve([draft.id], true)).status).toBe(200);
    let sends = 0;
    let replied = false;
    const network = vi.fn(async (url: string) => {
      if (url.includes("/messages/send")) {
        sends++;
        return Response.json({
          id: "accepted-" + sends,
          threadId: "thread-" + sends,
        });
      }
      if (url.includes("/threads/"))
        return Response.json({
          messages:
            replied && url.includes("/threads/thread-2?")
              ? [
                  {
                    id: "reply-child",
                    internalDate: String(Date.now() - 1000),
                    snippet: "Thank you",
                    payload: { headers: [{ name: "From", value: recipient }] },
                  },
                ]
              : [],
        });
      throw new Error("Unexpected synthetic request");
    });
    await runLiveJobs(h.env, network as any);
    advance(301000);
    await queueSequence(h.env, network as any);
    await runLiveJobs(h.env, network as any);
    expect(sends).toBe(2);
    advance(301000);
    replied = true;
    await queueSequence(h.env, network as any);
    await runLiveJobs(h.env, network as any);
    expect(sends).toBe(2);
    expect(
      h.db
        .prepare(
          "SELECT count(*) n FROM followup_steps WHERE cancel_reason='reply'",
        )
        .get()!.n,
    ).toBe(2);
  });

  it("bounds a fifth-step send across five distinct threads within the Free-plan subrequest allowance", async () => {
    const [draft] = await importRows([
      sequenceRow(
        Array.from({ length: 5 }, (_, index) => ({
          ...sequenceStep(5),
          subject: "Distinct subject " + index,
        })),
      ),
    ]);
    expect((await approve([draft.id], true)).status).toBe(200);
    let sends = 0,
      reads = 0;
    const network = vi.fn(async (url: string) => {
      if (url.includes("/messages/send")) {
        sends++;
        return Response.json({
          id: "accepted-" + sends,
          threadId: "thread-" + sends,
        });
      }
      if (url.includes("/threads/")) {
        reads++;
        return Response.json({ messages: [] });
      }
      throw new Error("Unexpected synthetic request");
    });
    await runLiveJobs(h.env, network as any);
    for (let index = 0; index < 4; index++) {
      advance(301000);
      await queueSequence(h.env, network as any);
      await runLiveJobs(h.env, network as any);
    }
    advance(301000);
    await queueSequence(h.env, network as any);
    const prepare = h.env.DB.prepare.bind(h.env.DB);
    let queries = 0;
    h.env.DB.prepare = ((sql: string) => {
      queries++;
      return prepare(sql);
    }) as typeof h.env.DB.prepare;
    reads = 0;
    await runLiveJobs(h.env, network as any);
    expect(sends).toBe(6);
    expect(reads).toBe(5);
    expect(queries + reads + 1).toBeLessThanOrEqual(50);
  });
  it.each([
    [5, "minutes", 300000],
    [10, "minutes", 600000],
    [1, "hours", 3600000],
    [3, "days", 259200000],
  ])(
    "queues %s %s only after the confirmed due time",
    async (value, unit, elapsed) => {
      const [draft] = await importRows([
        sequenceRow([sequenceStep(Number(value), String(unit), "original")]),
      ]);
      expect(
        h.db.prepare("SELECT count(*) n FROM followup_steps").get()!.n,
      ).toBe(0);
      expect((await approve([draft.id], true)).status).toBe(200);
      const p = provider();
      await runLiveJobs(h.env, p.network as any);
      const accepted = Date.parse(
        String(
          h.db.prepare("SELECT sent_at FROM messages WHERE id=?").get(draft.id)!
            .sent_at,
        ),
      );
      advance(Number(elapsed) - 1000);
      await queueSequence(h.env, p.network as any);
      expect(
        h.db.prepare("SELECT queued FROM followup_steps").get()!.queued,
      ).toBe(0);
      expect(
        Number(h.db.prepare("SELECT due_at FROM followup_steps").get()!.due_at),
      ).toBe(accepted + Number(elapsed));
      advance(2000);
      await Promise.all([
        queueSequence(h.env, p.network as any),
        queueSequence(h.env, p.network as any),
      ]);
      await runLiveJobs(h.env, p.network as any);
      await queueSequence(h.env, p.network as any);
      expect(p.submissions()).toBe(2);
      expect(
        h.db
          .prepare(
            "SELECT count(*) n FROM messages WHERE parent_id IS NOT NULL",
          )
          .get()!.n,
      ).toBe(1);
    },
  );

  it("approves and sends five exact steps once, relative to each actual previous send", async () => {
    const delays = [5, 10, 15, 30, 30];
    const [draft] = await importRows([
      sequenceRow(delays.map((delay) => sequenceStep(delay))),
    ]);
    const approval = await approve([draft.id], true);
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({
      authorized_followups: 5,
      total_messages: 6,
    });
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    for (const [index, delay] of delays.entries()) {
      advance(delay * 60000 + 1000);
      await Promise.all([
        queueSequence(h.env, p.network as any),
        queueSequence(h.env, p.network as any),
      ]);
      await runLiveJobs(h.env, p.network as any);
      expect(p.submissions()).toBe(index + 2);
    }
    await queueSequence(h.env, p.network as any);
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(6);
    expect(
      h.db
        .prepare("SELECT count(*) n FROM transports WHERE state='confirmed'")
        .get()!.n,
    ).toBe(6);
    const snapshots = h.db
      .prepare("SELECT snapshot FROM transports WHERE message_id!=?")
      .all(draft.id);
    expect(
      snapshots.every(
        (transport) =>
          JSON.parse(String(transport.snapshot)).threadId === "gmail-thread",
      ),
    ).toBe(true);
    expect(
      h.db.prepare("SELECT count(*) n FROM message_authorizations").get()!.n,
    ).toBe(6);
  });

  it.each([0, 1, 2, 3, 4])(
    "cancels all remaining steps when a reply arrives after %s follow-ups",
    async (sentSteps) => {
      const [draft] = await importRows([
        sequenceRow(Array.from({ length: 5 }, () => sequenceStep(5))),
      ]);
      expect((await approve([draft.id], true)).status).toBe(200);
      const p = provider();
      await runLiveJobs(h.env, p.network as any);
      for (let index = 0; index < sentSteps; index++) {
        advance(301000);
        await queueSequence(h.env, p.network as any);
        await runLiveJobs(h.env, p.network as any);
      }
      advance(301000);
      await queueSequence(h.env, provider(true).network as any);
      await runLiveJobs(h.env, p.network as any);
      expect(p.submissions()).toBe(sentSteps + 1);
      expect(
        h.db
          .prepare(
            "SELECT count(*) n FROM followup_steps WHERE cancel_reason='reply'",
          )
          .get()!.n,
      ).toBe(5);
    },
  );

  it("postpones on failed reply checking and blocks edits to exact authorization", async () => {
    const [draft] = await importRows([sequenceRow([sequenceStep(5)])]);
    expect((await approve([draft.id], true)).status).toBe(200);
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    advance(301000);
    await queueSequence(h.env, provider(false, true).network as any);
    expect(
      h.db.prepare("SELECT queued FROM followup_steps").get()!.queued,
    ).toBe(0);
    expect(() =>
      h.db.prepare("UPDATE followup_steps SET body='changed'").run(),
    ).toThrow(/immutable/);
    await queueSequence(h.env, p.network as any);
    const child = h.db.prepare("SELECT child_id FROM followup_steps").get()!
      .child_id;
    await h.request(
      `/messages/${draft.id}/sequence/1/cancel`,
      "POST",
      {},
      owner.session,
    );
    await runLiveJobs(h.env, p.network as any);
    expect(p.submissions()).toBe(1);
    expect(
      h.db.prepare("SELECT status FROM messages WHERE id=?").get(child)!.status,
    ).toBe("cancelled");
  });

  it("rejects accelerated external sequences even when production outreach is enabled", async () => {
    h.db
      .prepare(
        "INSERT INTO outreach_settings(user_id,production_enabled) VALUES(?,1)",
      )
      .run(owner.id);
    h.env.LIVE_TEST_RECIPIENTS = "other@example.com";
    const [draft] = await importRows([
      sequenceRow([sequenceStep(5), sequenceStep(10)]),
    ]);
    expect((await approve([draft.id], true)).status).toBe(403);
    expect(h.db.prepare("SELECT count(*) n FROM followup_steps").get()!.n).toBe(
      0,
    );
  });
});
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
        follow_up_days: "3",
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

describe("separate approval of inactive follow-up", () => {
  async function inactive() {
    const [draft] = await importRows();
    expect((await approve([draft.id], false)).status).toBe(200);
    const p = provider();
    await runLiveJobs(h.env, p.network as any);
    vi.stubGlobal("fetch", p.network);
    return { draft, p };
  }
  const consent = {
    confirmed: true,
    days: 1,
    subject: row.follow_up_subject,
    body: row.follow_up_body,
  };
  it("retains initial-only campaign scope, schedules once from confirmed send time and authorizes only the exact proposal", async () => {
    const { draft, p } = await inactive();
    const before = h.db
      .prepare("SELECT * FROM message_authorizations WHERE message_id=?")
      .get(draft.id);
    const campaigns = h.db.prepare("SELECT * FROM campaign_approvals").all();
    const r = await h.request(
      `/messages/${draft.id}/approve-followup`,
      "POST",
      consent,
      owner.session,
    );
    expect(r.status).toBe(200);
    expect(
      h.db
        .prepare("SELECT * FROM message_authorizations WHERE message_id=?")
        .get(draft.id),
    ).toEqual(before);
    expect(h.db.prepare("SELECT * FROM campaign_approvals").all()).toEqual(
      campaigns,
    );
    const rule: any = h.db
        .prepare("SELECT * FROM automation WHERE message_id=?")
        .get(draft.id),
      m: any = h.db
        .prepare("SELECT sent_at FROM messages WHERE id=?")
        .get(draft.id);
    expect(rule.due_at).toBe(Date.parse(m.sent_at) + 86400000);
    expect(
      (
        await h.request(
          `/messages/${draft.id}/approve-followup`,
          "POST",
          consent,
          owner.session,
        )
      ).status,
    ).toBe(409);
    advance(86400000 + 1000);
    await syncReplies(h.env, p.network as any, owner.id, draft.id);
    await queueFollowups(h.env);
    await queueFollowups(h.env);
    expect(
      h.db
        .prepare("SELECT count(*) n FROM messages WHERE parent_id=?")
        .get(draft.id)!.n,
    ).toBe(1);
    const child: any = h.db
      .prepare(
        "SELECT a.* FROM message_authorizations a JOIN messages m ON m.id=a.message_id WHERE m.parent_id=?",
      )
      .get(draft.id);
    expect(child.kind).toBe("followup");
    expect(child.campaign_id).toBe("separate:" + draft.id);
  });
  it("rejects changed content, cross-user access and replies before approval", async () => {
    const { draft } = await inactive();
    expect(
      (
        await h.request(
          `/messages/${draft.id}/approve-followup`,
          "POST",
          { ...consent, body: "unreviewed" },
          owner.session,
        )
      ).status,
    ).toBe(409);
    const other = await h.user("other@example.com");
    expect(
      (
        await h.request(
          `/messages/${draft.id}/approve-followup`,
          "POST",
          consent,
          other.session,
        )
      ).status,
    ).toBe(409);
    vi.stubGlobal("fetch", provider(true).network);
    // Synthetic reply must postdate the synthetic send.
    advance(2000);
    expect(
      (
        await h.request(
          `/messages/${draft.id}/approve-followup`,
          "POST",
          consent,
          owner.session,
        )
      ).status,
    ).toBe(409);
    expect(
      h.db.prepare("SELECT count(*) n FROM followup_approvals").get()!.n,
    ).toBe(0);
    expect(
      h.db.prepare("SELECT status FROM messages WHERE id=?").get(draft.id)!
        .status,
    ).toBe("replied");
  });
});
it("authorizes mixed campaigns with optional exact follow-ups and newly reimported professors", async () => {
  const drafts = await importRows([
    row,
    {
      ...row,
      email: "second@example.com",
      follow_up_days: "",
      follow_up_subject: "",
      follow_up_body: "",
    },
  ]);
  await h.request(
    `/professors/${drafts[0].professor_id}/delete`,
    "POST",
    { confirmed: true },
    owner.session,
  );
  const response = await h.request(
    "/imports/drafts",
    "POST",
    [{ ...row, subject: "Fresh approved inquiry" }],
    owner.session,
  );
  expect(response.status).toBe(200);
  const fresh = ((await response.json()) as any).drafts[0];
  expect(fresh.professor_id).not.toBe(drafts[0].professor_id);
  const result = await approve([fresh.id, drafts[1].id], true);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    scheduled: 2,
    authorized_followups: 1,
    total_messages: 3,
  });
  expect(
    h.db
      .prepare("SELECT approved,status FROM messages WHERE id=?")
      .get(drafts[0].id),
  ).toMatchObject({ approved: 0, status: "cancelled" });
  expect(h.db.prepare("SELECT count(*) n FROM automation").get()!.n).toBe(1);
  expect(
    (
      await h.request(
        `/messages/${fresh.id}`,
        "PUT",
        { subject: "Changed", body: "No" },
        owner.session,
      )
    ).status,
  ).toBe(409);
});
