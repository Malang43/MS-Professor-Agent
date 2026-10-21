# MS Professor Outreach Agent

A multi-user student workspace using Next.js, TypeScript, Cloudflare Workers, D1 and private Workers KV storage. The existing application and same-origin Vercel API proxy are preserved. No card, R2 subscription or custom domain is required for the prepared default deployment. Cloud accounts still need authentication, eligible free plans and deployment approval.

**Default mode sends no real email and makes no AI calls.** Gmail and Microsoft Graph adapters, encrypted OAuth connections, a guarded live-test outbox and optional Groq integration are implemented and covered by mocked transport tests. They are disabled unless separately configured. A connected mailbox alone does not authorize live sending. Real sends additionally require a server-side controlled-recipient allowlist and explicit approval of the particular test.

## Account and workspace release

The application now includes named profiles, password visibility/strength guidance, email-verification and recovery adapters, session management, user-confirmed deletion, light/dark responsive UI, persisted dashboard metrics, private previews, professor editing and audited writing templates. See [the account/security release runbook](docs/STUDIO-RELEASE.md) for exact behavior, migration, free delivery setup and validation boundaries.

New accounts require genuine email verification. Transactional delivery is currently unconfigured; a pending account can sign in to manage security but cannot access the workspace. Existing accounts retain explicit legacy access without being marked email-verified. Gmail outreach is separate from transactional account email. The current owner production Groq settings are preserved; fresh-deployment defaults remain mocked.

## Local setup

Use Node.js **24 LTS** and npm. On Windows use `npm.cmd` when PowerShell blocks `npm.ps1`.

```sh
npm ci
npm run db:migrate
npm run dev:api
```

In another terminal:

```sh
npm run dev
```

Open http://localhost:3000 and create an account with first/last names and a unique password/passphrase of at least 15 characters. New local accounts also require verification; configure a local transactional test adapter in tests, or use the explicit isolated local smoke fixture described below. Use `localhost` consistently. There are no seed credentials. The API dev script uses the **local** Wrangler environment, local D1 and local KV. Its optional local R2 binding keeps legacy documents readable without enabling or contacting remote R2. Production configuration has only D1 and KV.

Copy `.env.example` to `apps/web/.env.local` only to override the development API URL. Worker development overrides belong in ignored `apps/api/.dev.vars`. Production browser requests/downloads always use relative `/api` URLs. Never put backend secrets in frontend variables. Local data lives in ignored `apps/api/.wrangler/`.

## Preserved workflow

1. Save the student profile and IANA timezone. Dates are entered in that timezone and stored as UTC; DST gaps are rejected.
2. Add professors manually or import CSV/XLSX, up to 500 rows / 5 MB. CSV headers are `name,email,university,interests`. Download the existing template. Information is student-supplied; use Confirm source for AI to record an official HTTPS source before Groq can use those facts. This is human confirmation, not independent webpage verification. Legacy XLS is unsupported.
3. Upload private PDF/DOCX/TXT files. The KV MVP limit is **2 MiB per file**, **10 active files / 20 MiB per student**, with **30-day expiry**. A new upload can take 60 seconds or longer to propagate; retry a temporary 503. Quotas and ownership are enforced in D1. Delete unused documents from the library; files in outstanding messages or armed follow-ups must first be cancelled. Delete hides access immediately; physical cleanup is retried.
4. Select the **mock mailbox** or, only after setup and controlled-test approval, an authorized connected account. Choose manual + batch approval, AI draft + individual review, or explicitly authorized auto mode. Edits clear consent. Submitted content, recipient, selected account and attachments are frozen for live delivery. Live attachments are limited to three totaling 2 MiB.
5. Preview/edit a draft before approval. Mock templates work without AI. Optional Groq selects from audited factual templates using only the supplied profile/professor fields; it cannot introduce a publication, funding claim or affiliation. This deliberately does not enable unrestricted AI prose. Rate/key/quota failures fall back to editable templates.
6. Run the mock scheduler manually or use deployed minute cron. Mock sent status is a simulation. Live test jobs are separately leased, quota-limited and reconciled when uncertain; Graph acceptance is not treated as a confirmed send. Review shows the transport state and provider message ID.
7. Record replies, declines, opt-outs or bounces. Connected accounts with read permission can poll correlated threads; notifications appear in Settings. Check replies now is user-scoped. Delayed replies stop optional follow-ups. Automated bounce classification only covers delivery-status reports in the correlated thread; record out-of-thread bounces manually. Detection is not a complete mailbox ingestion/DSN parser.
8. Optionally preauthorize **one exact follow-up**, 7-10 days after a confirmed live-test send, with exact subject/body and the same recipient/account/attachments. A recent successful complete reply check is mandatory. Known replies, declines, opt-outs, disconnection and cancellation stop it. It is off by default. Regular follow-up reminders and manual composition remain available.
9. Pause/resume/cancel/stop preserve existing behavior. No system can retract a provider request already accepted; uncertainty is retained rather than blindly resent. Retained messages are capped at 100 per student / 1000 globally to protect free storage; capacity errors require operator retention review, never an automatic upgrade. Sign into a second account to verify tenant isolation. Audit history remains student-scoped.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests exercise the actual routes and both SQL migrations with SQLite, in-memory KV, mocked provider HTTP and a two-hop local reverse proxy. Coverage includes identity/session revocation, CSRF, no-store responses, private files/deletion, quotas, eventual consistency/failure cleanup, tenant isolation, OAuth replay and encryption, refresh/revocation, send claiming/uncertainty, follow-up suppression and AI budgets. Tests block live provider network access. They are not live Gmail/Outlook or Vercel-edge certification.

For a real local Worker smoke check, keep the local API running and run `node scripts/smoke.mjs`. It creates synthetic test accounts/documents in local storage. `SMOKE_API_URL=http://localhost:8791/api` can select another local port; the script rejects non-local targets. It verifies real local D1/KV bindings, private upload/download/delete, user isolation, mock delivery and logout revocation.

## Deployment and manual setup

Read [DEPLOYMENT.md](DEPLOYMENT.md), including its **single manual setup checklist**, exact Vercel settings, Cloudflare setup order, OAuth registration details, safe secret configuration, no-card restrictions and production validation. No resources or deployments are authorized by documentation commands. Review before committing/pushing; Git hooks may auto-deploy.

The production API needs a Free Worker, D1 database, private KV namespace and a workers.dev endpoint. The frontend uses Vercel with root `apps/web` and `apps/web/vercel.json`; no purchased domain or Next.js Function is needed. Keep all no-store headers and the rewrite caching opt-out. Cloudflare Free CPU/request/storage limits must be measured after an authorized deployment; no unlimited usage is promised.

## Repository hygiene

The repository `Malang43/MS-Professor-Agent` is private. Never make it public, force-push or deploy without approval. `.gitignore` excludes all real `.env*`/`.dev.vars*` files, keys/credentials/token stores, databases, private uploads, Wrangler state, dependencies and generated output. Only the root `.env.example` is an allowed environment template and contains placeholders/comments/local URLs. SQL migrations and synthetic tests are source, not private database contents. Review `git status`, staged filenames and `git diff --cached` before committing; never force-add a secret.

## Architecture and limits

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries, transaction/consistency design, provider limitations and existing production-hardening gaps. Password recovery, email verification/MFA, full malware scanning, universal bounce/opt-out classification and live provider certification remain outside this readiness claim. Google verification and eligible Microsoft registration may block public integrations; do not bypass them or sign up for a card-based trial.

Local smoke: start Wrangler with --persist-to .wrangler/studio-readiness and set SMOKE_D1_PERSIST_PATH to that absolute directory, plus SMOKE_API_URL=http://localhost:8792/api when using port 8792. The smoke script never targets production.
