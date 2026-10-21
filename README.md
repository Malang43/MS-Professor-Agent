# MS Professor Outreach Agent — Phase 1

A multi-user student workspace built with Next.js, TypeScript, Tailwind, Cloudflare Workers, D1 and private R2 storage. Email delivery and AI drafting are **mock only**. There is no SMTP transport, real mailbox connection, or external AI call in this release.

## Local setup

Use Node.js **24 LTS** (tests use Node's built-in SQLite) and npm. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`.

```sh
npm ci
npm run db:migrate
npm run dev:api
```

In a second terminal:

```sh
npm run dev
```

Open http://localhost:3000 and create a student account with a password of at least 12 characters. No seed accounts or credentials are installed. Wrangler emulates D1 and R2 locally, so no Cloudflare account or payment details are needed for local use. Data persists under `apps/api/.wrangler/`; do not commit that directory.

Environment defaults already work locally. To override the API URL, copy `.env.example` to **apps/web/.env.local** and set `NEXT_PUBLIC_API_URL`. To override the allowed web origin, create **apps/api/.dev.vars** with `APP_ORIGIN=http://localhost:3000`. Use `localhost` consistently in both URLs so the session cookie works. Restart servers after changing configuration.

## Try the complete workflow

1. Save your name, university, degree, GPA, research interests and IANA timezone in Academic profile.
2. Add professors manually or import CSV / `.xlsx`. Download the template in Professors. Headers: `name,email,university,interests`; the first two are required. Import is atomic, limited to 500 rows / 5 MB, and skips duplicate email addresses within your own account. Legacy `.xls` is not supported.
3. Upload private PDF, DOCX or TXT documents, up to 10 MB each. Files are served as authenticated downloads, never public URLs.
4. Compose an email, select a professor and attachments, and choose a workflow:
   - **A / Manual:** write an email and save a draft. Select multiple manual drafts in Outreach and approve together, or review individually.
   - **B / AI review:** generate a mock draft, edit it, save it, open Review, and approve that exact email individually. Server validation rejects AI batch approval.
   - **C / Authorized auto:** generate or edit the draft and explicitly check the authorization for this particular email. Saving places it directly in the approved queue. Edits clear the authorization checkbox.
5. The schedule is entered as wall-clock time in the selected IANA zone and stored in UTC with the zone alongside it. Nonexistent DST times are rejected; ambiguous repeated hours choose one valid occurrence. Review shows UTC for confirmation. Past times are immediately eligible.
6. In local development, use **Run mock scheduler** in Outreach to process due approved messages. Deployed Workers also use the minute cron. A mock sent status is a durable simulation record, not evidence of an actual email delivery.
7. For a sent message, record a reply manually or set a follow-up reminder. Follow-ups shows upcoming/due reminders; the bell opens that view. Reminders do not send follow-up emails or push notifications. Reload or perform an action to refresh status after a cron tick.
   Use **Simulate failure** on a pending message to exercise failed status without contacting a provider.
8. Pause prevents new deliveries while preserving pending messages; resume restarts processing. Cancel affects one outstanding message. Stop cancels all your outstanding drafts and scheduled messages. Resume does not resurrect cancelled messages.
9. Sign out and create a second account to verify the separate workspace. Audit history records each account's activity.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests execute real application routes and the actual migration/SQL against an in-memory SQLite database. Cloudflare's D1 transport is adapted to SQLite and R2 is represented by an in-memory private bucket. Tests cover identity, password checking, session revocation, tenant isolation, private downloads, attachment ownership, import deduplication, manual/AI approvals, authorization, due times, duplicate prevention, controls, follow-ups, replies and mock drafting. GitHub Actions runs the same checks on Node 24. The Next.js production export is generated in `apps/web/out/`.

Timezone tests additionally cover DST gaps/overlaps and date-specific offsets. For an optional real local Worker smoke check, keep `npm run dev:api` running and execute `node scripts/smoke.mjs`. It tests local D1 and R2 bindings and creates one isolated, randomly named smoke account in your ignored local database.

## Private GitHub handoff

Nothing is pushed or deployed by local setup or verification. After explicitly authorizing publication, create an empty **Private** GitHub repository named `MS-Professor-Agent` in your account. Do not initialize it with a README, license or gitignore. Then run:

```sh
git remote add origin https://github.com/YOUR_USERNAME/MS-Professor-Agent.git
git remote -v
git push -u origin main
```

Replace `YOUR_USERNAME` with your account. Confirm repository visibility is **Private** before pushing. Use Git credential manager or SSH authentication; never put tokens in remote URLs. GitHub Actions only runs checks and has no deployment steps.

Before committing, review `git status --short --untracked-files=all`, `git diff --cached --stat` and `git diff --cached`. Only the root `.env.example` is allowed as an environment template; it contains local example URLs and comments only. Put real environment values in ignored `.env*` or `.dev.vars*` files. `NEXT_PUBLIC_` values are public browser configuration and must never contain secrets.

Ignore rules exclude Wrangler state (local D1 databases and private R2 blobs), database backups, credential/token files, private upload directories, PDF/Word/Excel documents, logs, dependencies and build output. Keep private TXT/CSV documents inside ignored `uploads/` or `private-documents/` directories, away from source and public assets. The committed professor CSV is an import template. Ignore rules are filename safeguards: review file contents for secrets and personal data, and never force-add sensitive files. SQL schema migrations remain versioned.

## Repository

```text
apps/web/                 Next.js App Router dashboard; static export
apps/api/src/             Cloudflare Worker REST API and scheduled handler
apps/api/migrations/      D1 schema migrations
apps/api/tests/           SQLite-backed API integration tests
docs/ARCHITECTURE.md      data model, security and Phase 2 design
.github/workflows/ci.yml  automated verification
.env.example             environment template
```

## Cloudflare configuration (optional; not needed locally)

Create a D1 database and private R2 bucket, then replace the placeholder database ID and bucket name in `apps/api/wrangler.jsonc`. Keep R2 public access disabled. Apply migrations with `npx wrangler d1 migrations apply outreach --remote` from `apps/api`. Deploy the API using Wrangler and host the static Next.js export with Cloudflare Pages or another static host. Set `NEXT_PUBLIC_API_URL` **before building** and `APP_ORIGIN` to the exact HTTPS frontend origin. Use same-site custom domains (for example `app.example.com` and `api.example.com`) because cookies use SameSite=Strict; unrelated host domains require a revised auth/proxy design. No deployment has been performed by this repository setup.

Workers, D1 and static hosting are intended to fit small free-tier workloads. R2 availability, account activation requirements and service quotas must be checked with your Cloudflare account before enabling production infrastructure; no paid feature is required by the local application. Treat this as a functional Phase 1 implementation, not a production-readiness certification.

## Phase 2

See [architecture and implementation plan](docs/ARCHITECTURE.md). Next work: production authentication hardening, Gmail / Microsoft OAuth, encrypted token storage, reliable real-provider outbox with reconciliation, Groq/provider adapters, mailbox reply synchronization, document malware scanning, operational alerts, and browser/end-to-end tests. No live provider credentials should be configured for Phase 1.
