"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { Api } from "./account-ui";
type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
let turnstileScript: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const current = () =>
    (window as Window & { turnstile?: TurnstileApi }).turnstile;
  if (current()) return Promise.resolve(current()!);
  if (!turnstileScript) {
    turnstileScript = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error("Unable to load the security check. Please retry."));
      };
      const timer = setTimeout(fail, 15000);
      script.onload = () => {
        clearTimeout(timer);
        if (current()) resolve(current()!);
        else fail();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    }).catch((error) => {
      turnstileScript = null;
      throw error;
    });
  }
  return turnstileScript;
}
export function Turnstile({
  onReady,
  reset,
}: {
  onReady: (ready: boolean) => void;
  reset: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const [config, setConfig] = useState<{
    turnstile_site_key: string | null;
    turnstile_required: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Loading security check...");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setConfig(null);
    setStatus("Loading security check...");
    ready.current(false);
    fetch("/api/auth/config", { signal: controller.signal, cache: "no-store" })
      .then(async (r) => {
        if (!r.ok)
          throw new Error("Unable to load signup protection. Please retry.");
        return r.json();
      })
      .then((v) => {
        setConfig(v);
        if (!v.turnstile_site_key) {
          setStatus("");
          if (v.turnstile_required)
            setError(
              "The security check is temporarily unavailable. Please retry later.",
            );
          else ready.current(true);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!config?.turnstile_site_key || !host.current) return;
    let disposed = false,
      widget: string | undefined,
      api: TurnstileApi | undefined;
    setError("");
    setStatus("Complete the security check.");
    ready.current(!config.turnstile_required);
    loadTurnstile()
      .then((t) => {
        if (disposed || !host.current) return;
        api = t;
        widget = t.render(host.current, {
          sitekey: config.turnstile_site_key,
          action: "signup",
          size: host.current.clientWidth < 300 ? "compact" : "flexible",
          appearance: "always",
          callback: () => {
            setStatus("Security check complete.");
            setError("");
            ready.current(true);
          },
          "expired-callback": () => {
            setStatus("Security check expired. Please complete it again.");
            ready.current(!config.turnstile_required);
          },
          "timeout-callback": () => {
            setStatus("Security check timed out. Please try again.");
            ready.current(!config.turnstile_required);
          },
          "error-callback": () => {
            setError("The security check failed. Please retry.");
            ready.current(!config.turnstile_required);
          },
        });
      })
      .catch((e) => {
        if (!disposed) {
          setError(e.message);
          ready.current(!config.turnstile_required);
        }
      });
    return () => {
      disposed = true;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [config, reset]);
  return (
    <div className="signup-protection">
      <div ref={host} aria-label="Signup bot protection" />
      {status && (
        <p className="helper" role="status">
          {status}
        </p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry security check
          </button>
        </>
      )}
    </div>
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
      <summary>Recover with saved recovery code</summary>
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
