# Transactional account email release

The account-mail code is implemented and tested, but real delivery is **not activated or certified**. Production has no `BREVO_API_KEY` secret or `MAIL_FROM` sender. Its existing `MAIL_DELIVERY_ENABLED=false`, `MAIL_PROVIDER=disabled` and `MAIL_FREE_PLAN_CONFIRMED=false` remain unchanged. No verification bypass, account deletion, automatic verification or new professor email is part of this release.

## Provider decision (checked 2026-10-23)

Use the existing **Brevo HTTPS API** integration. The Free plan advertises 300 sends/day, no card and no expiration. The application caps all account mail types together at 250 attempts/day, leaving headroom; other workloads in the same Brevo account still share its allowance. Existing recovery/resend limits additionally apply per address, IP and hour. No paid service is enabled.

- [Brevo Free plan](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)
- [Sender verification](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email)
- [Transactional activation requirements](https://help.brevo.com/hc/en-us/articles/115000188150-Troubleshooting-Issues-with-Brevo-SMTP)
- [Domain authentication and free-address rewriting](https://help.brevo.com/hc/en-us/articles/16045394674066-Troubleshooting-Domain-authentication)
- [HTTPS transactional API](https://developers.brevo.com/reference/send-transac-email)

A purchased domain is not assumed necessary: Brevo documents temporary provider-domain rewriting for unauthenticated/free-email senders. This does not guarantee account eligibility, permanent availability or inbox delivery. Confirm that Brevo accepts the individually verified sender and activates transactional sending for this account. If it requires a custom domain, use an already-owned domain with its DNS records; otherwise stop and report the blocker. The Vercel `vercel.app` domain cannot be authenticated as an owner-controlled sending domain.

Resend's default sender is [restricted to the account owner's own inbox](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain); arbitrary-user sending requires an authenticated domain. [MailerSend pricing](https://www.mailersend.com/pricing) distinguishes the trial domain from production and includes a credit-card requirement for its Free plan. Neither solves the stated no-card/no-purchased-domain requirement more directly than Brevo.

## Minimal owner setup

1. Create/sign in to a **Brevo Free** account. Confirm no card, trial or paid add-on. Complete identity/email checks and request transactional account activation if required. Describe verification and password recovery for this academic application, not marketing campaigns.
2. In **Settings > Senders, Domains & Dedicated IPs > Senders**, add **MS Professor Agent** with an inbox you own. Enter the verification code received there. Confirm the sender is active and the provider permits its domain/rewrite configuration. Never impersonate the Vercel domain. If available, authenticate an existing domain using Brevo's exact DNS records.
3. In **SMTP & API > API Keys**, create an API key (not an SMTP password). Install it privately from the repository root:

   ```powershell
   node node_modules/wrangler/bin/wrangler.js secret put BREVO_API_KEY --config apps/api/.wrangler/account-mail-release-config.json
   ```

   Paste only into Wrangler's secure prompt. Never paste it into chat, Git, a screenshot or a `NEXT_PUBLIC_` setting. The ignored release configuration is generated from the current Worker settings; regenerate it before any later release so newer settings are preserved.
4. While application transactional delivery is still disabled, use Brevo's authenticated **Send a transactional email** API tester to send one branded account-delivery probe from that verified sender to an inbox you own. Include a button and text fallback to `https://ms-professor-agent-malang43.vercel.app/` (no real token). Confirm API acceptance, provider log and actual inbox receipt, including the rewritten From address if applicable. An API success alone does not certify inbox delivery. Do not send probes to professors or arbitrary addresses.
5. After the sender, Free plan, key and owner inbox delivery are confirmed, set only these server variables in the freshly captured ignored release configuration:

   ```text
   MAIL_PROVIDER=brevo
   MAIL_FROM=<exact verified sender email>
   MAIL_FREE_PLAN_CONFIRMED=true
   MAIL_SENDER_VERIFIED=true
   MAIL_DELIVERY_ENABLED=true
   ```

   Deploy the tested Worker using that configuration. Do not replace any other current variable, secret, binding or outreach setting. `MAIL_SENDER_VERIFIED` is an operator attestation, not an automated provider/domain validation or proof of inbox delivery. Keep delivery disabled until these checks are complete.
6. Certify both flows with an owner-controlled new account: signup -> actual verification inbox receipt -> open link -> confirm -> private workspace/profile Verified. Sign out, request Forgot Password -> actual reset inbox receipt -> set new password -> receive reset confirmation -> sign in with new password; old password, old sessions and reused links must fail. Check resend for an existing pending owner-controlled account. Do not create or verify accounts belonging to other people. Report actual results and provider IDs privately. If anything fails, disable only `MAIL_DELIVERY_ENABLED` and investigate; preserve Gmail outreach flags.

These owner-only provider/account/key/inbox steps are the remaining activation blocker. This release does not claim them complete.

## Implemented behavior and security

Signup, authenticated resend and forgot-password use the existing adapter. Branded HTML and plain-text alternatives include the app name, clear subjects, secure buttons, expiration and fallback links. Password reset sends a separate security notification without a password or token. Account email changes are not supported by the existing application and have not been introduced.

Verification tokens expire after 24 hours; reset tokens after 30 minutes. Only hashes are stored. Links use the canonical HTTPS application origin and URL fragments, cleared by the existing UI before submission, keeping tokens out of HTTP request URLs and referrers. No GET consumes a token. Exact-origin CSRF, authenticated ownership, workspace gating, generic duplicate/unknown-account responses, rate limits, already-verified resend behavior and session protections are preserved.

Token redemption, verification/password mutation, session/OAuth-state revocation and related token deletion occur in one D1 batch transaction. A database failure rolls everything back; concurrent redemption succeeds at most once. Definite provider rejection removes its unusable token. Ambiguous network outcomes retain the expiring token without automatic retries, so an accepted-but-timed-out email can still be used and is not blindly duplicated. A user can request a new rate-limited link. Notification failure does not undo a successful password reset. Logs use fixed categories only, never provider bodies, addresses, passwords, credentials or links.

## Verification

**211 automated tests passed across 12 files**. Both workspace TypeScript checks and production build passed. Coverage includes signup, expiry/reuse, resend, existing pending users, reset and session revocation, password-reset notifications, provider rejection/timeout, rollback recovery, rate limiting and multi-user isolation. The native Workers Gmail HTTP regression and isolated Chromium Excel/one-time campaign approval/archive/delete regression also passed, with no real mail sent.

No schema migration or infrastructure creation is needed. Current production settings and account/document/connection/delivery/history fingerprints were captured read-only before deployment and are checked afterward. Live delivery remains blocked pending owner setup and genuine inbox certification.

## Deployed result

Source commit `b8bdadb` is pushed to the existing private repository. Existing Worker version `6f9a747d-9a7d-4675-98b0-7c7d14bd0b36` serves the tested bundle, SHA-256 `1b495236a11878b633388e6b8bbe44427f2662f97baa53593180b086e9c83ce8`. No migration or new infrastructure was required. The unchanged Vercel frontend was verified through its canonical URL; no frontend redeployment was necessary for this backend-only change. Direct and proxied health, no-store, authentication, foreign-origin rejection, XLSX bytes and CSV content (Windows line endings normalized) passed.

Post-deployment account/document/connection, successful delivery/reply history, provider/thread identifiers, all variable/credential bindings, Groq and owner activation fingerprints match the captured baseline. Actual Gmail deliveries remain two and detected replies remain one. Transactional delivery remains disabled with no Brevo secret or sender configured. No new real email was sent. Production dependency audit reports zero vulnerabilities. Focused isolated browser verification/reset-link confirmation, URL fragment clearing and login with the new password also passed. An older broad browser fixture had a stale import-status text assertion; current campaign browser coverage and the focused account flow both pass independently.

Activation is incomplete: no genuine Brevo message or inbox receipt has been tested because provider credentials and a verified sender are absent. Complete the owner setup above before enabling the mail flags or claiming live signup/recovery certification.
