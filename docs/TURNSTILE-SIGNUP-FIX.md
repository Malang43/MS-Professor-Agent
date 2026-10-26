# Turnstile signup rendering fix

The existing public configuration endpoint suppressed the site key whenever TURNSTILE_ENABLED was false. This prevented rendering the already-configured Managed widget and blocked genuine pre-activation verification.

The public endpoint now publishes the configured public site key independently of enforcement, plus a separate turnstile_required flag. Secret material remains exclusively in the Worker secret binding. The signup component loads the official script once, mounts the Managed widget explicitly, includes its response token in the signup request, handles expiration/failure/retry and preserves the widget during submission. Required challenges disable submission until complete. Narrow screens use compact rendering.

During rollout, missing tokens remain optional while TURNSTILE_ENABLED=false. Supplied preview tokens are nevertheless verified by the actual Worker through Siteverify, including exact APP_ORIGIN hostname, signup action, timestamp, provider single-use semantics and the D1 replay fence. This permits a genuine end-to-end test before enforcement. When enabled, missing or invalid tokens are rejected; missing key configuration fails closed.

Tests cover separate configuration/enforcement flags, no public secret exposure, signup missing/invalid/replayed tokens and missing-key failure. Local browser lifecycle tests use an explicitly synthetic widget fixture; these are not claimed as genuine Cloudflare validation. Genuine validation is performed separately on the actual production signup page before activation.

The existing Managed widget hostname and secret binding were inspected. No migration is needed. Hash-only baselines cover accounts, verification state, recovery codes, passkeys, documents, Gmail identity/scopes, deliveries, approvals and unrelated settings. Mailjet remains disabled. Activation is conditional on successful genuine browser/Worker validation.
