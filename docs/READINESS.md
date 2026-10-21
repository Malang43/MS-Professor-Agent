# Local readiness report - 2026-10-21

For the subsequent authorized mock production deployment, see [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md). The historical checks below describe the pre-deployment revision. This report describes the local revision containing it. No push, cloud resource creation, remote migration, deployment, paid subscription, domain purchase, live email or live AI request was performed.

## Implemented and locally verified

- Existing dashboard, local password sessions, academic profile, CSV/XLSX import, approvals, UTC/timezone scheduling, attachments, controls, mock delivery, reminders and audit remain in the existing app.
- Default production storage is private KV with D1 metadata/ownership, immutable keys, bounded file validation, per-user/global quotas, 30-day TTL, retryable eventual-consistency behavior and tombstoned/deferred deletion. Optional legacy R2 reads exist only where explicitly bound; default production has no R2 dependency.
- The same-origin Vercel rewrite, strict cookies, exact-origin mutation protection, no-store responses and no slash redirects are retained. Live versus mock consent/environment labels are explicit.
- Gmail/Graph adapters and PKCE OAuth use browser/session-bound one-use state, AES-GCM credentials, leased refresh/rotation, disconnect/reconnect handling and safe account selection.
- The outbox freezes approved recipient/content/account/files, claims/fences work, enforces budgets, reconciles uncertain sends without blind retries, tracks provider IDs/threads and processes bounded replies. A single separately preauthorized exact follow-up is capped at 7-10 days and blocked by known replies/outcomes/disconnection/cancellation or incomplete checks.
- Settings exposes connections, notifications, reply checks and recipient suppression. Review exposes transport state, follow-up content/cancellation and manual decline/opt-out/bounce outcomes.
- Optional Groq uses only bounded profile/professor facts after student-confirmed source attestation, selects audited templates and falls back safely. No independent professor fact verification or unrestricted model prose is claimed.

## Validation evidence

| Check | Result |
| --- | --- |
| Automated tests | 59 passed across 5 test files; real routes/migrations, strict D1 binding checks, KV fault/quota cases, mocked providers, and two-hop local HTTP proxy |
| Workspace TypeScript | API and frontend passed |
| Frontend production export | Passed; stale external API env value could not bypass same-origin routing; no localhost fallback/backend-secret references in exported JS/HTML; no generated redirects |
| Worker packaging | Local dry-run passed; default bundle has only DB/DOCUMENTS_KV and disabled OAuth/live/Groq flags |
| Actual local migrations | Both migrations applied to fresh isolated ignored Wrangler state; original 0001 migration unchanged |
| Actual local Worker smoke | Passed (including a native 500-row multi-byte atomic import): password auth, D1/KV persistence, private upload/download/delete, cross-user denial, logout revocation, mock dispatch and duplicate prevention |
| Actual local cron | HTTP 200 invocation against the isolated Worker |
| Dependency security | Full npm audit and production-only audit reported zero known vulnerabilities |
| Candidate secret/path audit | Passed; only safe root environment example, source/config/docs and synthetic test fixtures; no real credentials/private uploads/databases selected |
| Whitespace/original schema review | git diff --check passed; original migration unchanged |

Local test servers were stopped. Isolated synthetic test state stays ignored. Tests are not actual Vercel-edge/browser-cookie or Gmail/Outlook account certification, nor proof that production work fits Workers Free CPU limits.

## External blockers and deliberate limitations

Wrangler reports no authenticated Cloudflare account. No local Vercel CLI was found. D1/KV IDs, fixed Worker destination and exact canonical Vercel origin are still placeholders/local values. Cloud resources and remote deployment need account access and explicit approval.

No Google/Microsoft OAuth registration, consent, client secret, encryption key or Groq key/model was supplied. OAuth, live email and Groq remain disabled by default. Real tests need controlled accounts and separate approval naming addresses. Public Google restricted-scope verification/assessment and Microsoft tenant eligibility may block no-card public integrations; those requirements will not be bypassed.

Reply polling is bounded to tracked threads for 30 days. Automated bounce handling covers correlated delivery-status messages, not every out-of-thread DSN; manual outcome recording is provided. Graph confirmation looks at recent Sent Items, so absent evidence can remain uncertain. Cancellation cannot retract a provider-accepted request. Follow-ups do not run after failed/incomplete reply checks; a reply arriving after a completed check still has an unavoidable race with a subsequently accepted send.

KV can take more than a minute to propagate. Files expire after 30 days; no permanent/unlimited free library is promised. Application quotas protect free capacity and may require operator retention review; they never auto-delete history or enable paid storage. File signature checks are not antivirus. Existing recovery/MFA/verified-identity/operational hardening remains necessary before public use. Actual platform CPU/usage limits require measurement after an authorized deployment; password hashing was not weakened.

See the **single manual setup and production verification checklist** in [DEPLOYMENT.md](../DEPLOYMENT.md). The initial authorized deployment should keep OAuth/live/Groq flags off; optional provider consent and any particular live-email test are separate actions.

Atomic professor imports use bounded JSON parameters in one INSERT plus audit, and batch approval uses set-based SQL. This preserves the 500-row import without exceeding the D1 Free per-invocation query budget. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Disabling LIVE_EMAIL_ENABLED stops new submissions/follow-ups, while configured OAuth can continue read-only reply checks and reconciliation of earlier uncertain outcomes. Set OAUTH_ENABLED=false to stop all mailbox-provider activity.
