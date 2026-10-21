# Architecture and Phase 2 plan

## Runtime boundaries

The Next.js frontend is a static App Router export and calls the Worker REST API with HttpOnly cookies. There are no Next.js server routes to deploy. The Worker owns authentication, authorization, private object access and all workflow state transitions. D1 is the source of truth. The R2 bucket is private. Mock AI returns a deterministic template personalized with the student's profile and professor's interests; it has no network dependency. The mock email provider is the atomic D1 delivery ledger.

## Database

`apps/api/migrations/0001_initial.sql` defines:

| Table | Role |
| --- | --- |
| users | Unique normalized email; salted PBKDF2-SHA256 password hash |
| sessions | SHA-256 hashes of opaque 256-bit random session tokens; seven-day expiry |
| profiles | Academic fields, default IANA timezone, pause/stop controls |
| professors | Student-owned shortlist, unique email per student |
| documents | Student-owned R2 object metadata; opaque per-user object keys |
| messages | Immutable submitted draft body/subject; mode, approval, authorization, UTC schedule and timezone, status and reminder |
| message_attachments | Document selection for each message, including composite owner foreign keys |
| deliveries | Mock provider receipt, unique message ID and provider ID |
| audit | Student-scoped account and workflow events |
| login_attempts | Hashed IP/email attempt counters; fifteen attempts per fifteen-minute window |

Composite foreign keys prevent attaching another student's document or targeting their professor even if a handler is later changed incorrectly. Each query scopes student resources to the authenticated session, and the API does not accept a user ID from the client. D1 batch transactions make related changes atomic. Message edits after submission are intentionally not exposed: cancel and create a replacement so approval always applies to fixed content.

States: `draft → pending → sent → replied`, with `draft/pending → cancelled` and `pending → failed`. Manual messages can be batch-approved; AI review drafts require individual approval. Auto authorization is per-message and recorded in audit, not a global checkbox. Creating a draft while stopped is allowed but dispatch stays blocked until resume; previously cancelled messages remain cancelled.

## Scheduling and duplicate prevention

Production cron runs each minute, selecting approved due messages whose owner's outreach is active. Local manual ticks are scoped to the current user. The mock provider inserts receipts with `INSERT OR IGNORE` into a ledger keyed by message ID, inserts corresponding audit entries, and updates pending messages to sent in the **same transaction**. Retries and overlapping invocations therefore produce one mock receipt. Pause, stop, cancel, approval, and dispatch serialize through SQLite transactions.

This guarantee applies to the mock provider only. SQL transactions cannot make a third-party network send atomic. Never replace the insert statement with a network call and claim exactly-once delivery.

## Current security boundaries and limitations

- Session tokens are stored hashed in D1 and delivered as HttpOnly, SameSite=Strict cookies, with Secure on HTTPS. Origin validation applies to mutations and CORS is limited to the configured frontend. Passwords use salted PBKDF2 with 100,000 iterations, compatible with Workers Web Crypto limits. Login/signup have server-side attempt counters.
- Private documents require a valid session and ownership check at download time; object keys never leave the API. Downloads use attachment disposition, no-store, and nosniff. Upload MIME and size allowlists are enforced; document content scanning is not implemented.
- No OAuth tokens, AI keys or real email credentials are stored in Phase 1. Environment templates contain no secrets. No external analytics is present.
- Authentication is local email/password with no email verification, recovery flow, MFA, breached-password detection or bot protection yet. The per-IP/email attempt counter is baseline throttling; add per-IP aggregate and signup abuse limits before a public rollout. Expired sessions/counters need scheduled cleanup. Password hashing settings should be re-evaluated with production security requirements and runtime constraints.
- Audit covers mutations and mock sends, not each read/download. It is a student-facing history rather than an externally immutable compliance ledger.
- Notifications are in-app reminder listings; no push/email notification service, mailbox ingestion, real reply detection, attachment deletion or professor editing is included. Status changes from cron appear on refresh. Browser QA is separate from API integration coverage.

## Phase 2 implementation order

1. **Production identity and storage:** add verified emails and password recovery (or a free-compatible identity provider), per-IP signup throttling/bot controls, session management, cleanup jobs, storage quotas, streaming request limits, malware scanning/quarantine, retention/deletion and encrypted backups. Review accessibility and add browser tests for critical workflows.
2. **Provider contracts:** introduce `EmailProvider` operations `createDraft`, `send`, `getSendStatus`, `listReplies` and `AIProvider.generateDraft`, returning normalized structured results. Keep mock adapters for tests. Never allow a request parameter to activate a live sender in Phase 1.
3. **OAuth:** implement Gmail API OAuth with PKCE/state, exact redirect allowlist, least-privilege scopes (`gmail.send`; incrementally request read access only for reply sync), and Microsoft Graph delegated `Mail.Send` plus incremental `Mail.Read` and `offline_access`. Check current provider requirements before shipping, including consent/verification restrictions. Provide disconnect and revocation. Do not store mailbox passwords.
4. **Token encryption:** envelope-encrypt refresh tokens using AES-GCM, random nonce per record and authenticated user/provider context; store only ciphertext, nonce and key version in D1. Keep master keys in Worker secrets, never in DB or client bundles. Define key rotation, revocation, scope tracking and access-token expiry. AI keys remain Worker secrets. Do not put credentials in logs/audit.
5. **Reliable real sends:** introduce an outbox with unique logical message/version key, immutable approved content+attachment digest, due UTC instant, attempts, lease token/expiry, provider message ID, and states `ready/leased/submitting/confirmed/uncertain/failed/cancelled`. Claim work atomically and recheck current controls immediately before submission. Use exponential backoff+jitter for proven pre-send transient errors. Persist a stable RFC Message-ID and a durable attempt record before the call. If the provider supports idempotency, use the stable key. For timeout-after-acceptance, mark uncertain and reconcile against the sent mailbox/provider draft ID; never blindly retry ambiguous submissions. Gmail and Graph must be evaluated separately; neither should be assumed to provide generic exactly-once send semantics. Stop/pause cannot retract a request already accepted by a remote provider; reflect that boundary in the UI.
6. **AI:** add Groq behind the provider interface, with configurable model, strict per-user quotas, timeout, validated output and manual/template fallback. Evaluate other providers' then-current free access, privacy terms and rate limits (for example Gemini or Cloudflare Workers AI) before selection. Send only relevant profile/research context, never documents by default. Save prompts/model/version for reproducible review without logging sensitive data unnecessarily.
7. **Reply ingestion and follow-ups:** use Gmail history / Graph change notifications or cursor-based polling; deduplicate inbound IDs and reconcile stale webhooks. Stop reminders on replies. Give each follow-up its own immutable message record and approval/authorization; reminders must not silently become sends. Add time-window limits, per-user daily budgets and provider quota handling.
8. **Operations:** deployment environments and secret management, migration rollback strategy, redacted structured logs, queue/dead-letter monitoring, job-lag alerts, public abuse controls, load and recovery tests. D1/Worker/R2 limits are configuration constraints; avoid requiring paid queue/AI plans for the first low-volume release.

Implementation references: [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports), [D1 database API and batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
