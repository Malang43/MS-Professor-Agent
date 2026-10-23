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

226 automated tests across 13 files passed. Both workspace TypeScript checks, the separate certification Worker TypeScript check and production build passed. Native Workers tests for Mailjet authentication/payload/D1/provider-ID preservation and unchanged Gmail send/thread/reply/token behavior passed with all outbound traffic intercepted. Isolated account verification/reset/new-password login and Excel campaign one-time approval/archive/delete browser regressions passed.

Actual live acceptance, delivery, activation and deployment evidence are appended after production certification. No new professor outreach is authorized by these tests.
