# Production diagnosis - 2026-10-21

Snapshot: October 21, 2026, approximately 18:00 Asia/Karachi. No features, credentials, production settings, owner counters or outreach controls were changed. No fixes were committed, pushed or deployed. One disclosed synthetic account/flow was used to check current configuration; its start consumed one legitimate global allowance. No Google login, consent, token exchange, real email or Groq call was made.

## A. Exact quota failure

The exact text `Daily or interval quota reached. Try later.` originates in `apps/api/src/runtime.ts`, in `consume`. It is an application-generated HttpError 429, not a Cloudflare billing/Workers quota or Google API error.

The production record for the only non-synthetic account is:

| D1 table/key | Period | Amount | Limit |
| --- | --- | --- | --- |
| usage_counters, scope oauth:<owner-id> | 2026-10-21 | 5 | 5 |
| usage_counters, scope oauth:global | 2026-10-21 | initially 7, finally 8 after one synthetic diagnosis start | 50 |

Actual IDs and identities were not printed. The observed exhaustion is the per-account OAuth limiter, not the global limiter.

Path: authenticated `POST /api/connections/gmail/start` or `/api/connections/outlook/start` -> startOAuth -> credentials validation -> consume(account,5) -> consume(global,50) -> insert oauth_states -> return authorization URL and binding cookie. The sixth start is rejected before state creation, callback handling or a Google request. No new OAuth consent can start from that account until its next allowance period.

Limits are shared by Gmail and Outlook for the same application account, not separated by provider, browser, tab, Google Client ID or app session. Starts count even when later consent fails, is cancelled, or expires. Replacing Google credentials does not reset application counters. The SQL conditional UPSERT increments only up to the limit and atomically returns no row for an excess attempt; rejected attempts do not increase the account beyond five. No reset/delete/refund or limit increase was performed.

Periods are UTC date strings from new Date().toISOString().slice(0,10). The next period is **2026-10-22 00:00:00 UTC = Thursday, October 22, 2026, 05:00 AM Asia/Karachi**. A new period row supplies the allowance; reset does not depend on cron or deleting today's row. Cleanup eventually removes records older than two days in bounded batches.

The same generic helper is also used by signup, manual reply sync, message creation, KV operations, AI and live-send budgets. Those callers are not evidence of a provider limit here: the actual production OAuth account record is exhausted while its global record is not. Dashboard `GET /api/state` does not call consume and remains available. The frontend displays a shared error banner from the failing start request, which makes it look like a dashboard-wide failure.

## B. Revision and deployment drift

| Platform | Actual observed state |
| --- | --- |
| Local committed main | 798dc8eb7ae3b38bcd52fffcff0f70f99f88faf2 |
| GitHub main | Same SHA; Malang43/MS-Professor-Agent verified PRIVATE |
| Worker active deployment | fbc70b37-6a4b-4a2f-a2fb-79e930c0c7b2 |
| Worker active version | c55ff4a6-17a1-4f32-9ae5-ea513941b03c at 100%, dashboard-created 2026-10-21 12:32:38 UTC |
| Worker code | Downloaded module exactly matches the local dry-run bundle compiled before this investigation's pending changes |
| Worker bundle SHA-256 | c9f0fd3219036c97e2ceb8dcc55189fc434407f15d14e2a0c4646420ed7fcdb9 |
| Vercel production | dpl_4nMAXdwaTCi2XNeBxSexYmS7kXQR, READY; ms-professor-agent-hbbw08lqa-m-farhat-mehdi.vercel.app |
| Canonical frontend | https://ms-professor-agent-malang43.vercel.app |
| Vercel Git connection | Not connected for this project; pushing GitHub does not redeploy it |
| Vercel source revision | CLI deployment has no Git SHA recorded. All 12 uploaded apps/web files match local file hashes exactly |

The active Worker version ID changed after secret/dashboard updates, but its code is not an old pre-cookie-fix bundle. Both the per-state cookie fix and safe callback diagnostic categories are present. Frontend code is also current by content comparison; no frontend redeployment is needed for the pending backend-only reporting fix. The local working tree now intentionally contains the uncommitted quota reporting fix/tests/report described below.

## C. Current runtime configuration

Cloudflare read-back found GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY present as secret_text bindings. No values were read back or printed. OAUTH_ENABLED=true, LIVE_EMAIL_ENABLED=false, AI_PROVIDER=mock, and APP_ORIGIN is exactly https://ms-professor-agent-malang43.vercel.app.

A fresh start using an isolated synthetic account returned HTTP 200. This executes the real credentials() and keyConfig() checks before quota charging: client ID and secret are nonempty, OAuth is enabled, origin is HTTPS, and the encryption key decodes to exactly 32 bytes. The authorization URL's client ID matched Google's expected client-ID shape, and its redirect URI and S256 PKCE settings were correct. No client-ID or authorization-URL values were logged.

This establishes runtime configuration presence and key format. Secret bindings intentionally cannot be read back through the settings API, and successful start is not proof that a client secret matches its replacement Google client. No change to any credential was made.

## D-E. Google and callback behavior

The synthetic flow navigated to the real Google authorization page and recognized the sign-in page. No recognized invalid_client, deleted_client, redirect_uri_mismatch, invalid_request, access_denied or HTTP-error marker appeared. No Google account login or consent was performed. This supports the replacement client ID/redirect being accepted at the authorization entry step, but does not certify its client secret, Testing-user eligibility, scopes after consent, or token exchange.

The redirect URI used for authorization and token exchange is fixed from APP_ORIGIN:

https://ms-professor-agent-malang43.vercel.app/api/oauth/gmail/callback

The Vercel rewrite retains /api on the fixed workers.dev upstream. Worker-host and forwarded-host headers are not used to construct the redirect or authorize a mutation. Cookie and state handling remain secured by per-state cookie names, HttpOnly/Secure/Lax/narrow path, ten-minute expiry, hash comparisons, initiating-session validity, one-use state deletion, S256 PKCE and AES-GCM credential storage.

A real top-level cross-site return to the canonical callback with simulated access_denied passed state, binding and active-session checks, then returned the intended `Account authorization was not completed.` This demonstrates that the live proxy/callback cookie path works with the current configuration. The synthetic state was consumed; no Google token request occurred. Existing regression coverage also checks overlapping attempts, replay, missing/wrong bindings and forged forwarding headers.

At final inspection, production had zero connections and zero pending OAuth states. This proves no successful mailbox connection was stored, but does not identify which historical validation failed. Expired states are cleaned; consumed states are deleted, so absence is not evidence of one specific cause.

The current login token received **HTTP 403** from Cloudflare's historical telemetry query API. The documented permission for that query is Workers Observability Write. Invocation logs are disabled, query-string redaction enabled, and category logs enabled. No raw historical logs, full callback URLs, state, cookies, codes, tokens or email contents were printed.

Therefore the latest real callback's precise historical category is **not verified**. The original overlapping-cookie defect was previously reproduced and is deployed; no evidence justifies weakening or changing state, cookie, origin or PKCE validation again. The available evidence establishes that current starts on the owner account are blocked locally by its five-start budget. A replacement-client-secret mismatch must not be claimed without a token_exchange failure category or Google-console evidence. The only additional evidence requested was the existing fixed callback category from the dashboard, not repeated Google retries.

To complete historical attribution, grant access to historical observability queries or inspect the existing `oauth_callback_failure` category in the Cloudflare dashboard. Share only a category. If it is token_exchange, compare the client ID and secret within the secure Google/Cloudflare consoles and inspect a sanitized provider-error category; never paste the credential or callback URL into logs/chat. If it is binding/state related, use that exact category to investigate, rather than assuming a proxy failure.

## F. Outreach stopped

The owner profile has stopped=1 and paused=0. Audit contains outreach.stop at **2026-10-21 12:07:38 UTC / 17:07:38 Asia/Karachi**, with no later resume. This is the persisted result of an authenticated exact-origin POST /api/control with action=stop, not a consequence of OAuth, quota exhaustion or replacing Google credentials. The audit does not identify the physical person who clicked it.

Stop atomically sets the profile flag and cancels that user's draft/pending messages; cancellation triggers also prevent transport/follow-up automation where relevant. The owner currently has **zero messages in total**, so there are no queued messages and no cancelled message records. No messages were revived, cancelled or sent during this investigation.

Stopped/paused gates are used by scheduling/automation, not startOAuth/finishOAuth. Stop does not prevent OAuth connection. Existing Resume clears both flags but does not resurrect cancelled messages. Outreach remains stopped, and live sending remains disabled; resuming is unnecessary to fix Gmail and was not performed.

## G. Verified minimal local fix and checks

Only two implementation files changed:

1. runtime.ts: Retry-After now reflects the actual next UTC day or minute boundary for the limiter's period. The old fixed 60 seconds was misleading for daily quotas. The same atomic SQL, limits, scopes and periods are retained.
2. oauth.ts: exhausted starts return an OAuth-specific explanation of the account/global limit, shared providers, exact UTC reset timestamp and counted failed/cancelled attempts. Fixed category-only start diagnostics distinguish account_quota and global_quota, without user IDs, credentials or URLs.

No rate-limit bypass, counter reset, refund, threshold increase, credential change, auth/cookie/PKCE relaxation, tenant-isolation change, outreach resume, new feature, paid service or remote deployment was introduced.

Added eight regressions for daily/minute retry boundaries, shared Gmail/Outlook account budget and UTC reset, independent global budget, available dashboard reads despite OAuth exhaustion, stopped outreach vs OAuth, final cancellation across resume, denied-consent attempt charging, and invalid configuration rejected before charging. Results:

- **79 tests passed** across seven files.
- API and frontend TypeScript checks passed.
- Production frontend build passed.
- npm audit: zero reported vulnerabilities.
- git diff --check passed.
- Exact proposed default-environment Worker command passed a local dry run (no publish).

## H. Exact deployment steps, only after approval

No production change is needed to restore the daily allowance at 05:00 AM Karachi on October 22. Deployment of this reporting fix does not reset it.

1. Review the local diff and this report. Preserve OAUTH_ENABLED=true, LIVE_EMAIL_ENABLED=false, AI_PROVIDER=mock and the existing secret bindings. No database migration, secret rotation, resource creation or frontend deployment is part of this fix.
2. Once commit/push approval is given, stage only apps/api/src/runtime.ts, apps/api/src/oauth.ts, apps/api/tests/quota.test.ts, DEPLOYMENT.md and docs/PRODUCTION-DIAGNOSIS.md. Audit staged paths/content, commit, verify repository privacy, then push main without force.
3. After deployment approval, from D:\MS-Professor-Agent\apps\api run the tested PowerShell command:

```powershell
npx.cmd wrangler deploy --env= --keep-vars
```

The empty --env= targets the production top-level config; never use --env local. --keep-vars retains dashboard variables; credential bindings must remain secret_text. Do not enter or print secret values.

4. Read back the active deployment/version and only nonsecret flags/binding types. Check canonical /api/health, exact-origin protection and no-store headers. Existing mailbox/client-secret validation must use secure consoles; do not repeatedly consume the exhausted account's budget as a health check.
5. At/after the actual reset, one controlled consent flow can complete end-to-end if the secure client/redirect/Testing-user settings are correct. Do not ask for repeated blind retries. Use the existing failure category if it fails. No message sending or Groq activation is needed for OAuth certification.
6. Keep outreach stopped until the owner explicitly chooses otherwise. Keep LIVE_EMAIL_ENABLED=false regardless of OAuth success.

References: [Cloudflare historical telemetry query and required permission](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/). All operational findings above come from the repository, live read-only configuration/D1 checks, source hash comparisons and the disclosed synthetic browser test, not assumptions about provider quotas.

## Subsequent release approval

The owner subsequently approved committing, pushing and deploying only the verified quota-reporting changes, tests and related diagnosis/runbook. The release must preserve the five/fifty OAuth limits, current credentials, OAuth=true, live-email=false and AI=mock. No quota reset, resume, secret mutation, paid activation, migration or frontend deployment is authorized by this release. Before deployment the owner/global counts remained 5/8 for October 21 UTC. All 79 tests, workspace type checks and the production build were rerun for the release.
