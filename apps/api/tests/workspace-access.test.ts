import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { harness, fileForm } from "./harness";
import { permittedWorkspaceRoute } from "../src/workspace-access";
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External calls forbidden");
    }),
  );
});
afterEach(() => {
  h.db.close();
  vi.unstubAllGlobals();
});
async function pending(email = "pending@example.invalid") {
  const u = await h.user(email);
  h.db
    .prepare(
      "UPDATE users SET legacy_access=0,email_verified_at=NULL WHERE id=?",
    )
    .run(u.id);
  return u;
}
const prof = {
  name: "Professor One",
  email: "professor@example.invalid",
  university: "Research",
  interests: "AI",
};
const profile = {
  name: "Amira",
  university: "University",
  degree: "MS",
  gpa: "3.8",
  interests: "Robotics",
  timezone: "Asia/Karachi",
};
describe("approved limited unverified workspace", () => {
  it("requires authentication on every approved route", async () => {
    for (const [path, method, data] of [
      ["/state", "GET"],
      ["/profile", "PUT", profile],
      ["/professors", "POST", [prof]],
      ["/documents", "POST", fileForm()],
    ] as const)
      expect((await h.request(path, method, data)).status).toBe(401);
  });
  it("permits private profile and professor management without verifying email", async () => {
    const u = await pending();
    expect(
      (await h.request("/profile", "PUT", profile, u.session)).status,
    ).toBe(200);
    expect(
      (await h.request("/professors", "POST", [prof], u.session)).status,
    ).toBe(200);
    const p: any = h.db
      .prepare("SELECT id FROM professors WHERE user_id=?")
      .get(u.id);
    expect(
      (
        await h.request(
          `/professors/${p.id}`,
          "PUT",
          { ...prof, name: "Updated" },
          u.session,
        )
      ).status,
    ).toBe(200);
    for (const action of ["archive", "restore"])
      expect(
        (
          await h.request(
            `/professors/${p.id}/${action}`,
            "POST",
            {},
            u.session,
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await h.request(
          `/professors/${p.id}/verify`,
          "POST",
          {
            source_url: "https://university.example/professor",
            confirmed: true,
          },
          u.session,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          `/professors/${p.id}/delete`,
          "POST",
          { confirmed: true },
          u.session,
        )
      ).status,
    ).toBe(200);
    const state: any = await (
      await h.request("/state", "GET", undefined, u.session)
    ).json();
    expect(state.profile.name).toBe(profile.name);
    expect(state.account.email_verified_at).toBeNull();
    expect(state.account.legacy_access).toBe(0);
    expect(state.capabilities.workspace_limited).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("isolates dashboards, professor mutations and document read/delete across users", async () => {
    const a = await pending(),
      b = await pending("other@example.invalid");
    await h.request("/professors", "POST", [prof], a.session);
    const p: any = h.db
      .prepare("SELECT id FROM professors WHERE user_id=?")
      .get(a.id);
    expect(
      (await h.request(`/professors/${p.id}`, "PUT", prof, b.session)).status,
    ).toBe(404);
    for (const action of ["archive", "restore", "delete"])
      expect(
        (
          await h.request(
            `/professors/${p.id}/${action}`,
            "POST",
            { confirmed: true },
            b.session,
          )
        ).status,
      ).toBe(404);
    const uploaded = await h.request(
      "/documents",
      "POST",
      fileForm("private research"),
      a.session,
    );
    expect(uploaded.status).toBe(200);
    const doc: any = await uploaded.json();
    expect(
      (await h.request(`/documents/${doc.id}`, "GET", undefined, a.session))
        .status,
    ).toBe(200);
    const reads = h.flags.reads;
    expect(
      (await h.request(`/documents/${doc.id}`, "GET", undefined, b.session))
        .status,
    ).toBe(404);
    expect(h.flags.reads).toBe(reads);
    expect(
      (await h.request(`/documents/${doc.id}/delete`, "POST", {}, b.session))
        .status,
    ).toBe(404);
    const state: any = await (
      await h.request("/state", "GET", undefined, b.session)
    ).json();
    expect(state.professors).toEqual([]);
    expect(state.documents).toEqual([]);
    expect(
      (await h.request(`/documents/${doc.id}/delete`, "POST", {}, a.session))
        .status,
    ).toBe(200);
  });
  it("denies all mailbox, campaign, AI, outreach and control operations before parsing input", async () => {
    const u = await pending(),
      id = crypto.randomUUID();
    const paths = [
      "/connections/gmail/start",
      "/connections/outlook/start",
      "/connections/check",
      "/connections/sync",
      `/connections/${id}/disconnect`,
      "/messages",
      "/messages/approve",
      `/messages/${id}/approve-followup`,
      `/messages/${id}/retry`,
      `/messages/${id}/reply`,
      `/messages/${id}/cancel`,
      `/messages/${id}/followup`,
      `/messages/${id}/outcome`,
      `/messages/${id}/cancel-automation`,
      "/outreach/mode",
      "/control",
      "/jobs/run",
      "/suppressions",
      "/notifications/read",
      "/draft",
      "/imports/drafts",
      `/messages/${id}/archive`,
    ];
    for (const path of paths)
      expect((await h.request(path, "POST", {}, u.session)).status, path).toBe(
        403,
      );
    expect(fetch).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT count(*) n FROM messages").get()!.n).toBe(0);
  });
  it("does not expose stored mailbox data or server recipient configuration", async () => {
    const u = await pending();
    h.db
      .prepare(
        "INSERT INTO connections(id,user_id,provider,address,subject,scopes,expires_at) VALUES(?,?,'gmail','private-mailbox@example.invalid','synthetic-subject','gmail.send',9999999999999)",
      )
      .run(crypto.randomUUID(), u.id);
    h.env.LIVE_TEST_RECIPIENTS = "server-only@example.invalid";
    const state: any = await (
      await h.request("/state", "GET", undefined, u.session)
    ).json();
    for (const key of [
      "connections",
      "messages",
      "audit",
      "automation",
      "transports",
      "mailbox_checks",
      "delivery_attempts",
      "authorizations",
      "campaigns",
      "followup_approvals",
    ])
      expect(state[key]).toEqual([]);
    expect(state.capabilities.test_recipients).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("private-mailbox");
    expect(JSON.stringify(state)).not.toContain("server-only");
  });
  it("keeps route/method matching default-deny and rate-limits limited mutations", async () => {
    expect(permittedWorkspaceRoute("/api/profile", "POST")).toBe(false);
    expect(
      permittedWorkspaceRoute("/api/documents/x/delete/extra", "POST"),
    ).toBe(false);
    expect(permittedWorkspaceRoute("/api/professors/x/send", "POST")).toBe(
      false,
    );
    const u = await pending();
    for (let i = 0; i < 60; i++)
      expect(
        (await h.request("/profile", "PUT", profile, u.session)).status,
      ).toBe(200);
    const r = await h.request("/profile", "PUT", profile, u.session);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBeTruthy();
  });
  it("preserves verified and existing legacy workspace behavior", async () => {
    for (const verified of [false, true]) {
      const u = await h.user(
        verified ? "verified@example.invalid" : "legacy@example.invalid",
      );
      if (verified)
        h.db
          .prepare(
            "UPDATE users SET legacy_access=0,email_verified_at=? WHERE id=?",
          )
          .run(Date.now(), u.id);
      const state: any = await (
        await h.request("/state", "GET", undefined, u.session)
      ).json();
      expect(state.capabilities.workspace_limited).toBe(false);
      expect(
        (await h.request("/professors", "POST", [prof], u.session)).status,
      ).toBe(200);
    }
  });
});
