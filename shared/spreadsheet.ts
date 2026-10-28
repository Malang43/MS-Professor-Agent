import { validateSequence, type FollowupStep } from "./followup-sequence";
export type FollowupProposal = {
  days: number;
  subject: string;
  body: string;
  steps?: FollowupStep[];
};
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
    const oldValue = row["followup_" + field],
      newValue = row["follow_up_" + field];
    if (oldValue && newValue && oldValue !== newValue)
      fail("conflicting followup_ and follow_up_ columns: " + field);
    row["followup_" + field] = newValue || oldValue || "";
  }
  const subject = row.subject || "",
    body = row.body || "";
  if (
    !subject.trim() ||
    subject.length > 500 ||
    /[\r\n]/.test(subject) ||
    !body.trim() ||
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
  if (
    (row.followup_days || row.followup_subject || row.followup_body) &&
    !row.follow_up_delay_value &&
    !row.follow_up_sequence &&
    !row.follow_up_1_delay_value
  ) {
    const days = Number(row.followup_days),
      subject = row.followup_subject || "",
      body = row.followup_body || "";
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
  const numbered = Array.from({ length: 5 }, (_, index) => {
    const prefix = `follow_up_${index + 1}_`;
    if (
      !["subject", "body", "delay_value", "delay_unit", "relative_to"].some(
        (field) => row[prefix + field],
      )
    )
      return null;
    return {
      subject: row[prefix + "subject"],
      body: row[prefix + "body"],
      delay_value: Number(row[prefix + "delay_value"]),
      delay_unit: row[prefix + "delay_unit"],
      relative_to: row[prefix + "relative_to"],
    };
  });
  let configured: unknown = null;
  if (row.follow_up_sequence) {
    if (numbered.some(Boolean))
      fail("use either follow_up_sequence JSON or numbered step columns.");
    try {
      configured = JSON.parse(row.follow_up_sequence);
    } catch {
      fail("invalid follow_up_sequence JSON.");
    }
  } else if (numbered.some(Boolean)) {
    const last = numbered.reduce(
      (last, step, index) => (step ? index : last),
      -1,
    );
    configured = numbered.slice(0, last + 1);
  } else if (
    row.follow_up_delay_value ||
    row.follow_up_delay_unit ||
    row.follow_up_relative_to
  ) {
    configured = [
      {
        subject: row.followup_subject,
        body: row.followup_body,
        delay_value: Number(row.follow_up_delay_value),
        delay_unit: row.follow_up_delay_unit,
        relative_to: row.follow_up_relative_to || "original",
      },
    ];
  }
  if (configured || row.follow_up_sequence) {
    if (row.followup_days)
      fail("legacy day delay conflicts with sequence timing.");
    if (
      (row.follow_up_sequence || numbered.some(Boolean)) &&
      (row.followup_subject || row.followup_body)
    )
      fail("legacy follow-up content conflicts with sequence content.");
    let steps: FollowupStep[];
    try {
      steps = validateSequence(configured);
    } catch (error) {
      return fail((error as Error).message);
    }
    followup_proposal = {
      days: 1,
      subject: steps[0].subject,
      body: steps[0].body,
      steps,
    };
    followup_issue = undefined;
    followup_draft = undefined;
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
