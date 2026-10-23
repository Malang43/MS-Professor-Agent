# One-time campaign approval and automatic follow-up - 2026-10-23

This release extends the existing working Gmail outbox and reply synchronization. No Gmail connection, OAuth credentials, Groq configuration or owner activation setting is replaced. No new real messages are sent during development/testing/deployment.

## User workflow

Upload one Excel workbook in Professors. Email columns automatically create unapproved drafts. In Outreach choose **Select all campaign drafts**, review every recipient, initial subject/body, UTC schedule and display timezone, exact follow-up subject/body/delay and total authorized message count. Choose the Gmail account. Leave the option unchecked for **Approve initial emails only**, or explicitly choose **Approve initial emails and automatic follow-ups** and click that approval button once.

One approval supports the full current 25-row email import (up to 25 initial plus 25 conditional follow-up messages). It authorizes the displayed selection only. For combined approval every selected row must have complete valid follow-up content. A missing subject/body/delay is visibly marked; it is never generated or silently authorized. Incomplete follow-up data remains an unapproved proposal so initial-only sending remains possible. Attachments continue to require individual review.

Both `follow_up_days`, `follow_up_subject`, `follow_up_body` and the legacy `followup_*` names are supported. Conflicting alias values are rejected. Delay is 1-30 elapsed days. The existing professor/research/initial-email columns and UTC ISO TEXT schedules remain compatible. Display timezone defaults to Asia/Karachi. The updated downloadable XLSX and CSV contain instructions and synthetic examples.

## Authorization and automation

Approval is one atomic D1 transaction. A campaign row freezes the complete selection, counts, account and approval time. Per-message authorization freezes recipient, subject/body, account, attachments/checksums, schedule/timezone, exact follow-up rule, no-reply condition and maximum of one automatic follow-up. Database triggers prevent changes to approved content, transport snapshots, follow-up rules or authorization/campaign records. Cancelled authorized follow-ups cannot be rearmed. New recipients, edited content and additional messages require new explicit approval.

Gmail acceptance establishes the initial send timestamp and exact follow-up due timestamp. If acceptance was uncertain, reconciliation uses Gmail's returned internal timestamp when available, rather than treating reconciliation time as a new send. A due authorized follow-up is queued automatically after a fresh successful complete reply check. It receives its own provider tracking and an authorization reference derived from the original campaign; no later preparation or approval is needed. The reply check repeats immediately before submission and fails closed on unavailable, partial or stale verification.

A tracked reply permanently cancels the pending follow-up. Opt-out/decline/bounce suppressions remain enforced. There is at most one automatic child per initial message, protected by existing unique-parent indexes and outbox claims. Matching subjects retain Gmail thread metadata with reply/reference headers; different exact subjects are preserved and tracked through their returned Gmail conversation IDs. Existing ambiguity/reconciliation and conservative Gmail account/student/global rate limits are preserved.

The dashboard shows initial acceptance, waiting for reply, automatic approval, scheduled due date/time and timezone, provider-confirmed follow-up sending, reply/opt-out cancellation and failures. The exact due time is established only after initial acceptance. Cron/backlog/provider limits may delay actual delivery beyond that due time; the dashboard does not claim exact wall-clock sending. Existing manual reminders are not converted into automatic authorization and keep manual preparation available.

## Archive, removal and deletion

Professors have Edit, Archive/Restore and confirmed Delete actions. Archive changes visibility; existing approved schedules remain unchanged. Delete permanently removes profile details and retains a minimal ID/address tombstone, necessary delivery/authorization evidence and sending suppression. It atomically cancels queued initials/children, stops automatic plans and prevents subsequent sends to deleted recipients. Suppression and the last send fence protect deletion races. Already accepted or in-flight Gmail requests cannot be recalled.

Outreach has View, Archive/Restore, Remove from dashboard and Cancel actions. Unsent messages must be cancelled before removal. Removal hides the record and cancels remaining automatic follow-ups; it does not recall a Gmail email or erase provider receipts, authorization, delivery attempts or opt-out history. Uncertain/submitting messages remain visible for reconciliation. Active, Archived and All history filters expose retained operational history. Explicit whole-account erasure retains its existing authenticated confirmation/cleanup behavior and removes the new account-owned audit rows through cascades.

## Existing production data

Migration `0006_campaign_records.sql` is additive. It creates no campaign authorizations for existing messages, reminders or historical test emails. Successful Gmail delivery IDs, thread IDs, reply history, content and actual send timestamps are preserved. No test emails are replayed. Existing explicitly authorized plans remain operational; manual reminders remain manual. No new infrastructure or paid services are introduced.

Production settings and successful delivery/reply data are fingerprinted read-only before and after deployment. A private pre-release D1 export is retained under ignored `.wrangler` storage. The release must preserve all current variables/bindings and the owner's current activation mode rather than deploying source defaults.

## Verification

Final test counts and deployment evidence are recorded below after verification. Automated provider calls are synthetic/intercepted. Coverage includes Excel aliases/compatibility and missing data; complete one-time approval; immutable records and selected-only approval; one-day sending without another approval; actual acceptance/due times; reply and opt-out cancellation; final reply-check failure/recovery; Gmail threading; repeated cron/claim deduplication; cancel/delete/archive/remove; deletion racing with refresh; atomic storage rollback and retry; foreign-key integrity; account erasure compatibility; preservation of historical data.

Final verification: **202 automated tests passed across 12 files**; both workspace TypeScript checks and the production build passed. The native Workers provider regression passed with every outbound request intercepted. The isolated Chromium flow passed actual XLSX import, full campaign content/count review, one-time combined approval, automatic follow-up dashboard without a preparation step, professor archive/restore/delete, outreach removal/history and retained audit/foreign-key checks. Dependency audit: zero known vulnerabilities.

Migration 0006 applied successfully. Worker version: `3005859b-1af7-43b3-ad6a-0e8ce20aa431`. Read-only post-deploy verification confirms the existing two real Gmail deliveries, one detected reply, successful message content/send timestamps/provider/thread IDs, accounts, documents, connected Gmail identity/scopes, all variables/credential bindings, Groq settings and activation state are preserved. No new real deliveries occurred. Existing manual reminders and historical messages received no new authorizations.

The pre-existing owner setting is still in controlled-recipient mode. This release intentionally does not widen recipient permissions. The existing **Settings > Activate professor outreach** control remains the owner-controlled step before campaigns to other professor addresses; it is not another follow-up approval. Once a campaign is approved with automatic follow-ups, no later preparation or approval is required for those exact follow-ups.
