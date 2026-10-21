# OAuth callback investigation — 2026-10-21

## Reproduced cause and evidence

The reported HTTP 400 body is `Invalid or expired OAuth state.` In the original callback that message covers both a missing/unexpired D1 state lookup and a binding-cookie hash mismatch. It precedes token exchange, PKCE decryption, mailbox identity lookup and encrypted token storage. A Google token exchange failure is not this HTTP 400 path. The outer request-origin guard would return 403, not this message.

The owner confirmed consent finished within ten minutes and multiple Connect attempts/tabs were used. Original `startOAuth` gave every attempt for one provider the identical cookie name/domain/path (`oauth_gmail`), but each attempt generated a new binding and D1 row. A browser replaces the previous cookie. Returning from the first consent then sends the second binding; its hash differs from the first row and the callback throws this exact HTTP 400.

A regression models browser cookie replacement by name/path. Running it against the original committed OAuth implementation reproduced this exact exception at the binding-hash validation for both Gmail and Outlook. Restoring the fix makes both overlapping callbacks succeed independently with mocked providers. This verifies the defect without a live Google code exchange. Historical production logs do not distinguish the two old branches, so they cannot independently prove the category of every previous failed request.

A read-only production D1 aggregate showed one Gmail state already expired at inspection, with an active initiating session, served by the primary. That later observation does not establish expiry at the earlier callback. No state values, cookies, identities, tokens or private documents were selected. No production rows or settings were changed.

## Minimal fix

- Name the callback cookie `oauth_PROVIDER_STATEHASH`, with the full SHA-256 hash of the random state. Each flow has a separate random binding; cookies and stored bindings cannot be swapped across states.
- Derive the expected name from the returned state; verify the stored binding hash, provider, ten-minute expiry and original active session before single-use state deletion and token exchange.
- Preserve HttpOnly, Secure, SameSite=Lax, the narrow callback path and Max-Age=600. Success clears only that attempt's cookie with matching attributes.
- Preserve encrypted PKCE verifiers, S256, encrypted provider tokens with user/provider AAD, exact-origin mutation guards and fixed configured redirect URLs. No schema migration or Vercel rewrite change is required.

The callback logs only `oauth_callback_failure` plus one fixed category: configuration, state_missing, state_lookup, state_not_found, state_expired, binding_cookie_missing, binding_cookie_mismatch, session_validation, state_consumption, authorization_incomplete, pkce_decryption, token_exchange, offline_access_missing, mailbox_scopes_missing, identity_request, identity_unverified, token_encryption or connection_save. No error objects, request URLs/headers, codes, state, cookie values, credential material, email addresses or provider payloads are logged. `state_not_found` can also mean a replay after deletion/cleanup; do not infer a missing start from that category alone.

## Proxy and redirect review

The Vercel rewrite retains `/api` and forwards to the fixed workers.dev upstream. Cookie matching happens on the browser-visible Vercel hostname/path. Both the authorization request and token exchange construct the same redirect URI from APP_ORIGIN, rather than Worker host or forwarded headers. The return redirect also uses APP_ORIGIN. A regression passes a Worker-host callback URL and forged forwarding headers and verifies that the configured Vercel origin remains authoritative. The Strict session cookie is not required on Google's return: the Lax binding cookie and the original session hash persisted in D1 validate that flow.

Current production APP_ORIGIN read back as `https://ms-professor-agent-malang43.vercel.app`, matching the deployed proxy. Keep the Google Web client redirect registered exactly as `https://ms-professor-agent-malang43.vercel.app/api/oauth/gmail/callback`. Google's private console registration was not accessed; a future retry must retain that exact registration.

## Validation and rollout status

- **71 tests passed** (59 existing + 12 regressions), with all provider HTTP mocked.
- Both workspace TypeScript checks and production frontend build passed.
- Original-code baseline: both overlap regressions failed with the exact reported binding-check exception; the corrected code passed.
- Covered overlapping flows, PKCE challenge preservation, replay, wrong binding/attempt, missing state, absent/expired rows, Cookie header without the required binding, revoked sessions, denial, corrupt PKCE ciphertext, encrypted tokens, proxy redirect consistency and fixed-category-only logs.
- No commits, pushes or deployments were made during this investigation. Earlier deployment configuration changes in the working tree were preserved.
- Read-back production flags remain `OAUTH_ENABLED=true`, `LIVE_EMAIL_ENABLED=false`, `AI_PROVIDER=mock`. Following explicit deployment approval, the production Wrangler configuration now preserves OAuth=true; the local emulator remains OAuth=false. Deployment uses --keep-vars to retain dashboard variables and secret bindings, with live-email=false and AI=mock explicit in configuration.

The owner approved commit, push and deployment. Deploy the reviewed Worker fix only, preserving live-email=false and AI=mock. No frontend deployment, resource creation, paid service or migration is needed. Discard old consent tabs and start a fresh Connect attempt: in-flight provider-wide cookies from the old version are intentionally not accepted as substitutes for the new per-state cookies. Old cookies expire naturally after ten minutes. Retry once, then verify overlapping attempts if desired. A production Google reconnect has not been certified because deploying or exchanging a real authorization code was not authorized in this task.

## Approved rollout completed

The owner subsequently authorized commit, push and deployment. Fix commit `be7eb0d7f460db502742431062e0eed6cbb78911` was pushed to PRIVATE GitHub main. The Worker code deployment succeeded as version `c51ac4f6-7bdb-4891-af2a-a7bac6cff50d`; subsequent settings updates preserved that code. No frontend deployment, new resources, migrations, paid service, real sending or Groq calls were needed.

Production read-back confirmed OAuth=true, live-email=false, AI=mock. Chromium on the canonical Vercel origin verified two independent HttpOnly/Secure/Lax per-state cookies, both callbacks passing binding/session validation independently using simulated consent denial, and replay rejection. Proxy health remained mock/KV/live_email=false. No Google token exchange was performed; a fresh real consent attempt by the owner is still required.

Wrangler's deployment warning unexpectedly included existing dashboard credential values because they were stored as plain-text variables. They were not repeated in documentation or committed. Existing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY values were atomically converted to secret_text bindings without changing key material or breaking stored ciphertext. Binding types were independently verified. A direct secret-put initially failed due to existing variable names; the atomic settings replacement succeeded. Application category logs are enabled, invocation request logs and traces are disabled, and query-string redaction is enabled. These settings are now recorded in Wrangler config.

Because the credential values appeared in the CLI output, rotate the Google client secret in the Google console and update its Worker secret through a secure entry flow. Plan encryption-key rotation with re-encryption or explicit mailbox reconnection; do not blindly replace the encryption key while encrypted credentials remain. This is a remaining security action, not a completed rotation. Discard old consent tabs and retry Connect Gmail once from the canonical application URL after resolving credential rotation.