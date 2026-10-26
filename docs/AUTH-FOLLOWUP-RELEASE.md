# Authentication and follow-up release — October 26, 2026

Production: https://ms-professor-agent-malang43.vercel.app/

## Production investigation

Read-only D1 evidence identifies an initial-only approval, rather than a broken authorized schedule. Irshad's message `b9f7968b-e210-4f1e-b423-914788915161` is confirmed sent at `2026-10-26T16:04:45.637Z`; its immutable authorization has `followup_authorized=0`, a null approved follow-up, and its campaign has `followup_count=0`. The imported one-day subject/body are retained as a proposal, with no automation row. The hypothetical due time is October 27, 2026, 21:04:45.637 Asia/Karachi. It will not send without a separate explicit approval.

Talat's message `1bc4043f-4068-4589-af36-b3ac9c62ac8e` is confirmed sent at `2026-10-26T16:01:48.344Z` and its current status is `replied`. Its campaign also approved initial emails only. No follow-up was activated for either recipient, and neither initial message was resent.

## Implementation

- An explicit review button approves the exact inactive follow-up separately, retaining original campaign/authorization records. Due times derive from confirmed initial sending. Changed proposals, replies, suppression, missing reply access, and incomplete mailbox checks block approval. Approval does not resend the initial email.
- Follow-up delivery performs another complete provider reply check after token/attachment preparation, with a final database fence against a replied parent. Existing unique jobs, leases, uncertain-outcome reconciliation, quotas, cancellation and retry rules remain.
- Optional standards-based WebAuthn through SimpleWebAuthn supports multiple named resident passkeys, verified registration/login, removal with password reauthentication, and passkey-based password recovery. Origin/RP ID come exclusively from APP_ORIGIN. Challenges expire in five minutes and are atomically consumed. User verification is mandatory. Ordinary password login remains.
- Ten 128-bit recovery codes are displayed once and can be downloaded. Only SHA-256 hashes are stored. Generation requires password reauthentication and replaces prior codes. Redemption/password replacement/session revocation share a D1 transaction. Recovery endpoints apply IP, global and address limits with generic account/code errors.
- Turnstile uses managed widgets, hostname/action/age validation, server-side Siteverify, single-use validation and a D1 replay fence. Signup rate limits remain. Keys alone do not activate enforcement: TURNSTILE_ENABLED must also be true. Cloudflare secret material remains in secret_text storage.
- Labels distinguish confirmed Gmail delivery from simulation, display Email Not Verified, describe separately approved due times and reply cancellation, and provide mobile-friendly security setup/recovery flows.
- Zod and compatible tool dependencies are security-patched. Import validation uses Zod 4's explicit record key/value schema.

## Migration and preservation

Migration 0007 adds recovery_codes, passkeys, auth_challenges and followup_approvals. Existing campaign approvals, scopes, historical deliveries, Gmail credentials and accounts are not rewritten. Original follow-up audit remains immutable. The automation insert guard accepts only the exact separately approved rule when initial approval excluded follow-ups. Existing account deletion also cleans enrolled security options. Private production verification retains aggregate SHA-256 fingerprints rather than storing sensitive database rows.

## Verification and pending configuration

Automated checks cover cryptographically signed synthetic WebAuthn responses, wrong origin, absent user verification, replay/expiry, passkey isolation/removal, concurrent single-use recovery, account cleanup, mail-disabled signup, Turnstile failure/replay, exact separate follow-up approval, immutable original approval preservation, replies, due times and duplicate queueing. Existing campaign/provider/session/isolation tests remain.

Native Workers runtime checks exercise real WebAuthn cryptography and intercepted Turnstile Siteverify, plus Gmail send/threading/reply/profile/token HTTP. Local Chromium checks use an isolated database and virtual authenticator; no production account or real email is created.

A managed Cloudflare widget was created for `ms-professor-agent-malang43.vercel.app` and its secret installed directly into the existing Worker. A genuine automated browser challenge timed out; production enforcement remains disabled. Do not claim bot protection active until a genuine challenge passes Siteverify. No Mailjet activation is authorized; transactional sending stays disabled.

Automatic approval review rejected changing the existing workspace verification gate, including an explicit dashboard/profile/professor/private-document route allowlist. The user was asked for explicit approval of that scope. Until approved, new accounts can register and sign in but remain workspace-gated; pending accounts are preserved. This requested registration-access change is not represented as completed.

Deployment identifiers and final check counts are recorded after release.
