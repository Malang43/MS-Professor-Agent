# Excel-to-Gmail verification - 2026-10-22

Live delivery remains disabled (`LIVE_EMAIL_ENABLED=false`). No real professors or live provider sends are used in these checks. Existing production Gmail credentials/connections, account data, documents and Groq configuration are preserved.

## Supported workbook

Download `/professors-email-template.xlsx` in Professors. Its first sheet contains synthetic examples; the second contains instructions. `scripts/generate-excel-template.py` reproducibly generates the workbook and matching CSV without adding dependencies.

Columns: `name`, `email`, `university`, `interests` (research details), `subject`, `body`, `scheduled_at`, `timezone`, `followup_days`, `followup_subject`, `followup_body`.

`scheduled_at` is a complete UTC ISO **text** timestamp such as `2099-01-01T12:00:00Z`. Native Excel date cells and ambiguous local dates are rejected. `timezone` is an optional IANA display zone, default UTC. Follow-up columns must all be supplied together or all left blank. Delay is an integer from 1 to 30 elapsed days after confirmed initial delivery, including 3 days. One automatic follow-up maximum remains enforced.

Professor-only imports retain the 500-row limit. Enable `Also prepare fully specified manual mock drafts` for up to 25 complete email rows and a 5 MB upload. Professors and drafts are saved in one D1 transaction. Validation/storage failure leaves no partial import; quota reservations conservatively remain consumed. A server-side recipient/content/UTC-schedule fingerprint deduplicates repeated/concurrent requests and repeated rows. Existing matching drafts are skipped. Changed content or schedules intentionally count as new drafts. Deleted history no longer provides deduplication evidence.

Imports cannot grant approval, select live sending, or authorize follow-ups. Unknown spreadsheet authorization columns are ignored. Follow-up rules persist as inactive proposals; approving an initial mock draft does not arm them. Review a proposal, choose `Use proposal in composer`, select an eligible connected mailbox, enable the proposed follow-up, review exact content, and explicitly authorize it. This creates a new reviewed message; the imported mock draft remains in history and may be cancelled separately. Live mailbox choices stay disabled until the owner separately authorizes a controlled live test.

## Verification

- 163 automated tests pass across 10 files, including the actual generated XLSX/parser/API round trip, all supported fields, atomic rollback/retry, concurrent and within-file duplicates, user isolation, malformed dates/timezones/rules, 25-row query budget, and migration preservation.
- Existing approval, UTC scheduling, mock delivery, live-provider adapter, attachment, OAuth, reply, follow-up, quota, timeout/uncertainty, lease recovery and retry tests pass with mocked provider HTTP.
- Three-day follow-ups cannot queue early and require explicit authorization plus a complete fresh reply check. A queued child now checks the parent thread again immediately before submission; failed or partial checks block sending, and detected replies cancel pending children. Polling covers tracked threads for 31 days to accommodate a 30-day proposal; it is bounded polling, not universal inbox/bounce detection.
- Limits remain one/student/minute, ten/student/day and 100/application/day, with additional one/mailbox/minute and ten/mailbox/day budgets shared by provider identity across application users. Provider rejections/backoff remain enforced. Uncertain outcomes are reconciled, never blindly resent.
- Both workspace TypeScript checks and the production frontend build pass. Isolated browser coverage verifies account flows, CSV imports, batch approval, documents, responsive UI and session recovery. Real local Wrangler/D1/KV smoke checks verify authentication, storage, isolation, mock dispatch and duplicate prevention.

## Live Gmail test still required

Local and mocked tests cannot certify actual Gmail consent/scopes, token refresh in the current connection, provider acceptance, Sent/thread identifiers, reply visibility, provider quotas, elapsed production scheduling, or Cloudflare runtime CPU fitness during provider calls. A separate controlled-address test must cover actual delivery, replies cancelling a queued follow-up, three-day scheduling, and failure/reconciliation behavior. No live send, follow-up send, or real professor outreach is authorized by this release.

Before that test the owner must name addresses they own/control and authorize the exact test. Keep the existing controlled-recipient allowlist and all per-message approval/authorization gates. Disable live delivery again after the test. OAuth/Groq/transactional email setup limitations recorded in earlier release reports remain applicable; this release does not re-register accounts or rotate credentials.

## Release

The reviewed migration is `0004_spreadsheet_automation.sql`. It preserves existing automation rows and generated/cancelled state while replacing the delay constraint, restores cancellation triggers, and adds nullable proposal/import-key columns plus a unique import index. No accounts, files, tokens, messages or quota counters are reset. A private D1 export and settings/data fingerprints are retained under ignored `.wrangler` storage. GitHub, Worker and Vercel release identifiers and post-deployment evidence are recorded after verification.

Worker version: `af8a0880-047d-4595-914b-54ce46732e74` at the existing workers.dev URL. Production migration applied successfully. Post-deploy fingerprint verification confirms unchanged existing account/password, document metadata, encrypted Gmail connection, non-variable bindings and every pre-existing production variable (including enabled Groq, OAuth and disabled live mail). Dependency audit: zero known vulnerabilities across all severities.
