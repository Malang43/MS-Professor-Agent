import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

it("releases only deletion-derived restrictions while preserving historical decline evidence and all old messages", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((file) => file.endsWith(".sql") && file < "0010")
      .sort())
      db.exec(
        readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
      );
    db.exec(
      "INSERT INTO users(id,email,password) VALUES('owner','owner@example.com','synthetic')",
    );
    for (const recipient of ["deleted", "declined", "blocked"]) {
      db.prepare(
        "INSERT INTO professors(id,user_id,name,email) VALUES(?,'owner',?,?)",
      ).run(recipient, recipient, recipient + "@example.com");
      db.prepare(
        "INSERT INTO messages(id,user_id,professor_id,subject,body,mode,status,scheduled_at,timezone,approved_recipient) VALUES(?,'owner',?,'Original','History','manual','cancelled','2000-01-01T00:00:00Z','Asia/Karachi',?)",
      ).run(recipient, recipient, recipient + "@example.com");
      db.prepare(
        "INSERT INTO suppressions(user_id,address,reason) VALUES('owner',?,?)",
      ).run(
        recipient + "@example.com",
        recipient === "blocked" ? "account block" : "professor_deleted",
      );
    }
    db.exec(
      "INSERT INTO audit(id,user_id,action,entity_id) VALUES('old-decline','owner','recipient.decline','declined')",
    );
    const history = JSON.stringify(
      db.prepare("SELECT * FROM messages ORDER BY id").all(),
    );
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0010_campaign_import_identity.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      db
        .prepare(
          "SELECT reason FROM suppressions WHERE address='deleted@example.com'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT reason FROM suppressions WHERE address='declined@example.com'",
        )
        .get()!.reason,
    ).toBe("historical_recipient_block");
    expect(
      db
        .prepare(
          "SELECT reason FROM suppressions WHERE address='blocked@example.com'",
        )
        .get()!.reason,
    ).toBe("account block");
    const current = db
      .prepare("SELECT * FROM messages ORDER BY id")
      .all()
      .map(({ campaign_import_id, ...message }) => message);
    expect(JSON.stringify(current)).toBe(history);
    db.prepare("UPDATE professors SET deleted_at=1 WHERE id='deleted'").run();
    expect(
      db
        .prepare(
          "SELECT reason FROM suppressions WHERE address='deleted@example.com'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT count(*) n FROM campaign_imports").get()!.n).toBe(
      0,
    );
  } finally {
    db.close();
  }
});
