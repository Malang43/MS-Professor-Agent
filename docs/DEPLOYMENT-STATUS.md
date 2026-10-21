# Production deployment report — 2026-10-21

The owner explicitly approved browser authentication, pushing existing commit 1738da3, and deployment using verified no-card free resources. Workers Free was confirmed by the owner in the dashboard (100,000 requests/day); Vercel returned the Hobby plan. No billing upgrade, payment details, R2 activation, purchased domain, live email, mailbox OAuth connection, or Groq call was used.

## Live application

- Canonical frontend: https://ms-professor-agent-malang43.vercel.app
- Backend: https://ms-professor-outreach-api.aliraza57616.workers.dev
- API health through the frontend: https://ms-professor-agent-malang43.vercel.app/api/health
- Other Vercel aliases exist, but mutations are deliberately allowed only from the canonical frontend origin above. Use that URL to sign up and sign in.
- Private source: https://github.com/Malang43/MS-Professor-Agent
- GitHub branch `main`: `1738da31658df613e339d9388638a72ad1277777`, verified after push. No history rewrite or force push.

## Exact deployed resources and settings

Cloudflare account ID: `5e4d5e1addc6afa51f6bac3082d3c610`.

| Resource | Value |
| --- | --- |
| Worker | `ms-professor-outreach-api` |
| Worker version | `76f5fd9f-6458-48b7-a8f0-48c31c41ffd9` |
| D1 binding/database | `DB` / `outreach` |
| D1 ID | `684cb48c-3f43-4cef-8217-cf9624d23522` |
| KV binding | `DOCUMENTS_KV` |
| KV ID | `522d30d6935741b0b659d92b3136ec8c` |
| Migrations | `0001_initial.sql` and `0002_storage_integrations.sql`, both applied successfully |
| Cron | Every minute; live providers remain disabled |
| APP_ORIGIN | `https://ms-professor-agent-malang43.vercel.app` |
| Provider flags | `OAUTH_ENABLED=false`, `LIVE_EMAIL_ENABLED=false`, `AI_PROVIDER=mock`, `GROQ_FREE_PLAN_CONFIRMED=false` |

No provider credentials or token-encryption secret were installed. Remote bindings were independently read back: D1, KV, and the disabled flags only. The local Wrangler environment retains an emulator-only R2 binding; it was not deployed.

Vercel identity is `malang43`, scope `m-farhat-mehdi` (display name M Farhat Mehdi), plan **Hobby**. Project `ms-professor-agent`, ID `prj_NqYFPzBcd3g9wiIq0EK6XqDgDgKM`; production deployment `dpl_4nMAXdwaTCi2XNeBxSexYmS7kXQR` is READY.

- Root: `apps/web`; framework Next.js; Node 24.x.
- Include files outside root: enabled.
- Install: `cd ../.. && npm ci`.
- Build: `npm run build` from the frontend root.
- Output Directory: **framework default / override off** (`null`), even though static export generates `out`. Setting the Vercel Next.js override to `out` failed with NEXT_NO_ROUTES_MANIFEST.
- Rewrite: `/api/:path*` to `https://ms-professor-outreach-api.aliraza57616.workers.dev/api/:path*`.
- No frontend API environment variable or backend secret is required.
- API response headers retain private/no-store and rewrite cache opt-out.
- Deployment used the authenticated CLI. Git auto-deployment has not been connected for this new project.

## Verification

Final local checks: **59 tests passed**, API and frontend TypeScript checks passed, and production build passed. The successful Vercel build also compiled and passed TypeScript.

Real Chromium checks on the canonical production origin passed:

1. Same-origin `/api/health`: mock provider, KV storage, live_email false.
2. Browser signup and authenticated dashboard.
3. Session cookie is host-only, HttpOnly, Secure, SameSite=Strict, Path=/.
4. Browser CSV professor import with synthetic data.
5. Browser private TXT upload and owner download with identical bytes and safe attachment disposition.
6. Two-account isolation: another account receives document 404 and sees neither the owner's documents nor imported professors.
7. Foreign, null and missing Origin mutations return 403.
8. Browser document deletion immediately makes owner access return 404.
9. Authenticated dashboard survives refresh.
10. Browser logout clears the cookie; replaying the revoked session returns 401.
11. Password login succeeds again.
12. All 17 observed browser API responses remained on the canonical Vercel origin with no-store and no Vercel HIT/STALE. No browser runtime errors occurred.

No real email or automatic professor outreach was exercised. Synthetic example.invalid users/professors were used; QA accounts and audit metadata remain in D1, while uploaded QA documents were tombstoned for normal cleanup. Browser passwords/cookies were kept in process memory and were not logged or committed.

## Failed checks and fixes

- Initial Vercel build passed compilation but failed because Output Directory was overridden to `out`; restoring framework default fixed it.
- An attempted upload allowlist excluded the root directory; it was replaced with explicit exclusions and the next build succeeded.
- The first failed CLI upload included local Wrangler state, including SQLite files. That deployment was deleted successfully. It did not become a live site. `.vercelignore` now excludes Wrangler state, local databases, environment files, caches and credential locations. The successful deployment's uploaded file list was audited: **40 source files, zero flagged environment/credential/database/Wrangler-state paths**. Do not rely on `.gitignore` alone for Vercel CLI uploads.
- At the initial 1280×720 automation viewport the sidebar Sign out button was outside the visible viewport. Full authentication checks passed at 1440×1200. Small-height/responsive sidebar usability remains a layout follow-up; application layout was not redesigned during deployment.

## Remaining actions

1. Use the canonical frontend URL above; other aliases intentionally fail production mutation origin checks.
2. Review the local production configuration changes, `.vercelignore`, and this documentation before authorizing a new commit/push. Only the explicitly approved existing commit 1738da3 was pushed. Current production includes these local deployment configuration changes.
3. If automatic GitHub deployments are desired, first commit/push the reviewed production configuration, then connect this Vercel project to the existing PRIVATE repository with root `apps/web` and production branch `main`. Do not deploy the placeholder configuration still on GitHub as-is.
4. Check the small-height sidebar layout before broader usage. Optional removal of synthetic QA accounts must target those accounts only.
5. Monitor finite Workers/D1/KV quotas on the free plans. KV uploads expire after 30 days and may briefly require retry because of eventual consistency. No unlimited usage or paid fallback is configured.
6. Leave all provider flags disabled. Gmail/Outlook registrations, credentials, Groq setup, and any live sending require separate future authorization. No such setup is needed for the deployed mock application.

This is a mock development deployment, not live email/AI certification or broad public-service readiness.