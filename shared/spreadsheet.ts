export type FollowupProposal = { days: number; subject: string; body: string };
export type SpreadsheetDraft = {
  name: string;
  email: string;
  university: string;
  interests: string;
  subject: string;
  body: string;
  scheduled_at: string;
  timezone: string;
  followup_proposal?: FollowupProposal;
  followup_issue?: string;
  followup_draft?: { days?: number; subject: string; body: string };
};

export function spreadsheetDraft(
  row: Record<string, string>,
  index: number,
  allowIncompleteFollowup = false,
): SpreadsheetDraft {
  const fail = (message: string): never => {
    throw new Error(`Row ${index + 2}: ${message}`);
  };
  row = { ...row };
  for (const field of ["days", "subject", "body"]) {
    const oldValue = row["followup_" + field]?.trim(),
      newValue = row["follow_up_" + field]?.trim();
    if (oldValue && newValue && oldValue !== newValue)
      fail("conflicting followup_ and follow_up_ columns: " + field);
    row["followup_" + field] = newValue || oldValue || "";
  }
  const subject = row.subject?.trim() || "",
    body = row.body?.trim() || "";
  if (
    !subject ||
    subject.length > 500 ||
    /[\r\n]/.test(subject) ||
    !body ||
    body.length > 20000
  )
    fail(
      "provide subject (up to 500 characters) and body (up to 20000 characters).",
    );
  const date = row.scheduled_at || "";
  // Excel date cells have no timezone: require UTC text to avoid browser-dependent shifts.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(date) ||
    !Number.isFinite(Date.parse(date))
  )
    fail(
      "scheduled_at must be a UTC ISO text timestamp, e.g. 2099-01-01T12:00:00Z.",
    );
  if (new Date(date).toISOString().slice(0, 19) !== date.slice(0, 19))
    fail("invalid calendar date.");
  const timezone = row.timezone?.trim() || "Asia/Karachi";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    fail("invalid IANA timezone.");
  }
  let followup_proposal: FollowupProposal | undefined;
  let followup_issue: string | undefined,
    followup_draft: SpreadsheetDraft["followup_draft"];
  if (row.followup_days || row.followup_subject || row.followup_body) {
    const days = Number(row.followup_days),
      subject = row.followup_subject?.trim() || "",
      body = row.followup_body?.trim() || "";
    if (
      (row.followup_days &&
        (!Number.isInteger(days) || days < 1 || days > 30)) ||
      subject.length > 500 ||
      /[\r\n]/.test(subject) ||
      body.length > 20000
    )
      fail(
        "follow-up requires an integer delay of 1-30 days, a single-line subject and a body up to 20000 characters.",
      );
    if (!row.followup_days || !subject || !body) {
      followup_issue =
        "Missing follow-up " +
        [
          !row.followup_days ? "delay" : "",
          !subject ? "subject" : "",
          !body ? "body" : "",
        ]
          .filter(Boolean)
          .join(", ") +
        "; automatic follow-up cannot be authorized.";
      if (!allowIncompleteFollowup) fail(followup_issue);
      followup_draft = {
        ...(row.followup_days ? { days } : {}),
        subject,
        body,
      };
    } else followup_proposal = { days, subject, body };
  }
  // Spreadsheet authorization flags are never accepted.
  return {
    name: row.name?.trim() || "",
    email: row.email?.trim().toLowerCase() || "",
    university: row.university?.trim() || "",
    interests: row.interests?.trim() || "",
    subject,
    body,
    scheduled_at: new Date(date).toISOString(),
    timezone,
    ...(followup_proposal ? { followup_proposal } : {}),
    ...(followup_issue ? { followup_issue, followup_draft } : {}),
  };
}
