import { describe, it, expect } from "vitest";
import { spreadsheetDraft } from "../../../shared/spreadsheet";
import { harness } from "./harness";
const row = {
  name: "Import QA",
  email: "qa@example.invalid",
  subject: "Exact subject",
  body: "Exact body",
  scheduled_at: "2099-01-01T12:00:00Z",
  timezone: "Asia/Karachi",
};
describe("import scalar safety", () => {
  it("normalizes blank optional and numeric Excel cells", () => {
    expect(
      spreadsheetDraft(
        {
          ...row,
          university: null,
          interests: undefined,
          follow_up_days: 3,
          follow_up_subject: "Follow up",
          follow_up_body: "Exact follow up",
        },
        0,
      ),
    ).toMatchObject({
      university: "",
      interests: "",
      followup_proposal: { days: 3 },
    });
  });
  it.each([{}, [], true, Infinity])(
    "rejects malformed cells with row and column context",
    (value) => {
      expect(() => spreadsheetDraft({ ...row, subject: value }, 0)).toThrow(
        "Row 2: subject must be text or a finite number",
      );
    },
  );
  it("reports missing fields without trim exceptions", () => {
    expect(() => spreadsheetDraft({ ...row, subject: undefined }, 0)).toThrow(
      "Row 2: provide subject",
    );
    expect(() =>
      spreadsheetDraft({ ...row, follow_up_1_body: "Only body" }, 0),
    ).toThrow("Invalid follow-up step 1");
  });
  it("rolls back the whole import when its second message insert fails", async () => {
    const h = harness();
    try {
      const owner = await h.user("atomic-import@example.invalid");
      h.db.exec(
        "CREATE TRIGGER reject_second BEFORE INSERT ON messages WHEN NEW.approved_recipient='second@example.invalid' BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END;",
      );
      const response = await h.request(
        "/imports/drafts",
        "POST",
        {
          import_id: crypto.randomUUID(),
          rows: [row, { ...row, email: "second@example.invalid" }],
        },
        owner.session,
      );
      expect(response.status).toBe(500);
      for (const table of [
        "messages",
        "campaign_imports",
        "professors",
        "message_authorizations",
        "followup_steps",
      ])
        expect(h.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(
          0,
        );
    } finally {
      h.db.close();
    }
  });
});
