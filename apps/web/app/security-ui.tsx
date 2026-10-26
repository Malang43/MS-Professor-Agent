"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { Api } from "./account-ui";
export function Turnstile() {
  const host = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((v) => setKey(v.turnstile_site_key))
      .catch(() =>
        setError("Unable to load signup protection. Reload to try again."),
      );
  }, []);
  useEffect(() => {
    if (!key || !host.current) return;
    let widget: string | undefined,
      disposed = false;
    const render = () => {
      const t = (window as any).turnstile;
      if (disposed || !t || !host.current) return;
      widget = t.render(host.current, {
        sitekey: key,
        action: "signup",
        size: "flexible",
        "error-callback": () =>
          setError("Bot protection failed. Please reload and try again."),
      });
    };
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    script.onerror = () =>
      setError("Unable to load bot protection. Check your connection.");
    if ((window as any).turnstile) render();
    else document.head.appendChild(script);
    return () => {
      disposed = true;
      if (widget) (window as any).turnstile?.remove(widget);
      script.remove();
    };
  }, [key]);
  return (
    <>
      <div ref={host} aria-label="Signup bot protection" />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function PasskeyLogin({
  api,
  onComplete,
}: {
  api: Api;
  onComplete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="secondary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const v = await api("/auth/passkey/options", "POST", {});
            const response = await startAuthentication({
              optionsJSON: v.options,
            });
            await api("/auth/passkey/verify", "POST", {
              response,
              challenge_id: v.challenge_id,
            });
            await onComplete();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for passkey…" : "Sign in with a passkey"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function RecoveryForm({ api }: { api: Api }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (data.method === "passkey") {
        const v = await api("/auth/passkey/options", "POST", {
          recovery: true,
        });
        const response = await startAuthentication({ optionsJSON: v.options });
        await api("/auth/passkey/verify", "POST", {
          ...data,
          response,
          challenge_id: v.challenge_id,
          recovery: true,
        });
      } else await api("/auth/recovery-code", "POST", data);
      setMessage(
        "Password reset. Sign in with your new password. Previous sessions have been revoked.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Recover with a saved code or passkey</summary>
      <p>
        Losing your password, passkeys and all recovery codes may prevent
        account recovery.
      </p>
      <form onSubmit={submit}>
        <label>
          Recovery method
          <select name="method">
            <option value="code">Saved recovery code</option>
            <option value="passkey">Passkey</option>
          </select>
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Recovery code (for code recovery)
          <input name="code" autoComplete="off" maxLength={100} />
        </label>
        <label>
          New password
          <input
            name="password"
            type="password"
            required
            minLength={15}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm password
          <input
            name="confirm_password"
            type="password"
            required
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Recovering…" : "Reset password securely"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
export function SecuritySettings({ api }: { api: Api }) {
  const [state, setState] = useState<{
    passkeys: { id: string; name: string }[];
    remaining: number;
  }>({ passkeys: [], remaining: 0 });
  const [password, setPassword] = useState(""),
    [name, setName] = useState("My passkey"),
    [codes, setCodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => setState(await api("/account/security"));
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Passkeys & recovery codes</h3>
      <p>
        Keep a passkey or saved recovery codes so you can recover without email.
        Losing every recovery option may prevent access.
      </p>
      <label>
        Current password to authorize security changes
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          maxLength={128}
        />
      </label>
      <button
        className="secondary"
        disabled={busy || !password}
        onClick={() =>
          run(async () => {
            const v = await api("/account/security/recovery-codes", "POST", {
              current_password: password,
            });
            setCodes(v.codes);
          })
        }
      >
        Generate 10 recovery codes (replaces old codes)
      </button>
      <p>{state.remaining} unused recovery codes</p>
      {codes.length > 0 && (
        <div role="status">
          <p>Shown only once. Save these codes privately; each works once.</p>
          <pre className="email-preview">{codes.join("\n")}</pre>
          <button
            className="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([codes.join("\n")], { type: "text/plain" }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "ms-professor-recovery-codes.txt";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download codes
          </button>
          <button className="secondary" onClick={() => setCodes([])}>
            I saved my codes — hide
          </button>
        </div>
      )}
      <label>
        Passkey name
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={busy || !password || !name.trim()}
        onClick={() =>
          run(async () => {
            const v = await api("/account/security/passkey/options", "POST", {
              current_password: password,
            });
            const response = await startRegistration({
              optionsJSON: v.options,
            });
            await api("/account/security/passkey/verify", "POST", {
              challenge_id: v.challenge_id,
              response,
              name,
            });
          })
        }
      >
        Add passkey
      </button>
      <ul>
        {state.passkeys.map((k) => (
          <li key={k.id}>
            {k.name}{" "}
            <button
              className="secondary"
              disabled={busy || !password}
              onClick={() =>
                run(async () => {
                  await api("/account/security/passkey/remove", "POST", {
                    id: k.id,
                    current_password: password,
                  });
                })
              }
            >
              Remove passkey
            </button>
          </li>
        ))}
      </ul>
      {busy && <p role="status">Updating security options…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
