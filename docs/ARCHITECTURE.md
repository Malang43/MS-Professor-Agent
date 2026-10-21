# Architecture, consistency and readiness boundaries

## Runtime modules

The existing Next.js static dashboard remains in `apps/web`. Production fetches and download anchors use browser-origin `/api`. Vercel's fixed HTTPS workers.dev rewrite introduces no Function or middleware. Strict host-only cookies, exact mutation Origin validation, no-store controls and disabled slash redirects remain. Development can call the local Worker directly.

| Module | Responsibility |
| --- | --- |
| `index.ts` | Existing authentication/profile/import/workflow routes, API composition, configuration checks, bounded cron |
| `runtime.ts` | Environment contract, safe errors, hashes, D1 usage counters, notifications and audit |
| `storage.ts` | Storage interface, KV and optional legacy R2 adapters, validation, quotas, expiry and cleanup |
| `oauth.ts` | PKCE/state/browser-session binding, encryption, refresh leases, disconnect |
| `providers.ts` | Gmail MIME/REST, Graph, bounded responses, receipts/reconciliation and thread polling |
| `automation.ts` | Frozen snapshots, claims/fences, retry/uncertainty, replies/suppression and one follow-up |
| `ai.ts` | Factual mock templates, optional Groq selection, privacy filtering, budgets and fallback |

Native fetch/Web Crypto and D1/KV bindings are used; no new production package, billing activation or production R2 requirement was introduced. Real sending and integrations default off.

## D1 and tenant isolation

`0001_initial.sql` is unchanged. Additive `0002_storage_integrations.sql` preserves rows and adds file lifecycle/backend/checksum/expiry fields, counters, OAuth state, encrypted connections, transport snapshots/outbox, one-follow-up metadata, suppressions, mailbox events, notifications and AI usage.

All student queries derive identity from the session. Attachments and transport/account ownership additionally use composite foreign keys. A trigger rejects new references to unavailable/expired documents. Reply/cancel/failure triggers disable automation and cancel a queued child. Suppression atomically disables matching plans and pending live sends for that user/address. Clients cannot supply authoritative user IDs. State exposes safe connection summaries/transport IDs, never tokens, PKCE verifiers, KV keys or ciphertext.

Conditional D1 INSERT/UPSERT/UPDATE statements are the concurrency authority for reservations, counters, leases and one-use state. Tests reject missing positional bindings as D1 does; Node SQLite otherwise silently binds NULL.

## File lifecycle

Uploads are stream-bounded before multipart parsing, with 2 MiB maximum. Filename/type/signature checks reject misleading types, active PDF markers, encrypted/unsafe/expanded DOCX containers and invalid/control-laden UTF-8 TXT. These are not malware scanning or comprehensive parsing. Downloads are safe encoded attachments, nosniff and no-store, never trusted HTML.

A D1 reservation precedes an immutable opaque KV put, then the row becomes ready. Checksums detect corruption. New values expire in 30 days. Missing newly written values yield retryable 503 because KV is eventually consistent. Ambiguous/failed puts remain hidden with quota retained; abandoned values expire even after a crash. No strong global read-after-write promise is made.

Every read checks D1 ownership, ready state and expiry first. Deletion hides the row immediately, so stale KV cannot expose a tombstoned file. Outstanding messages/armed follow-ups block deletion. Deferred cleanup/retries handle failed deletes. User quota releases on successful cleanup; global deleted reservations count through expiry instead of assuming instantaneous physical deletion. Conservative 100 MiB/global and daily operation budgets are below Free allowances, provided the namespace is dedicated.

Legacy rows remain marked R2, preserving keys and optional local reads. Default deployment has no R2 binding. Migration does not copy legacy private bytes; a remote data transfer needs separate reviewed tooling/authorization. Original ignored local state is not deleted.

## Password sessions and OAuth

Password hashing remains salted PBKDF2-SHA256, 100,000 iterations. D1 stores hashes of opaque session tokens. HttpOnly/Strict host-only cookies are Secure on HTTPS and cleared with matching attributes at logout. Session revocation is checked in D1. API responses, including failures and redirects, are no-store. Forwarded host/origin headers are not authorization.

OAuth starts with an authenticated exact-Origin POST and configured provider/key. One-use hashed state is bound to a ten-minute narrowly scoped HttpOnly/Secure/Lax callback cookie, initiating student and active session hash. That cookie permits provider top-level GET callbacks while the main Strict cookie stays unchanged. Missing binding, replay, provider mismatch and revoked/expired sessions fail before exchange. PKCE protects redemption; redirects derive only from the configured canonical frontend origin.

AES-GCM uses fresh nonces and user/provider/purpose AAD for access/refresh tokens and verifiers. A backend-only 32-byte base64 key protects explicit ciphertext version v1. A D1 lease serializes refresh, preserves rotated refresh tokens and refuses to restore credentials after disconnect. Invalid/revoked credentials mark reconnect and wipe local tokens. Google revocation is attempted after local disconnect; Microsoft users additionally revoke app consent in their account. Key rotation/loss requires reviewed reconnect/re-encryption; automatic multi-key rotation is not claimed.

Google requests openid/email/gmail.send, plus optional gmail.readonly. Microsoft common-v2 PKCE requests User.Read/Mail.Send/offline_access and optional Mail.Read. No Mail.ReadWrite or application-wide mailbox permissions are requested. Verification, Testing expiry and tenant restrictions remain prerequisites, never bypassed. Secrets/provider payloads are not logged or sent to the browser; callback responses set no-referrer.

## Sending and recovery

No account selection means the preserved mock provider. Its receipt/audit/status transition remains one D1 transaction and excludes live transport rows; at most 20 mock messages per tick. The manual mock tick stays user-scoped.

Live tests require server flags, configured OAuth, a connected owned account, exact controlled-recipient allowlist matching, fixed content approval and per-message auto consent. The snapshot freezes recipient, account, body/subject and attachment IDs/checksums/names. Live files are bounded to three totaling 2 MiB.

Outbox states are waiting, leased, submitting, uncertain, confirmed, failed and cancelled. A conditional claim leases one worker. The final D1 fence rechecks message/account/controls/suppression before marking submitting. Expired pre-submit leases can be reclaimed; expired submitting leases become uncertain. At most three actual submissions for proven rejections use backoff/jitter and per-user/global quotas.

A timeout/network/5xx ambiguity is never treated as not sent. Gmail reconciles a stable RFC Message-ID; Graph reconciles a custom outreach key in recent Sent Items. Graph 202 is accepted-but-unconfirmed. Actual provider/thread IDs are stored on transport; delivery receipt uniqueness is scoped by sending account. Missing/ambiguous evidence stays uncertain, never blindly resent. This is not exactly-once network delivery. Pause/stop/cancel/disconnect cannot retract an already accepted request.

## Replies and follow-ups

Tracked threads are polled for 30 days with Graph cursors and provider event deduplication. Polls process one thread/one new event per cron phase (up to two threads in a manual check). Non-recipient senders are ignored except correlated delivery-status bounces. Valid delayed replies stop automation; decline/opt-out/bounce adds per-user suppression. Event, notification and state updates are transactional. Manual outcome recording handles out-of-thread bounces and explicit human opt-outs.

A unique parent constraint permits only one child. Its exact subject/body, 7–10-day interval, account/recipient/attachments need explicit consent and are displayed at review. The parent must be confirmed sent and eligible, with a fresh complete successful reply check. Failed/incomplete reads cannot arm a follow-up. Manual reminders remain separate. Known replies/outcomes, suppression, cancellation and disconnection stop automation.

This is not universal inbox/DSN parsing or semantic decline classification. Out-of-thread bounces, messages outside the window and uncertain receipts can require human review. A reply arriving after a check and an already accepted send cannot be retroactively prevented. Notifications are in Settings, not an external push/email service.

## AI

Mock templates remain independent. Optional Groq gets only bounded name/degree/university/interests fields, excluding IDs, email addresses, documents, tokens and database rows. It selects one of three audited template IDs; extra/model prose is rejected. It cannot introduce publication/funding/affiliation assertions. Groq requires an explicit student-confirmed official HTTPS source, recorded with the professor. This is human confirmation, not independent webpage verification.

D1 reserves conservative request/token budgets before calls and records reported tokens. Failed calls retain reservations. A manually confirmed Free account/model/key is required; no payment/upgrade API exists. Rate/key/quota/format failures fall back to editable templates, leaving manual mail usable. Unrestricted AI prose is intentionally not implemented.

## Scheduling, tests and remaining gaps

Minute cron always runs bounded mock jobs. Heavy work rotates across three resumable phases: replies/follow-ups; one live job; cleanup. Backlogs delay work. Dates stay UTC and existing timezone/DST UI conversion is preserved. Actual Cloudflare Free CPU/subrequest/storage fitness needs authorized production measurement; local success is not a guarantee.

Tests use real routes/migrations with SQLite/KV adapters, mocked provider HTTP, and a two-hop local proxy. A real local Worker smoke check exercises emulated D1/KV. Actual Vercel edge/cookies, provider consent/live mail and cloud CPU are pending external authorization. Existing gaps include verified identities, recovery/MFA, full signup abuse controls, malware scanning, operational retention/backups and public OAuth/privacy verification. No production certification or unlimited free outreach is claimed.

The single external setup/approval checklist is in [DEPLOYMENT.md](../DEPLOYMENT.md). No code/doc default authorizes a real email, paid subscription, remote migration, deployment or push.

Atomic professor imports use bounded JSON parameters in one INSERT plus audit, and batch approval uses set-based SQL. This preserves the 500-row import without exceeding the D1 Free per-invocation query budget. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Disabling LIVE_EMAIL_ENABLED stops new submissions/follow-ups, while configured OAuth can continue read-only reply checks and reconciliation of earlier uncertain outcomes. Set OAUTH_ENABLED=false to stop all mailbox-provider activity.
