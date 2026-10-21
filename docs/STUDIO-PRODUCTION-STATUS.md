# Research Studio production verification

## Released revisions

- Application/security implementation: GitHub main commit `81b206ab2f62edbcb54b700559ec0a4e34731a39`.
- Root security-header follow-up: `98d2e45e8e0cee9054502e55d07dae0dd654b8bf`.
- Recipient-integrity safety follow-up: `f0825264b4d33b38176bc3e8aba1866bd535772c`.
- Cloudflare Worker version: `b1b7a3fe-90aa-4ed0-8718-8b6c8d04d08f`, verified active at 100%.
- Worker SHA-256: `ad3e15173af9388f504dcd3ae102736a218dae1b7c0e624f0923c67f1414146e`; downloaded production module matched the prepared artifact exactly.
- Vercel application deployment: `dpl_CvtkGTQza2AvPNMj26sqrAmRQVvH`; root-header follow-up `dpl_6zsbhmc3ue9gfJkcBanRbVuUEMGf`, READY/PROMOTED, source Git, commit `98d2e45e8e0cee9054502e55d07dae0dd654b8bf`.
- Vercel safety follow-up: `dpl_82KaynbP4s4QHspdwKj7ifyhP6v1`, READY, Git commit `f0825264b4d33b38176bc3e8aba1866bd535772c`; frontend files are unchanged by this backend-only patch.
- Canonical live URL: https://ms-professor-agent-malang43.vercel.app
- Existing Worker endpoint: https://ms-professor-outreach-api.aliraza57616.workers.dev
- Source repository remains PRIVATE: https://github.com/Malang43/MS-Professor-Agent

This report may be committed after the application release; documentation-only commits do not alter the verified application source. The final session report supplies the resulting GitHub head and any subsequent Vercel documentation build identifier.

## Verified checks

| Check                         | Result                                                                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated suite               | 136 passed, including all pre-existing suites                                                                                                                                                                                                                                      |
| TypeScript / production build | Both workspaces and Next.js export passed                                                                                                                                                                                                                                          |
| Dependency audits             | Full and production audits: zero known vulnerabilities                                                                                                                                                                                                                             |
| Workers runtime               | Offline synthetic exchange succeeds; 301/302/303/307/308 rejected without following; no Google OAuth calls                                                                                                                                                                         |
| Additive migration            | 0003 applied; users/passwords/mailboxes preserved; all existing users retain explicit legacy access                                                                                                                                                                                |
| Production preservation       | User/document/mailbox counts and encrypted-token byte aggregate unchanged before QA; one connected Gmail account retained; no plaintext tokens read                                                                                                                                |
| Production bindings           | Original binding metadata and plain flags matched baseline; Google credentials, encryption key, administrator allowlist and existing Groq model/configuration retained                                                                                                             |
| Sending / delivery            | LIVE_EMAIL_ENABLED=false; transactional delivery explicitly disabled; no paid service or domain/R2 activation                                                                                                                                                                      |
| Local real Worker smoke       | D1 persistence, private KV upload/download/deletion, isolation, revoked sessions, mock dispatch and duplicate prevention passed                                                                                                                                                    |
| Local Chromium                | Signup/login, verification/reset token POST redemption, history clearing, names/profile editing, CSV import/edit, optional draft deduplication and explicit mock batch approval, private upload/preview, dark mode, mobile overflow, small-height logout and recovery forms passed |
| Production Chromium           | Signup/login, pending verification gate, disabled-delivery disclosure, host-only HttpOnly/Secure/Strict session, profile edit, mobile layout, logout-all, revoked-session 401, logout, generic recovery and CSP passed                                                             |
| Production routes             | Direct Worker/canonical /api health 200; no-store; unauthorized identity/state 401; foreign Origin 403                                                                                                                                                                             |
| Vercel Git integration        | Private GitHub pushes automatically created and promoted production deployments in the existing project                                                                                                                                                                            |
| Canonical/alternate domains   | Canonical unchanged; alternate retains its configured permanent 308 redirect                                                                                                                                                                                                       |

One synthetic pending production QA account was created and retained. It was signed out and its previous session was proven revoked. No real production account was deleted, and no verification flag was bypassed in production. Its credentials are stored only in ignored local QA state for owner-managed cleanup. Local verified fixtures never create a public bypass endpoint.

The initial Worker upload failed and the controlled retry succeeded. The first Git frontend deployment omitted headers only on the root document; assets and API had them. An explicit root header rule was added and production response/browser checks passed after promotion. No authentication/origin guards were relaxed to solve either issue.

## Remaining owner-dependent work

1. **Transactional verification/reset delivery is not operational.** Configure an eligible no-card Brevo Free account, allowed verified sender and backend API key as described in [STUDIO-RELEASE.md](STUDIO-RELEASE.md). Sender/account eligibility may require owner verification. Do not purchase a domain or enter payment details. Until real controlled-recipient delivery is certified, new accounts remain gated; existing legacy accounts continue working.
2. **Real Groq generation is not certified by this release.** Current production AI_PROVIDER=groq, the free confirmation flag, configured model and protected key were preserved. Actual key/model invocation requires the owner's authenticated workspace and a professor source explicitly confirmed by that owner. Local adapter/runtime tests use mocks; no automatic Groq call was made during QA. A safe owner check is to compose in review mode for a source-confirmed professor and click Generate, then inspect/edit the draft without approving or sending it.
3. **Gmail connection metadata was preserved, not reauthenticated.** The owner can confirm the existing connection in Settings without reconnecting. No Google consent/token-exchange attempt, real send, provider reply-polling test or outreach was initiated by release verification. Real sending still needs separately authorized controlled addresses and existing server allowlist/approval safeguards.
4. **Authenticated production workspace QA:** the new synthetic account correctly could not access imports/documents/outreach before verification. Those workflows passed locally with actual migrations and isolated Worker/D1/KV, including multi-user tests; this release does not claim an owner-session production retest of those protected features.
5. Broader public readiness still requires malware scanning, stronger breached-password coverage, MFA, legal/privacy review and actual platform CPU/quota monitoring. The personal free-tier application is not an unlimited public-service or live-email certification.

See [the release/security runbook](STUDIO-RELEASE.md) and [deployment instructions](../DEPLOYMENT.md) for configuration, retention, rollback and no-card boundaries.

Final safety follow-up additionally proves that professor edits cannot change recipient addresses once outreach exists, and that live review/history always displays the immutable transport recipient even for legacy/racing professor changes. No new schema or counter reset was required. The final Worker artifact/configuration/data-preservation and health checks passed after this patch.
