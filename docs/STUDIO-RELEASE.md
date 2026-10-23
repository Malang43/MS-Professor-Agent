# Research Studio release and operational readiness

## Scope

This extends the existing Next.js/Worker/D1/KV application. Gmail authorization, immutable OAuth state bindings, PKCE, encrypted credentials, imports, bounded private storage, audited approval modes and scheduling remain in place. Outlook code remains available, with activation still dependent on owner setup. No account, mailbox, file or message from production is deleted by migration or release verification.

The UI now uses a cohesive academic green/neutral design, light/dark themes, responsive navigation with reachable small-height logout, keyboard focus/dialog handling, password visibility controls, genuine-data metrics, upcoming work and notifications. Professor editing is owner-scoped and clears old source confirmation when facts change. CSV/XLSX import and duplicate handling remain intact. Private uploads show transfer progress; TXT previews render escaped text (64 KiB excerpt); PDFs/DOCX show metadata and download locally rather than execute inside the site. Existing attachment/approval/send controls are preserved. An optional CSV/XLSX draft-preparation toggle accepts at most 25 rows with exact subject/body/UTC schedule (professor-only imports still allow 500), saves unapproved manual mock drafts, skips matching drafts and reports partial quota failures. Existing one-time batch approval remains a separate explicit action after review; importing never enables live sending. Audited manual templates and professional/concise/warm tones never add invented professor facts.

## Account security

New signup requires first/last names, optional display name, unique email, matching passwords and notice acceptance. Signup returns the same response for existing and new addresses, with no signup session that could reveal account existence. Login establishes the existing host-only HttpOnly/Secure/SameSite=Strict session. New accounts can manage their identity/security and sign out, but cannot access workspace, documents, imports or OAuth until verified. Existing accounts retain explicit legacy access; this is shown as unverified, never falsely labeled email-verified.

Passwords use 15–128 characters for new/changed credentials, long-passphrase guidance and local common/repeated/guessable-password screening. This is not a complete breached-password corpus or an entropy guarantee. Existing hashes/passwords remain valid. PBKDF2-SHA256 remains at the existing 100,000 iterations, within the runtime's supported limit; this release does not weaken hashing or silently rewrite existing hashes. Stored hashes are compared without early character mismatch exit. Broader public-use hardening, a vetted breach corpus, MFA and platform CPU measurements remain follow-up work; personal deployment is not a public security certification.

Verification tokens contain 256 random bits, stored only as SHA-256 hashes, expire after 24 hours and are redeemed once via an exact-origin POST. Reset tokens expire after 30 minutes. Links use URL fragments, immediately cleared from browser history by the client; GET alone never redeems them. Invalid/expired/used links show a safe fixed response. Recovery responses do not reveal account existence. Recovery/resend budgets are 3/address/hour, 15/IP/hour and 100 globally/hour, using hashed identifiers; redemption is 30/IP/hour and password reauthentication 10/account/hour. Signup and login retain their existing limits. Hourly retry headers point to the actual next UTC hour.

Reset/change password revokes all sessions, pending OAuth states and recovery links. Logout-all revokes all sessions and pending consent flows. A regression exposed an old race where a callback could save credentials after session revocation during a network exchange: connection persistence now atomically requires the initiating session to still exist and be unexpired. Consent, callback cookies, PKCE and token exchange remain unchanged.

## Permanent deletion

Only an authenticated account holder can request deletion, after password reauthentication, typing DELETE MY ACCOUNT and confirming the browser prompt. No migration or QA script invokes real production deletion. One D1 transaction removes sessions, OAuth state/tokens, account tokens, messages, schedules/automation, attachments, provider events, connections, professors, document metadata, notifications, suppressions, AI records, user-scoped audit, profile and user. Queued activity cannot continue after deletion. A provider request already in flight cannot be recalled.

Opaque object keys, backend type, size, expiry and retry fields survive in account_deletion_objects for background cleanup. Access is unavailable immediately because authentication and owner metadata are gone. KV/R2-legacy physical deletion waits at least two minutes, retries hourly on failure and respects the existing global delete budget. No R2 service is activated; unavailable legacy R2 cleanup remains queued for an owner-managed private data plan. KV bytes remain conservatively reserved globally until their original TTL expires, even after a successful physical delete. Shared abuse/quota counters retain their normal cleanup period; external provider mail/consent records are outside application deletion. Gmail provider revocation is attempted after local access removal, with no redirects; unavailable revocation or Outlook consent removal requires the account holder to remove provider app consent manually. Provider secrets are never logged or retained in the cleanup queue.

## Transactional delivery: owner setup required

Production has no BREVO_API_KEY or verified transactional sender configured. Verification/reset delivery is therefore NOT operational. New accounts remain pending until genuine verification is possible. Existing accounts continue functioning. Do not mark new production users verified manually to bypass this dependency.

Brevo advertises a no-card Free plan with 300 emails/day. The Worker adapter uses its HTTPS API, independently of Gmail outreach. These official sources were checked during preparation:

- https://www.brevo.com/products/transactional-email/
- https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans
- https://developers.brevo.com/docs/send-a-transactional-email
- https://help.brevo.com/hc/en-us/articles/115000188150-Troubleshooting-Issues-with-Brevo-SMTP
- https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders

The owner must register/login, confirm Free/no card, verify an allowed sender and obtain an API key. Sender/domain compliance and account activation may block sending. Brevo documents temporary compliant-address rewriting for unauthenticated/free-email senders; this is not a guaranteed permanent substitute for domain authentication. Do not buy a domain, activate a trial or enter payment details to solve it. If no eligible sender is available, leave delivery disabled and report the blocker.

Only after sender eligibility and an authorized controlled-recipient delivery test, configure server-side MAIL_PROVIDER=brevo, MAIL_FREE_PLAN_CONFIRMED=true, MAIL_FROM=<verified sender>, BREVO_API_KEY=<secret>, and MAIL_DELIVERY_ENABLED=true. Set secrets interactively with Wrangler; never put them in frontend variables, Git or chat. No account or key was created by this assignment. Runtime configuration presence does not certify delivery: verify actual inbox receipt, verification, resend, expiration and password recovery before opening signup broadly. The tested adapter discards response bodies and logs only fixed failure categories; it does not retry uncertain sends automatically. No real transactional messages were sent by automated tests.

## Deployment and preservation

Keep the existing private GitHub repo, Vercel project/root apps/web, canonical https://ms-professor-agent-malang43.vercel.app and fixed /api rewrite. Node 24, install cd ../.. && npm ci, build npm run build, outside-root files enabled. Frontend headers add no-referrer, nosniff, frame denial, restricted browser capabilities and a self-only CSP with inline allowances required by the static Next.js export. API no-store/rewrite cache opt-out remain unchanged.

Apply 0003_account_security.sql before the new Worker. It only adds columns/tables/indexes and copies existing profile names into display names; it does not drop/reset existing data or modify passwords, credentials, quota counters or mailbox records. Do not roll back to pre-verification code after creating pending accounts: old code does not enforce the new verification gate. A rollback requires a reviewed compatible revision; do not drop the new schema or restore over production data.

Before release, read current remote non-secret flags and protected-binding metadata. Preserve the owner's actual production Groq configuration (AI_PROVIDER=groq, free confirmation true, configured model/key), Gmail secrets, encryption key and exact administrator allowlist; source defaults remain mocked/disabled for fresh deployments. Keep LIVE_EMAIL_ENABLED=false. Use a private ignored release config populated from current plain server vars with all credential bindings inherited unchanged, plus --keep-vars. Never print binding values or create paid resources. Worker deploy does not apply migrations automatically. Then push reviewed frontend changes to trigger the existing Vercel Git integration; verify deployment SHA, project alias and /api behavior. No duplicate project or domain purchase is required.

## Validation and honest boundaries

The release checks include real migrated SQLite/D1 SQL, mocked providers, multi-user isolation, verification/recovery, deletion graph and failed-KV cleanup, retained-byte budgets, OAuth session-revocation race, header/cache protections, existing scheduler/provider/outbox tests, local Workers runtime redirect tests, and Chromium desktop/mobile/dark/small-height workflows. Run:

```sh
npm run typecheck
npm test
npm run build
npm audit
node scripts/check-oauth-runtime.cjs
```

The isolated Wrangler smoke now requires SMOKE_D1_PERSIST_PATH matching its local dev --persist-to directory. scripts/smoke.mjs rejects non-local URLs and uses an explicit local SQL fixture to verify only synthetic local users; there is no verification-bypass HTTP endpoint.

Local Chromium testing uses only isolated SQLite/KV fixtures. It verifies signup/pending gate, login/logout, CSV import/edit, private upload/preview, profile editing, dark mode, mobile overflow, small-height logout and recovery forms. No real Gmail consent, OAuth exchange, outreach send, live transactional delivery or provider reply polling is performed by release QA. Existing Gmail connection/token aggregates are checked before/after release without reading plaintext credentials.

Groq is configured in the owner's current production Worker, unlike the repository's safe defaults. No secret value can be read back, and no verified owner browser session is available to exercise the existing authenticated AI route without credentials. Local Workers runtime/provider mocks can validate compatibility; actual configured-model invocation requires an owner-authenticated, verified-source draft and must not be falsely reported as tested. Do not disable source confirmation or verification guards to perform that test. Official model/free-limit references: https://console.groq.com/docs/models and https://console.groq.com/docs/rate-limits.

Remaining owner-dependent checks: transactional provider setup and real delivery certification; actual Groq draft on a confirmed professor source; manual confirmation of retained Gmail connectivity without automatic reconnection; provider-specific real-send/reply/follow-up certification only after separate named-recipient approval. Malware scanning, full breached-password screening, MFA, legal review and broad public-service operational readiness are not claimed by this personal free-tier release.

Release candidate validation: 136 automated tests passed, both workspace type checks and production build passed, full and production dependency audits reported zero known vulnerabilities. Local Chromium additionally exercised same-tab verification/reset confirmation and fragment clearing, optional spreadsheet draft deduplication and separate mock batch approval, without any real provider activity. The isolated local Wrangler smoke passed against all three migrations and D1/KV. Production release verification is reported separately with actual commit/version identifiers.

Production routing regression: the Vercel wildcard header rule applied to assets/API but not the static-export root document. An explicit source=/ rule now applies the same security headers to the root, covered by the configuration regression and verified through public production response checks. This does not change the API rewrite or canonical domain.

Final recipient-integrity regression: professor email changes are rejected atomically once outreach exists; use a new professor record for a different address. Live review/history rows use the frozen transport recipient rather than a mutable professor join. This prevents edit/create races from misrepresenting an already snapshotted live recipient and leaves all send/approval/tenant guards intact.


Updated transactional adapter, sender-verification configuration and activation instructions: [TRANSACTIONAL-EMAIL-RELEASE.md](TRANSACTIONAL-EMAIL-RELEASE.md). The newer MAIL_SENDER_VERIFIED=true operator attestation is also required.
