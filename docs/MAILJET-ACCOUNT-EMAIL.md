# Mailjet account verification and recovery

This release adds Mailjet Send API v3.1 to the existing account-mail adapter. Brevo compatibility remains. Gmail outreach, OAuth, reply detection, Excel approvals, automatic follow-ups, D1/KV and Groq are unchanged. No migration or new infrastructure is required.

## Free-plan compatibility

Official references checked 2026-10-23:

- [Free plan limits](https://documentation.mailjet.com/hc/en-us/articles/19154256993051-Understanding-Mailjet-Free-Plan-Limits): 200/day, 6,000/month and 1,000 contacts, shared with other Mailjet account workloads.
- [Premium trial](https://documentation.mailjet.com/hc/en-us/articles/36284024209051-Welcome-to-Mailjet-Start-Your-Free-Premium-Trial-Today): trial-only features are separate from the Free plan's sending allowance.
- [Send API v3.1](https://dev.mailjet.com/docs/email-api/send-api-v31/send-basic-email): HTTPS Basic authentication, active sender and Messages payload with TextPart/HTMLPart.
- [Message status](https://dev.mailjet.com/docs/email-api/getting-started/retrieve-sent-message) and [history](https://dev.mailjet.com/docs/email-api/getting-started/view-message-history).

The application uses only Send API v3.1 and inline HTML/text, with no Mailjet templates, automations, segmentation, paid tracking or Premium features. Its shared transactional attempt cap is 180/day (at most 5,580 in a 31-day period); other Mailjet workloads can still exhaust provider allowances. Limits fail safely without upgrades. Free-plan availability and sender eligibility remain subject to Mailjet policies after the trial ends.

## Configuration and safeguards

Both MAILJET_API_KEY and MAILJET_SECRET_KEY are existing Cloudflare secret bindings. Values are never retrieved, printed, committed or placed in frontend variables. Sender: aliraza57616@gmail.com, name MS Professor Agent. Final activation requires MAIL_PROVIDER=mailjet, MAIL_FROM set to that active sender, MAIL_FREE_PLAN_CONFIRMED=true, MAIL_SENDER_VERIFIED=true and MAIL_DELIVERY_ENABLED=true. Preserve every other current variable/binding, especially LIVE_EMAIL_ENABLED and LIVE_TEST_RECIPIENTS.

Secure templates, canonical fragment links, single-use hashed 24-hour verification / 30-minute reset tokens, atomic redemption, session revocation, rate limits, generic responses, pending-user resend and password-reset confirmation remain intact. Open/click tracking is explicitly disabled so the secure link is not rewritten by Mailjet. HTTP 200 alone is insufficient: per-message Status must be success and tracking metadata must be present. Exact provider IDs are retained without JavaScript integer truncation in token-free account audit records. Rejections store only fixed/sanitized codes, never provider messages, recipient data or secure links. HTTP 5xx, malformed success and network ambiguity retain the token without blindly retrying.

## Controlled certification

`scripts/mailjet-certification.ts` is a temporary operator deployment entrypoint, not a permanent API route. Its HTTP handler is the unchanged application. A random one-time cron run and stage are configured only in ignored release configuration. It verifies the exact active sender using installed Worker secrets, then invokes only the existing account resend or forgot-password handler for the existing user whose email equals the configured sender and certification recipient. It creates no session, consumes no token, sets no password and grants no workspace access. Each run/stage is claimed in D1 before work and is never automatically retried after interruption. Public transactional delivery stays disabled during these controlled tests. Inspection stages query only safe Mailjet message status and record token-free evidence.

After certification, deploy the normal production entrypoint and remove all MAILJET_CERTIFICATION_* flags. Enable public transactional mail only after actual owner inbox receipt has been demonstrated. Mailjet acceptance/recipient-server acceptance alone is not proof of Inbox placement. The owner opens the delivered verification link and clicks Verify my email themselves; the operator never reads or redeems that token. The owner similarly chooses their own password through the delivered reset link. Their existing documents/outreach data are preserved, while password reset intentionally revokes sessions as designed.

## Verification

227 automated tests across 13 files passed. Both workspace TypeScript checks, the separate certification Worker TypeScript check and production build passed. Native Workers tests for Mailjet authentication/payload/D1/provider-ID preservation and unchanged Gmail send/thread/reply/token behavior passed with all outbound traffic intercepted. Isolated account verification/reset/new-password login and Excel campaign one-time approval/archive/delete browser regressions passed.

Actual live acceptance, delivery, activation and deployment evidence are appended after production certification. No new professor outreach is authorized by these tests.


## Actual live result: blocked by Mailjet suspension

The installed credentials authenticated successfully to GET /v3/REST/sender, which returned the exact owner sender as Active. This proves Worker binding availability and authenticated Mailjet API connectivity, not send permission.

Two owner-requested account operations were attempted through the existing handlers:

- Verification resend, 2026-10-23 17:13:46 UTC: Send API rejected HTTP 401. No acceptance receipt was recorded.
- Forgot-password, 2026-10-23 17:16:47 UTC: Send API rejected HTTP 401 with safe error code `mj-0001`.

Mailjet's [official Send API error table](https://dev.mailjet.com/docs/email-api/send-api-v31/send-api-errors) defines `mj-0001` as **API key suspended**. It separately defines `mj-0015` for invalid authorization credentials. The observed result must not be misreported as a missing secret, an unverified sender or successful delivery.

Neither verification nor reset email was accepted or demonstrated in the inbox. Rejected-token cleanup completed; zero active test account tokens remain. The operator never redeemed any link, verified the account, changed its password or revoked its sessions. The existing owner remains legacy-access/unverified. No professor email was sent or replayed.

Final runtime configuration selects MAIL_PROVIDER=mailjet and MAIL_FROM=aliraza57616@gmail.com, with MAIL_DELIVERY_ENABLED=false, MAIL_FREE_PLAN_CONFIRMED=false and MAIL_SENDER_VERIFIED=false. Broad activation was intentionally withheld because genuine delivery could not be demonstrated. Both existing Mailjet secrets and all outreach variables/bindings are preserved. The normal application entrypoint replaces the temporary certification entrypoint; no MAILJET_CERTIFICATION_* variables or operator HTTP route remain.

## Required owner action

1. Open the existing Mailjet dashboard and review the account/API-key sending suspension and any validation notice. Complete Mailjet's requested legitimate account/use-case checks for transactional verification/password recovery.
2. Contact Mailjet support if the restriction cannot be resolved in the dashboard. Provide the non-secret evidence: **active sender, Send API v3.1 HTTP 401 / mj-0001, 2026-10-23 17:13-17:17 UTC**, and the application URL. Request removal of the API-key sending suspension on the **Free plan**. Do not send API credentials, secure links or user passwords to chat or logs. Do not upgrade, buy a domain or rotate working secrets merely to bypass the restriction.
3. Once Mailjet confirms sending is reinstated, repeat one controlled verification resend and one forgot-password send using the installed secrets. Confirm provider acceptance and actual owner inbox receipt before enabling public delivery. The existing owner-connected Gmail readonly scope is available for token-free inbox-metadata certification if needed; no inbox/body read was necessary during these rejected attempts.
4. After a verification email is genuinely delivered, the owner opens its button on the canonical production domain and clicks **Verify my email** themselves. For password recovery, the owner opens the reset email and chooses their own new password; existing documents/campaigns remain, while session revocation is intentional. Never share either link. Test login and reused-link rejection.
5. After real delivery certification, enable MAIL_DELIVERY_ENABLED, MAIL_FREE_PLAN_CONFIRMED and MAIL_SENDER_VERIFIED and redeploy the normal Worker using a freshly captured preservation configuration. Keep Gmail outreach, LIVE_EMAIL_ENABLED, LIVE_TEST_RECIPIENTS, credentials and Groq unchanged.

The implementation is deployed and tests pass; production signup/recovery email delivery is **not certified or activated** until Mailjet lifts this external restriction and genuine delivery succeeds.

## Final deployment evidence

- Existing private GitHub: implementation `eff9099`, safe diagnostic improvement `887a3ed`; both pushed to main.
- Normal production Worker: `638b7ae3-cf22-48db-adbd-f7f5bfc09fc0`; exact deployed module SHA-256 `79a0fa4c99e74eae37aee06ee94041f373996d8a0748f25ba2837bd5f2734c41` matches the tested local bundle.
- Existing Vercel production: READY deployment `dpl_Er5ubwiZikEhdDRUKAL8M1vFBtif`, aliased to https://ms-professor-agent-malang43.vercel.app. Deployed account UI, campaign page and shared import parser match tested source hashes.
- Both direct Worker and canonical same-origin health show unchanged Gmail readiness. Authentication, exact-Origin enforcement, no-store and downloadable template checks passed. XLSX bytes match; CSV content matches after Windows line-ending normalization.
- Protected account/password, document, connection identity/scope, successful sending/reply/provider/thread history, credential bindings and non-mail configuration fingerprints match the pre-release baseline. Actual Gmail deliveries remain two and detected replies remain one. Existing LIVE_EMAIL_ENABLED and LIVE_TEST_RECIPIENTS are unchanged. No new actual Gmail deliveries occurred.
- Final suite: **227 tests passed across 13 files**, both workspace TypeScript checks, separate certification-entrypoint TypeScript check, production build, native Mailjet/Gmail Workers tests and isolated account/campaign browser regressions passed. Production dependency audit: zero known vulnerabilities.
- No Mailjet Premium dependency or paid service was enabled. Public transactional delivery remains disabled because both real owner-inbox attempts were rejected, so no delivered verification/reset link exists to open from this test.

For Mailjet's owner-side resolution procedure, see [Blocked or Limited Account](https://documentation.mailjet.com/hc/en-us/articles/360042624754-Blocked-or-Limited-Account-Reasons-and-How-to-Restore-Full-Functionality) and [Mailjet Support](https://www.mailjet.com/contact/support/). Request Free-plan sending reinstatement for `mj-0001`; the integration does not need a rebuild once Mailjet restores permission and live certification succeeds.
