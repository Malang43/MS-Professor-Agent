"use client";
import { useState, type FormEvent } from "react";
import {
  GraduationCap,
  ShieldCheck,
  Eye,
  EyeOff,
  ArrowUpRight,
  Mail,
} from "lucide-react";
import { passwordStrength } from "../../../shared/password-policy";
export type Api = (
  path: string,
  method?: string,
  data?: unknown,
) => Promise<any>;
export type Identity = {
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email_verified_at: number | null;
  legacy_access: number;
};
export function PasswordField({
  name = "password",
  label = "Password",
  confirm = false,
  onValue,
}: {
  name?: string;
  label?: string;
  confirm?: boolean;
  onValue?: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <span className="password-control">
        <input
          name={name}
          type={visible ? "text" : "password"}
          required
          maxLength={128}
          minLength={confirm ? 1 : 15}
          autoComplete={
            name === "current_password" ? "current-password" : "new-password"
          }
          onChange={(e) => onValue?.(e.target.value)}
        />
        <button
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    </label>
  );
}
function Notice({ text, error = false }: { text: string; error?: boolean }) {
  return text ? (
    <div
      className={`feedback ${error ? "error" : "success"}`}
      role={error ? "alert" : "status"}
    >
      {text}
    </div>
  ) : null;
}
export function AuthPanel({
  api,
  onComplete,
  intent,
  onCancel,
}: {
  api: Api;
  onComplete: () => Promise<void>;
  intent?: { kind: "verify" | "reset"; token: string } | null;
  onCancel?: () => void;
}) {
  const [completed, setCompleted] = useState(false);
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login"),
    [password, setPassword] = useState(""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (intent) {
        await api(
          intent.kind === "verify"
            ? "/auth/verify-email"
            : "/auth/reset-password",
          "POST",
          { ...data, token: intent.token },
        );
        setMessage(
          intent.kind === "verify"
            ? "Email verified. You can now sign in."
            : "Password reset. Sign in with your new password.",
        );
        setCompleted(true);
      } else if (mode === "forgot") {
        const result = await api("/auth/forgot-password", "POST", data);
        setMessage(result.message);
      } else if (mode === "signup") {
        const result = await api("/auth/signup", "POST", {
          ...data,
          accept_terms: data.accept_terms === "on",
        });
        setMessage(result.message);
        setMode("login");
      } else {
        await api("/auth/login", "POST", data);
        await onComplete();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to complete request.");
    } finally {
      setBusy(false);
    }
  }
  const title = intent
    ? intent.kind === "verify"
      ? "Confirm your email"
      : "Choose a new password"
    : mode === "signup"
      ? "Your next chapter starts here."
      : mode === "forgot"
        ? "Let’s get you back in."
        : "Welcome to your research workspace.";
  return (
    <main className="auth auth-premium">
      <a href="/" className="auth-brand">
        <GraduationCap size={35} />
        <span>
          MS Professor
          <br />
          <b>OUTREACH AGENT</b>
        </span>
      </a>
      <div className="auth-layout">
        <section className="auth-story">
          <span className="eyebrow">RESEARCH WITH INTENTION</span>
          <h1>
            Big ideas.
            <br />
            Thoughtful connections.
          </h1>
          <p>
            A private home for your academic story, your research shortlist, and
            the conversations that come next.
          </p>
          <ul>
            <li>Keep your documents private</li>
            <li>Review every word before outreach</li>
            <li>Plan across time zones with confidence</li>
          </ul>
          <span className="story-note">
            <ShieldCheck size={20} /> You stay in control of every send.
          </span>
        </section>
        <section className="auth-card">
          <span className="eyebrow">YOUR ACADEMIC JOURNEY</span>
          <h2>{title}</h2>
          {!intent && (
            <div className="tabs">
              <button
                type="button"
                className={mode === "login" ? "active" : ""}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className={mode === "signup" ? "active" : ""}
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
              >
                Create account
              </button>
            </div>
          )}
          <Notice text={error} error />
          <Notice text={message} />
          {completed ? (
            <button
              className="primary full"
              onClick={async () => {
                onCancel?.();
                await onComplete();
              }}
            >
              Continue to sign in
            </button>
          ) : (
            <form onSubmit={submit}>
              {!intent && mode === "signup" && (
                <>
                  <div className="form-grid">
                    <label>
                      First name
                      <input
                        name="first_name"
                        required
                        maxLength={80}
                        autoComplete="given-name"
                      />
                    </label>
                    <label>
                      Last name
                      <input
                        name="last_name"
                        required
                        maxLength={80}
                        autoComplete="family-name"
                      />
                    </label>
                  </div>
                  <label>
                    Display name <small>(optional)</small>
                    <input
                      name="display_name"
                      maxLength={160}
                      autoComplete="nickname"
                    />
                  </label>
                </>
              )}
              {!intent && (
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
              )}
              {!intent && mode === "login" && (
                <>
                  <label>
                    Password
                    <LoginPassword />
                  </label>
                  <button
                    className="text-link forgot-link"
                    type="button"
                    onClick={() => setMode("forgot")}
                  >
                    Forgot password?
                  </button>
                </>
              )}
              {((!intent && mode === "signup") || intent?.kind === "reset") && (
                <>
                  <PasswordField onValue={setPassword} />
                  <div
                    className={`strength ${passwordStrength(password, email).toLowerCase()}`}
                    aria-live="polite"
                  >
                    <span />
                    Password strength: {passwordStrength(password, email)}
                  </div>
                  <p className="helper">
                    Use 15–128 characters. A long, unique passphrase works well.
                    Avoid common or reused passwords; letters, numbers and
                    symbols can help. Local screening cannot detect every
                    breached password.
                  </p>
                  <PasswordField
                    name="confirm_password"
                    label="Confirm password"
                    confirm
                  />
                </>
              )}
              {!intent && mode === "signup" && (
                <label className="checkbox-label">
                  <input name="accept_terms" type="checkbox" required />I accept
                  the{" "}
                  <a href="/#terms" target="_blank" rel="noreferrer">
                    usage terms
                  </a>{" "}
                  and{" "}
                  <a href="/#privacy" target="_blank" rel="noreferrer">
                    privacy notice
                  </a>
                  .
                </label>
              )}
              {intent?.kind === "verify" && (
                <p>
                  Confirm that you requested this verification link. Opening the
                  link alone does not change your account.
                </p>
              )}
              <button className="primary full" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : intent
                    ? intent.kind === "verify"
                      ? "Verify my email"
                      : "Reset password"
                    : mode === "login"
                      ? "Open my workspace"
                      : mode === "signup"
                        ? "Create account"
                        : "Request reset link"}
                <ArrowUpRight size={17} />
              </button>
              {!intent && mode === "forgot" && (
                <button
                  type="button"
                  className="secondary full"
                  onClick={() => setMode("login")}
                >
                  Back to sign in
                </button>
              )}
            </form>
          )}
          <p className="security-note">
            <ShieldCheck size={16} />
            Private by design. Sending stays under your control.
          </p>
        </section>
      </div>
    </main>
  );
}
function LoginPassword() {
  const [show, setShow] = useState(false);
  return (
    <span className="password-control">
      <input
        name="password"
        type={show ? "text" : "password"}
        required
        maxLength={128}
        autoComplete="current-password"
      />
      <button
        type="button"
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        onClick={() => setShow(!show)}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </span>
  );
}
export function VerificationGate({
  account,
  ready,
  api,
  refresh,
}: {
  account: Identity;
  ready: boolean;
  api: Api;
  refresh: () => Promise<void>;
}) {
  const [manage, setManage] = useState(false);
  const [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth">
      <section className="auth-card">
        <Mail size={34} />
        <span className="eyebrow">ONE MORE STEP</span>
        <h1>Verify your email</h1>
        <button className="text-link" onClick={() => setManage(!manage)}>
          Manage account or delete pending account
        </button>
        {manage && (
          <AccountSettings account={account} api={api} refresh={refresh} />
        )}
        <p>
          Welcome, {account.first_name}. Confirm access to {account.email}{" "}
          before using your private workspace.
        </p>
        <p className="helper">
          {ready
            ? "Check your inbox and spam folder. Links expire after 24 hours."
            : "Transactional email delivery has not been configured by the operator. Your account is pending; workspace access is protected until verification becomes available."}
        </p>
        <Notice text={error} error />
        <Notice text={message} />
        <button
          className="primary"
          disabled={busy || !ready}
          onClick={async () => {
            setBusy(true);
            try {
              setMessage(
                (await api("/auth/resend-verification", "POST")).message,
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Resend verification email
        </button>
        <button className="secondary" disabled={busy} onClick={() => refresh()}>
          Check verification status
        </button>
        <button
          className="text-link"
          onClick={async () => {
            await api("/auth/logout", "POST");
            await refresh();
          }}
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
export function AccountSettings({
  account,
  api,
  refresh,
}: {
  account: Identity;
  api: Api;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function run(fn: () => Promise<void>, text: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setMessage(text);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-card account-settings">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">YOUR IDENTITY & SECURITY</span>
          <h2>Account settings</h2>
        </div>
        <ShieldCheck size={24} />
      </div>
      <Notice text={error} error />
      <Notice text={message} />
      <p>
        <strong>{account.email}</strong>
        <br />
        <span className="badge">
          {account.email_verified_at
            ? "Email verified"
            : account.legacy_access
              ? "Existing account · email not yet verified"
              : "Verification pending"}
        </span>
      </p>
      {!account.email_verified_at && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api("/auth/resend-verification", "POST");
              setMessage(r.message);
            }, "If delivery is configured, a verification email has been requested.")
          }
        >
          Request verification email
        </button>
      )}
      <form
        key={account.display_name}
        onSubmit={(e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          run(async () => {
            await api("/account/profile", "PUT", data);
          }, "Your name has been updated.");
        }}
      >
        <div className="form-grid">
          <label>
            First name
            <input
              name="first_name"
              defaultValue={account.first_name}
              required
              maxLength={80}
            />
          </label>
          <label>
            Last name
            <input
              name="last_name"
              defaultValue={account.last_name}
              required
              maxLength={80}
            />
          </label>
        </div>
        <label>
          Display name
          <input
            name="display_name"
            defaultValue={account.display_name}
            required
            maxLength={160}
          />
        </label>
        <button className="primary" disabled={busy}>
          Save account details
        </button>
      </form>
      <hr />
      <h3>Password & sessions</h3>
      <p>
        Changing your password signs out every device and invalidates pending
        recovery and OAuth attempts.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          run(async () => {
            await api("/auth/change-password", "POST", data);
          }, "Password changed. Sign in again.");
        }}
      >
        <PasswordField
          name="current_password"
          label="Current password"
          confirm
        />
        <PasswordField label="New password" />
        <PasswordField
          name="confirm_password"
          label="Confirm new password"
          confirm
        />
        <button className="secondary" disabled={busy}>
          Change password
        </button>
      </form>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api("/auth/logout-all", "POST");
          }, "All devices signed out.")
        }
      >
        Sign out all devices
      </button>
      <hr />
      <details className="danger-zone">
        <summary>Delete account permanently</summary>
        <p>
          This removes your profile, professors, messages, schedules,
          notifications and document access. Sessions and locally held OAuth
          tokens are removed immediately. Private storage deletion is retried in
          the background; opaque object keys and byte reservations remain until
          cleanup/expiry. Shared abuse counters and provider-side mail/consent
          records may remain. Remove Google app consent in your Google account
          if needed. An email already accepted by a provider cannot be recalled.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget));
            if (
              !window.confirm(
                "Permanently delete your account and all private workspace data? This cannot be undone.",
              )
            )
              return;
            run(async () => {
              await api("/account/delete", "POST", data);
            }, "Account deleted.");
          }}
        >
          <PasswordField
            name="current_password"
            label="Confirm your password"
            confirm
          />
          <label>
            Type DELETE MY ACCOUNT
            <input
              name="confirmation"
              required
              pattern="DELETE MY ACCOUNT"
              autoComplete="off"
            />
          </label>
          <button className="danger" disabled={busy}>
            Delete my account permanently
          </button>
        </form>
      </details>
    </section>
  );
}
export function PolicyNotice({
  kind,
  onClose,
}: {
  kind: string;
  onClose: () => void;
}) {
  return (
    <main className="auth">
      <article className="auth-card">
        <h1>{kind === "terms" ? "Usage terms" : "Privacy notice"}</h1>
        <p>
          This personal development workspace helps you organize research
          outreach. You are responsible for consent, accurate content, lawful
          use and your recipient choices. Do not use it for spam. Sending
          requires explicit approval and may be unavailable.
        </p>
        <p>
          The application stores your account, academic profile, professor
          records, drafts, private documents and connected-provider tokens.
          Documents are access controlled and expire after 30 days. Tokens are
          encrypted. Hosting uses Vercel and Cloudflare. Configured
          transactional delivery processes your address and account link; AI
          receives selected context only when enabled and used. Provider consent
          screens describe mailbox permissions.
        </p>
        <p>
          You can edit your profile, disconnect mailboxes and delete your
          account in Settings. Background cleanup may retain opaque object
          identifiers until expiry; abuse-prevention counters are retained
          separately. External provider mail and consent records are governed by
          their policies. This development service has no uptime guarantee.
          Contact the project operator through the channel where you obtained
          access for privacy requests.
        </p>
        <button className="primary" onClick={onClose}>
          Back to application
        </button>
      </article>
    </main>
  );
}
