# Production import reliability repair � 29 October 2026

The affected save request is same-origin `POST /api/imports/drafts` on the canonical Vercel hostname, rewritten to the existing `ms-professor-outreach-api` Worker. Payload: `{ import_id: UUID, rows: [...] }`.

## Diagnosis and limits

The historical reported failure was not reproduced. Before any code changes, a real production Chromium CSV import with two recipients and four numbered follow-ups each returned HTTP 200 and saved two unapproved drafts. Worker tail showed no exception. Historical telemetry querying returned HTTP 403 with the current credential, so the exact cause of the user's earlier `Failed to fetch` or undefined `.trim()` exception cannot honestly be established. No original browser trace or failing spreadsheet was available. A transient connection/proxy failure or stale browser bundle remains possible; neither is proven.

Current requests use the same-origin proxy, authenticate successfully, and reach the correct Worker with all ten D1 migrations applied. No persistent CORS, authentication, schema, Worker limit, or deployment mismatch failure was observed. A successful two-row reproduction does not rule out a historical transient failure or a failure with other input.

Before the first diagnostic import, production D1 had zero campaign_imports records, zero draft/pending messages, seven cancelled messages (five unapproved, two approved), five replied messages, four sent messages, and seven message authorizations. Therefore there was no surviving imported campaign or draft from the reported attempt under the current import schema. Older cancelled history was preserved, not removed or interpreted as new failed-import data. Absence of current drafts cannot establish that no historical intermediate data ever existed.

## Changes

- Shared spreadsheet validation normalizes absent/null cells to empty strings and finite numeric cells to text. Objects, arrays, booleans and nonfinite values produce row/column validation errors before string operations. API validation and browser parsing use the shared rules.
- Empty or duplicate XLSX header cells now produce an explicit validation error instead of an undefined-header failure.
- Shared browser requests have a 60-second timeout, retain server JSON errors, identify method/path for transport failures, and report HTTP status for non-JSON responses. The existing wizard finally block clears its busy state after these failures.
- An uncertain campaign submission ID is retained in sessionStorage, keyed by exact payload and preparation mode, until the save is acknowledged. Closing/reloading and retrying the same upload in that browser session recovers its original submission. Storage-disabled browsers retain same-wizard retry protection.
- Existing D1 atomic batch, unique import-recipient index, payload consistency trigger and approval workflow remain intact. No migration, mailbox connection, sending-control change or approval was performed. A deliberately new acknowledged upload still creates a new campaign as designed; idempotency does not prohibit intentional new campaigns.

## Verified CSV/XLSX columns

Initial content: `name`, `email`, `subject`, `body`, `scheduled_at`, optionally `university`, `interests`, `timezone` (default Asia/Karachi). scheduled_at must be UTC ISO text such as `2099-01-01T12:00:00Z`, not a native Excel date cell.

Four follow-ups: for N=1 through 4, use `follow_up_N_subject`, `follow_up_N_body`, `follow_up_N_delay_value`, `follow_up_N_delay_unit`, `follow_up_N_relative_to`. Units are `minutes`, `hours`, `days`; relative timing is `original` or `previous`. Delays are positive integers; cumulative increasing timing must finish within 30 days. Numbered steps must be contiguous. These names match both downloadable templates, which support through step 5.

Alternatives remain supported: `follow_up_sequence` containing the JSON step array; single flexible follow-up timing using `follow_up_delay_value/unit/relative_to` with `follow_up_subject/body`; legacy `follow_up_days/subject/body` and `followup_days/subject/body`. Do not mix sequence and legacy timing/content. Spreadsheet flags never authorize sending.

Existing recipient eligibility is unchanged: multiple accelerated conditional follow-ups require server-verified controlled test recipients. External outreach retains its existing one-follow-up/minimum-three-day approval restriction. This repair does not bypass that restriction.

## Validation and production evidence

- 307 automated tests passed across 18 files, including malformed/missing/numeric/null cells and forced second-message failure rollback.
- Both workspace TypeScript checks and optimized Next.js production build passed.
- `node scripts/import-runtime.cjs` passed in native workerd/Miniflare with real isolated D1 and all outbound traffic forbidden: all migrations, two recipients/four steps each, concurrent retries, conflicting payload rejection, failed transaction rollback, zero authorizations/approvals/deliveries.
- Production Chromium: actual CSV and generated XLSX based on the real template workbook; Manual; whole-campaign review; individual review; two initial emails plus eight conditional follow-ups; approval button never clicked. All non-GET requests except draft import were blocked by the QA browser harness.
- Lost-response production test let the actual Worker commit its XLSX import, then deliberately aborted the browser response. The UI displayed the useful method/path error and left Saving state. After page reload and reupload, it reused import `c98ef190-cc23-4c75-b7d6-c301266ecfe6`, returning exactly the original two unapproved drafts, each with four steps.
- Worker tail for the three post-deployment save/retry requests: HTTP 200, outcome ok, zero exceptions; CPU 22/19/6 ms and wall time 390/4536/127 ms. Worker version matched the deployed fix.
- Production binding digest, non-QA message status/approval counts, authorization count, follow-up count, connection states/count, user count and delivery count stayed unchanged. Existing data was not rewritten. Synthetic `.invalid` draft fixtures remain confined to an existing QA account. Temporary QA sessions were revoked. No real emails or campaign approvals were made.

Worker version: `25bb2f57-fc6e-472e-bc40-eaee8cc497c1`.
Vercel deployment: `dpl_oG5zau3k6h72fufX5xa8qqPUzLKL`, READY, canonical alias `https://ms-professor-agent-malang43.vercel.app`.

The tested import can safely be retried after reloading the application. During an uncertain save, retry the same file in the same browser session so its pending submission ID is recovered. Final approval/sending remains a separate explicit user action and was intentionally not exercised.

Source-control authorization: the owner explicitly approved committing and pushing these tested changes to the existing private repository main branch after scope and secret review. No production data mutation or campaign approval is part of that synchronization.
