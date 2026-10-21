"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  GraduationCap,
  LayoutDashboard,
  Users,
  Send,
  FileText,
  CalendarClock,
  Settings,
  ChevronRight,
  Plus,
  ArrowUpRight,
  Search,
  Bell,
  Sparkles,
  Upload,
  Pause,
  Play,
  Square,
  LogOut,
  ShieldCheck,
  Clock,
  Check,
  Mail,
  Menu,
  X,
  History,
} from "lucide-react";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file";
import { localDate, zonedISO } from "../lib/timezone";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
type Profile = {
  name: string;
  university: string;
  degree: string;
  gpa: string;
  interests: string;
  timezone: string;
  paused: number;
  stopped: number;
};
type Professor = {
  id: string;
  name: string;
  email: string;
  university: string;
  interests: string;
};
type Doc = { id: string; name: string; size: number };
type Message = {
  id: string;
  professor_id: string;
  professor_name: string;
  professor_email: string;
  subject: string;
  body: string;
  mode: string;
  status: string;
  scheduled_at: string;
  timezone: string;
  followup_at: string | null;
  attachments: string[];
  error: string | null;
};
type Audit = { id: string; action: string; created_at: string };
type State = {
  profile: Profile;
  professors: Professor[];
  documents: Doc[];
  messages: Message[];
  audit: Audit[];
  account: { email: string };
};
const nav = [
  ["Overview", LayoutDashboard],
  ["Professors", Users],
  ["Outreach", Send],
  ["Documents", FileText],
  ["Follow-ups", CalendarClock],
  ["Academic profile", GraduationCap],
  ["Settings", Settings],
  ["Audit history", History],
] as const;
const initialProfile = {
  name: "",
  university: "",
  degree: "",
  gpa: "",
  interests: "",
  timezone: "Asia/Karachi",
  paused: 0,
  stopped: 0,
};
async function request(path: string, method = "GET", data?: unknown) {
  const res = await fetch(API + "/api" + path, {
    method,
    credentials: "include",
    headers:
      data instanceof FormData
        ? {}
        : data
          ? { "Content-Type": "application/json" }
          : {},
    body:
      data instanceof FormData ? data : data ? JSON.stringify(data) : undefined,
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}
function displayDate(value: string, tz: string) {
  return new Date(value).toLocaleString(undefined, {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  });
}
export default function Home() {
  const [state, setState] = useState<State | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("Overview"),
    [authMode, setAuthMode] = useState("login"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState<"professor" | "compose" | null>(null),
    [review, setReview] = useState<Message | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [professor, setProfessor] = useState({
    name: "",
    email: "",
    university: "",
    interests: "",
  });
  const [draft, setDraft] = useState({
    professor_id: "",
    subject: "",
    body: "",
    mode: "manual",
    authorized: false,
    scheduled_at: localDate("Asia/Karachi"),
    timezone: "Asia/Karachi",
    attachments: [] as string[],
  });
  async function refresh() {
    try {
      const data = await request("/state");
      setState(data);
      setProfile(data.profile);
    } catch (e) {
      if (e instanceof Error && e.message === "Unauthorized") setState(null);
      else throw e;
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>, message = "Saved successfully") {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  function compose(professorId = "") {
    setDraft({
      professor_id: professorId || state?.professors[0]?.id || "",
      subject: "",
      body: "",
      mode: "manual",
      authorized: false,
      scheduled_at: localDate(state?.profile.timezone || "Asia/Karachi"),
      timezone: state?.profile.timezone || "Asia/Karachi",
      attachments: [],
    });
    setModal("compose");
  }
  async function importFile(file: File) {
    if (file.size > 5 * 1024 * 1024) throw new Error("Import limit is 5 MB");
    let rows: Record<string, string>[];
    if (file.name.toLowerCase().endsWith(".xlsx")) {
      const sheet = await readXlsxFile(file);
      const headers = sheet[0]?.map((h) => String(h).trim().toLowerCase());
      rows = sheet
        .slice(1)
        .filter((r) => r.some(Boolean))
        .map((row) =>
          Object.fromEntries(
            headers.map((h, i) => [h, String(row[i] ?? "").trim()]),
          ),
        );
    } else {
      const parsed = Papa.parse<Record<string, string>>(await file.text(), {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (h) => h.trim().toLowerCase(),
      });
      if (parsed.errors.length)
        throw new Error("Invalid CSV: " + parsed.errors[0].message);
      rows = parsed.data;
    }
    if (!rows.length || rows.length > 500)
      throw new Error("Import between 1 and 500 professors");
    const result = await request(
      "/professors",
      "POST",
      rows.map((r) => ({
        name: r.name || "",
        email: r.email || "",
        university: r.university || "",
        interests: r.interests || "",
      })),
    );
    setNotice(
      `${result.imported} professors imported; duplicate emails skipped.`,
    );
  }
  const messages = state?.messages || [],
    professors = state?.professors || [];
  const filtered = messages.filter((m) =>
    (m.professor_name + " " + m.subject + " " + m.status)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const followups = messages.filter(
    (m) => m.followup_at && m.status === "sent",
  );
  const counts = {
    sent: messages.filter((m) => ["sent", "replied"].includes(m.status)).length,
    replied: messages.filter((m) => m.status === "replied").length,
    pending: messages.filter((m) => ["draft", "pending"].includes(m.status))
      .length,
    failed: messages.filter((m) => m.status === "failed").length,
  };
  const feedback = (
    <>
      {error && (
        <div role="alert" className="feedback error">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="feedback success">
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
  if (loading)
    return (
      <main className="auth">
        <GraduationCap size={44} />
        <p>Opening your workspace…</p>
      </main>
    );
  if (!state)
    return (
      <main className="auth">
        <div className="auth-brand">
          <GraduationCap size={32} />
          <span>
            MS Professor
            <br />
            <b>Outreach Agent</b>
          </span>
        </div>
        <div className="auth-card">
          <span className="eyebrow">YOUR NEXT CHAPTER</span>
          <h1>
            Research starts
            <br />
            with a conversation.
          </h1>
          <p>
            A thoughtful workspace for your MS journey. Organize professors,
            prepare your story, and keep every opportunity moving.
          </p>
          <div className="tabs">
            <button
              className={authMode === "login" ? "active" : ""}
              onClick={() => setAuthMode("login")}
            >
              Sign in
            </button>
            <button
              className={authMode === "signup" ? "active" : ""}
              onClick={() => setAuthMode("signup")}
            >
              Create account
            </button>
          </div>
          {feedback}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              act(async () => {
                await request("/auth/" + authMode, "POST", {
                  email: data.get("email"),
                  password: data.get("password"),
                });
              }, "Welcome to your workspace");
            }}
          >
            <label>
              Email address
              <input
                name="email"
                type="email"
                required
                placeholder="student@university.edu"
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                required
                placeholder="At least 12 characters"
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
              />
            </label>
            <button className="primary full" disabled={busy}>
              {busy
                ? "Please wait…"
                : authMode === "login"
                  ? "Open my workspace"
                  : "Create student account"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          <div className="security-note">
            <ShieldCheck size={16} /> Private workspace · Mock sending only
          </div>
        </div>
        <footer>
          MS PROFESSOR OUTREACH AGENT{" "}
          <span>PHASE 01 / RESEARCH WITH INTENTION</span>
        </footer>
      </main>
    );
  const table = (items: Message[]) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>
              <span className="sr-only">Select manual drafts</span>
            </th>
            <th>PROFESSOR / SUBJECT</th>
            <th>WORKFLOW</th>
            <th>STATUS</th>
            <th>SCHEDULE</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td>
                {m.mode === "manual" && m.status === "draft" && (
                  <input
                    aria-label={`Select ${m.professor_name}`}
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, m.id]
                          : selected.filter((x) => x !== m.id),
                      )
                    }
                  />
                )}
              </td>
              <td>
                <button className="text-link" onClick={() => setReview(m)}>
                  {m.professor_name}
                </button>
                <small>{m.subject}</small>
              </td>
              <td>
                <span className="muted">
                  {m.mode === "manual"
                    ? "Manual"
                    : m.mode === "review"
                      ? "AI · review"
                      : "AI · authorized"}
                </span>
              </td>
              <td>
                <span className={"badge " + m.status}>{m.status}</span>
                {m.error && <small>{m.error}</small>}
              </td>
              <td>
                <small>
                  {displayDate(m.scheduled_at, m.timezone)}
                  <br />
                  {m.timezone}
                </small>
              </td>
              <td>
                <div className="actions">
                  {m.status === "draft" && (
                    <button onClick={() => setReview(m)}>Review</button>
                  )}
                  {m.status === "pending" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await request(
                            `/messages/${m.id}/simulate-failure`,
                            "POST",
                          );
                        }, "Provider failure simulated; no email sent")
                      }
                    >
                      Simulate failure
                    </button>
                  )}
                  {["draft", "pending"].includes(m.status) && (
                    <button
                      onClick={() =>
                        act(async () => {
                          await request(`/messages/${m.id}/cancel`, "POST");
                        }, "Message cancelled")
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {m.status === "sent" && (
                    <>
                      <button
                        onClick={() =>
                          act(async () => {
                            await request(`/messages/${m.id}/reply`, "POST");
                          }, "Reply recorded manually")
                        }
                      >
                        Mark replied
                      </button>
                      <button onClick={() => setReview(m)}>Follow up</button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty">
          <Mail size={30} />
          <h3>Your next conversation starts here</h3>
          <p>Add a professor and prepare your first outreach draft.</p>
          <button
            className="secondary"
            onClick={() =>
              professors.length ? compose() : setModal("professor")
            }
          >
            {professors.length ? "Compose email" : "Add professor"}
            <Plus size={15} />
          </button>
        </div>
      )}
    </div>
  );
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (mobile ? "open" : "")}>
        <a className="brand" href="/">
          {" "}
          <div className="brand-icon">
            <GraduationCap size={24} />
          </div>
          <div>
            MS Professor<span>OUTREACH AGENT</span>
          </div>
        </a>
        <div className="workspace-label">
          STUDENT WORKSPACE <span>01</span>
        </div>
        <nav>
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              className={view === name ? "active" : ""}
              onClick={() => {
                setView(name);
                setQuery("");
                setMobile(false);
              }}
            >
              <Icon size={19} />
              {name}
              {name === "Outreach" && counts.pending > 0 && (
                <span className="nav-count">{counts.pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mock-card">
            <span className="dot" /> PHASE 1 WORKSPACE
            <p>
              Build connections.
              <br />
              Explore possibilities.
            </p>
            <small>All emails & AI are simulated.</small>
          </div>
          <button className="user" onClick={() => setView("Academic profile")}>
            <span className="avatar">
              {(profile.name || state.account.email).slice(0, 2).toUpperCase()}
            </span>
            <span>
              {profile.name || "Your workspace"}
              <small>Student account</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <button
            className="logout"
            onClick={() =>
              act(async () => {
                await request("/auth/logout", "POST");
                setState(null);
              }, "Signed out")
            }
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={21} />
            </button>
            Workspace <ChevronRight size={13} />
            <strong>{view}</strong>
          </div>
          <div className="top-actions">
            <span className="sandbox">
              <span className="dot" />
              Mock environment
            </span>
            <button
              aria-label="Follow-up notifications"
              className="notification"
              onClick={() => setView("Follow-ups")}
            >
              <Bell size={19} />
              {followups.length > 0 && <i />}
            </button>
            <span className="avatar small">
              {(profile.name || "ST").slice(0, 2).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="content">
          {feedback}
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR ACADEMIC JOURNEY, ORGANIZED</div>
              <h1>
                {view === "Overview"
                  ? `Welcome back${profile.name ? ", " + profile.name.split(" ")[0] : ""}.`
                  : view}
              </h1>
              <p>
                {view === "Overview"
                  ? "Small steps today. Meaningful research opportunities tomorrow."
                  : view === "Professors"
                    ? "Find your research fit and keep every connection in one place."
                    : view === "Outreach"
                      ? "Thoughtful messages. Clear approvals. You stay in control."
                      : view === "Documents"
                        ? "Your academic story, securely stored and ready to share."
                        : view === "Follow-ups"
                          ? "Keep the conversation moving, at the right time."
                          : view === "Settings"
                            ? "Manage your workspace and future email connections."
                            : view === "Audit history"
                              ? "A transparent record of activity in your student workspace."
                              : "Help professors understand the researcher behind the email."}
              </p>
            </div>
            {["Overview", "Outreach"].includes(view) && (
              <button className="primary" onClick={() => compose()}>
                <Plus size={17} /> Compose outreach
              </button>
            )}
            {view === "Professors" && (
              <button className="primary" onClick={() => setModal("professor")}>
                <Plus size={17} /> Add professor
              </button>
            )}
          </div>
          {profile.paused || profile.stopped ? (
            <div className="control-banner">
              <Pause size={18} />
              {profile.stopped
                ? "Outreach stopped. All outstanding drafts and scheduled messages were cancelled."
                : "Outreach is paused. Scheduled mock messages will wait."}
              <button
                onClick={() =>
                  act(async () => {
                    await request("/control", "POST", { action: "resume" });
                  }, "Outreach resumed")
                }
              >
                Resume workspace
              </button>
            </div>
          ) : null}
          {view === "Overview" && (
            <>
              <section className="hero">
                <div>
                  <span className="hero-label">
                    <span className="dot" /> A LITTLE MOMENTUM GOES A LONG WAY
                  </span>
                  <h2>
                    Your next chapter
                    <br />
                    starts with a connection.
                  </h2>
                  <p>
                    Discover professors, personalize your outreach,
                    <br />
                    and make room for what comes next.
                  </p>
                  <button onClick={() => setView("Professors")}>
                    Explore your professors <ArrowUpRight size={17} />
                  </button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-card paper-back" />
                  <div className="art-card paper-front">
                    <div className="art-stamp">
                      <GraduationCap size={29} />
                    </div>
                    <div className="art-line long" />
                    <div className="art-line" />
                    <div className="art-line short" />
                    <div className="art-bottom">
                      <span />
                      <Check size={15} />
                    </div>
                  </div>
                  <div className="floating-star">
                    <Sparkles size={23} />
                  </div>
                  <div className="connection-label">
                    <span className="dot" /> A world of possibilities
                  </div>
                </div>
              </section>
              <section className="stats">
                {[
                  {
                    label: "Professors saved",
                    value: professors.length,
                    icon: Users,
                    note: "Your research network",
                  },
                  {
                    label: "Emails sent",
                    value: counts.sent,
                    icon: Send,
                    note: "Simulated deliveries",
                  },
                  {
                    label: "Replies recorded",
                    value: counts.replied,
                    icon: Mail,
                    note: counts.sent
                      ? `${Math.round((counts.replied / counts.sent) * 100)}% response rate`
                      : "Every conversation counts",
                  },
                  {
                    label: "Awaiting action",
                    value: counts.pending,
                    icon: Clock,
                    note: `${counts.failed} failed · Review & scheduled`,
                  },
                ].map(({ label, value, icon: Icon, note }) => (
                  <article className="stat" key={label}>
                    <div>
                      {label}
                      <Icon size={18} />
                    </div>
                    <strong>{value.toString().padStart(2, "0")}</strong>
                    <small>{note}</small>
                  </article>
                ))}
              </section>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Outreach activity</h2>
                      <p>Your latest conversations at a glance.</p>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => setView("Outreach")}
                    >
                      View all <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {table(messages.slice(0, 5))}
                </section>
                <section className="panel journey">
                  <span className="eyebrow">
                    MAKE YOUR FIRST IMPRESSION COUNT
                  </span>
                  <h2>
                    A little preparation.
                    <br />A stronger connection.
                  </h2>
                  {[
                    {
                      label: "Complete your academic profile",
                      done: !!profile.name && !!profile.interests,
                      target: "Academic profile",
                    },
                    {
                      label: "Upload your latest CV",
                      done: state.documents.length > 0,
                      target: "Documents",
                    },
                    {
                      label: "Build your professor shortlist",
                      done: professors.length > 0,
                      target: "Professors",
                    },
                    {
                      label: "Prepare your first outreach",
                      done: messages.length > 0,
                      target: "Outreach",
                    },
                  ].map((step, i) => (
                    <button
                      className="journey-step"
                      key={step.label}
                      onClick={() => setView(step.target)}
                    >
                      <span className={step.done ? "done" : ""}>
                        {step.done ? <Check size={13} /> : i + 1}
                      </span>
                      {step.label}
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  <div className="tip">
                    <Sparkles size={18} />
                    <p>
                      <strong>Make it personal.</strong> A specific research
                      connection says more than a generic introduction.
                    </p>
                  </div>
                </section>
              </div>
            </>
          )}
          {view === "Professors" && (
            <>
              <div className="toolbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search professors"
                    placeholder="Search professors, universities, research…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <label className="secondary upload-label">
                  <Upload size={16} /> Import CSV / Excel
                  <input
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) act(() => importFile(file), "Import complete");
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              <p className="helper">
                Columns: name, email, university, interests. Up to 500 rows.
                Duplicate emails are skipped.{" "}
                <a download href="/professors-template.csv">
                  Download CSV template
                </a>
              </p>
              <div className="professor-grid">
                {professors
                  .filter((p) =>
                    (p.name + p.university + p.interests)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <article className="panel professor-card" key={p.id}>
                      <span className="professor-avatar">
                        {p.name
                          .split(" ")
                          .map((x) => x[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <h2>{p.name}</h2>
                      <p>{p.university || "University not specified"}</p>
                      <span className="research-tag">
                        {p.interests || "Research interests to explore"}
                      </span>
                      <small>{p.email}</small>
                      <button
                        className="secondary"
                        onClick={() => compose(p.id)}
                      >
                        Prepare outreach <ArrowUpRight size={16} />
                      </button>
                    </article>
                  ))}
              </div>
              {!professors.length && (
                <div className="panel empty">
                  <Users size={32} />
                  <h3>Build your research shortlist</h3>
                  <p>Add professors individually or import your spreadsheet.</p>
                  <button
                    className="primary"
                    onClick={() => setModal("professor")}
                  >
                    Add your first professor
                  </button>
                </div>
              )}
            </>
          )}
          {view === "Outreach" && (
            <section className="panel">
              <div className="panel-heading">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search outreach"
                    placeholder="Search messages or status…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy || !selected.length}
                    onClick={() =>
                      act(async () => {
                        await request("/messages/approve", "POST", {
                          ids: selected,
                        });
                        setSelected([]);
                      }, "Selected manual drafts approved")
                    }
                  >
                    Approve selected ({selected.length})
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request("/jobs/run", "POST");
                      }, "Due approved messages processed by mock provider")
                    }
                  >
                    Run mock scheduler
                  </button>
                </div>
              </div>
              {table(filtered)}
              <div className="panel-footer">
                <ShieldCheck size={16} /> AI review drafts require individual
                approval. Auto mode requires explicit authorization. No real
                email is sent.
              </div>
            </section>
          )}
          {view === "Documents" && (
            <section className="panel">
              <div className="upload-zone">
                <div className="upload-icon">
                  <Upload size={25} />
                </div>
                <h2>Your documents, ready for the right opportunity.</h2>
                <p>
                  Upload a CV, transcript, or research statement. Only you can
                  access these files.
                </p>
                <label className="primary upload-label">
                  <Plus size={16} /> Upload document
                  <input
                    disabled={busy}
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        act(async () => {
                          const form = new FormData();
                          form.set("file", file);
                          await request("/documents", "POST", form);
                        }, "Private document uploaded");
                      e.target.value = "";
                    }}
                  />
                </label>
                <small>PDF, DOCX, TXT · Maximum 10 MB per file</small>
              </div>
              <div className="document-list">
                {state.documents.map((d) => (
                  <div className="document-row" key={d.id}>
                    <div className="file-icon">
                      <FileText size={23} />
                    </div>
                    <div>
                      <strong>{d.name}</strong>
                      <small>{(d.size / 1024).toFixed(1)} KB · Private</small>
                    </div>
                    <a
                      className="secondary"
                      href={`${API}/api/documents/${d.id}`}
                    >
                      Download <ArrowUpRight size={15} />
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}
          {view === "Academic profile" && (
            <form
              className="panel profile-form"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  await request("/profile", "PUT", profile);
                }, "Academic profile updated");
              }}
            >
              <div className="section-title">
                <GraduationCap size={22} />
                <div>
                  <h2>The researcher behind the introduction</h2>
                  <p>Used to personalize your mock AI drafts.</p>
                </div>
              </div>
              <div className="form-grid">
                {(["name", "university", "degree", "gpa"] as const).map(
                  (key) => (
                    <label key={key}>
                      {
                        {
                          name: "Full name",
                          university: "University",
                          degree: "Degree / program",
                          gpa: "GPA / grade",
                        }[key]
                      }
                      <input
                        value={profile[key]}
                        onChange={(e) =>
                          setProfile({ ...profile, [key]: e.target.value })
                        }
                        placeholder={
                          {
                            name: "Your full name",
                            university: "Your current university",
                            degree: "BS Computer Science",
                            gpa: "3.8 / 4.0",
                          }[key]
                        }
                      />
                    </label>
                  ),
                )}
              </div>
              <label>
                Research interests
                <textarea
                  rows={4}
                  value={profile.interests}
                  onChange={(e) =>
                    setProfile({ ...profile, interests: e.target.value })
                  }
                  placeholder="e.g. Machine learning, computational biology, sustainable systems"
                />
              </label>
              <label>
                Default timezone
                <input
                  required
                  value={profile.timezone}
                  onChange={(e) =>
                    setProfile({ ...profile, timezone: e.target.value })
                  }
                  list="timezones"
                />
              </label>
              <button className="primary" disabled={busy}>
                Save academic profile <Check size={16} />
              </button>
            </form>
          )}
          {view === "Follow-ups" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Follow-up reminders</h2>
                  <p>
                    Reminders only. Follow-up emails are never sent
                    automatically.
                  </p>
                </div>
                <span className="badge pending">
                  {followups.length} reminders
                </span>
              </div>
              {followups.map((m) => (
                <div className="document-row" key={m.id}>
                  <div className="file-icon">
                    <CalendarClock size={23} />
                  </div>
                  <div>
                    <strong>{m.professor_name}</strong>
                    <small>
                      {displayDate(m.followup_at!, m.timezone)} · {m.timezone}
                    </small>
                  </div>
                  <span
                    className={
                      "badge " +
                      (new Date(m.followup_at!) <= new Date()
                        ? "pending"
                        : "draft")
                    }
                  >
                    {new Date(m.followup_at!) <= new Date()
                      ? "Due"
                      : "Upcoming"}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => compose(m.professor_id)}
                  >
                    Prepare follow-up
                  </button>
                </div>
              ))}
              {!followups.length && (
                <div className="empty">
                  <CalendarClock size={30} />
                  <h3>A little space for the next conversation</h3>
                  <p>Open a sent message to set a follow-up reminder.</p>
                </div>
              )}
            </section>
          )}
          {view === "Settings" && (
            <div className="settings-grid">
              <section className="panel settings-card">
                <h2>Email connections</h2>
                <p>
                  Phase 1 uses a mock mailbox. No OAuth credentials are
                  requested or stored.
                </p>
                {["Gmail · Gmail API", "Microsoft Outlook · Graph API"].map(
                  (provider) => (
                    <div className="provider" key={provider}>
                      <Mail size={21} />
                      <strong>{provider}</strong>
                      <span className="badge draft">Phase 2</span>
                    </div>
                  ),
                )}
                <div className="tip">
                  <ShieldCheck size={19} />
                  <p>
                    Real account connections will use restricted OAuth scopes
                    and encrypted tokens.
                  </p>
                </div>
                <h3>AI provider</h3>
                <div className="provider">
                  <Sparkles size={20} />
                  <strong>Mock draft generator</strong>
                  <span className="badge sent">Active</span>
                </div>
                <p className="helper">
                  Groq and alternative providers are planned for Phase 2.
                </p>
              </section>
              <section className="panel settings-card">
                <h2>Outreach controls</h2>
                <p>
                  Controls apply to your student account and are checked by
                  every scheduler run.
                </p>
                <div className="control-buttons">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        async () => {
                          await request("/control", "POST", {
                            action: profile.paused ? "resume" : "pause",
                          });
                        },
                        profile.paused ? "Outreach resumed" : "Outreach paused",
                      )
                    }
                  >
                    {profile.paused ? <Play size={17} /> : <Pause size={17} />}{" "}
                    {profile.paused ? "Resume outreach" : "Pause outreach"}
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Stop outreach and cancel all your outstanding drafts and scheduled messages?",
                        )
                      )
                        act(async () => {
                          await request("/control", "POST", { action: "stop" });
                        }, "Outreach stopped; outstanding messages cancelled");
                    }}
                  >
                    <Square size={16} /> Stop all outreach
                  </button>
                </div>
                <div className="helper">
                  Pause preserves the queue. Stop cancels outstanding messages.
                  Resuming does not restore cancelled messages.
                </div>
                <h3>Account</h3>
                <p>{state.account.email}</p>
                <span className="security-note">
                  <ShieldCheck size={15} /> Private documents · Isolated student
                  records
                </span>
              </section>
            </div>
          )}
          {view === "Audit history" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Workspace activity</h2>
                  <p>
                    Most recent 100 account events. All times shown in{" "}
                    {profile.timezone}.
                  </p>
                </div>
              </div>
              {state.audit.map((a) => (
                <div className="audit-row" key={a.id}>
                  <History size={16} />
                  <strong>
                    {a.action.replaceAll(".", " · ").replaceAll("_", " ")}
                  </strong>
                  <small>
                    {displayDate(
                      a.created_at.includes("T")
                        ? a.created_at
                        : a.created_at.replace(" ", "T") + "Z",
                      profile.timezone,
                    )}
                  </small>
                </div>
              ))}
            </section>
          )}
          <footer className="main-footer">
            <span>Made for your next academic chapter.</span>
            <span>
              <ShieldCheck size={13} /> Your workspace. Your pace.
            </span>
          </footer>
        </main>
      </div>
      <datalist id="timezones">
        {[
          "Asia/Karachi",
          "Asia/Kolkata",
          "Asia/Dhaka",
          "Europe/London",
          "Europe/Berlin",
          "America/New_York",
          "America/Chicago",
          "America/Los_Angeles",
          "Asia/Shanghai",
          "Asia/Tokyo",
          "Australia/Sydney",
          "UTC",
        ].map((t) => (
          <option key={t}>{t}</option>
        ))}
      </datalist>
      {(modal || review) && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">BUILD A MEANINGFUL CONNECTION</span>
                <h2 id="dialog-title">
                  {review
                    ? "Review outreach"
                    : modal === "professor"
                      ? "Add a professor"
                      : "Compose outreach"}
                </h2>
              </div>
              <button
                aria-label="Close dialog"
                onClick={() => {
                  setModal(null);
                  setReview(null);
                }}
              >
                <X size={21} />
              </button>
            </div>
            {error && (
              <div role="alert" className="feedback error">
                {error}
              </div>
            )}
            {modal === "professor" && (
              <form
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  act(async () => {
                    await request("/professors", "POST", [professor]);
                    setProfessor({
                      name: "",
                      email: "",
                      university: "",
                      interests: "",
                    });
                    setModal(null);
                  }, "Professor added to your shortlist");
                }}
              >
                {(["name", "email", "university", "interests"] as const).map(
                  (key) => (
                    <label key={key}>
                      {key === "name"
                        ? "Professor name"
                        : key[0].toUpperCase() + key.slice(1)}
                      <input
                        required={key === "name" || key === "email"}
                        type={key === "email" ? "email" : "text"}
                        value={professor[key]}
                        onChange={(e) =>
                          setProfessor({ ...professor, [key]: e.target.value })
                        }
                      />
                    </label>
                  ),
                )}
                <button className="primary" disabled={busy}>
                  Add professor <Plus size={16} />
                </button>
              </form>
            )}
            {modal === "compose" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(
                    async () => {
                      await request("/messages", "POST", {
                        ...draft,
                        scheduled_at: zonedISO(
                          draft.scheduled_at,
                          draft.timezone,
                        ),
                      });
                      setModal(null);
                    },
                    draft.mode === "auto"
                      ? "Authorized mock email scheduled"
                      : "Draft saved for approval",
                  );
                }}
              >
                <label>
                  Professor
                  <select
                    required
                    value={draft.professor_id}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        professor_id: e.target.value,
                        authorized: false,
                      })
                    }
                  >
                    <option value="">Choose a professor</option>
                    {professors.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.university}
                      </option>
                    ))}
                  </select>
                </label>
                {!professors.length && (
                  <p className="helper">
                    Add a professor before composing a message.
                  </p>
                )}
                <label>
                  Workflow
                  <select
                    value={draft.mode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        mode: e.target.value,
                        authorized: false,
                      })
                    }
                  >
                    <option value="manual">
                      A · Manual email + batch approval
                    </option>
                    <option value="review">
                      B · AI draft + individual review
                    </option>
                    <option value="auto">
                      C · AI draft + explicit auto-send authorization
                    </option>
                  </select>
                </label>
                {draft.mode !== "manual" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !draft.professor_id}
                    onClick={() =>
                      act(async () => {
                        const result = await request("/draft", "POST", {
                          professor_id: draft.professor_id,
                        });
                        setDraft({
                          ...draft,
                          subject: result.subject,
                          body: result.body,
                          authorized: false,
                        });
                      }, "Mock AI draft generated — personalize before scheduling")
                    }
                  >
                    <Sparkles size={16} /> Generate mock AI draft
                  </button>
                )}
                <label>
                  Subject
                  <input
                    required
                    maxLength={500}
                    value={draft.subject}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        subject: e.target.value,
                        authorized: false,
                      })
                    }
                  />
                </label>
                <label>
                  Email body
                  <textarea
                    required
                    rows={9}
                    maxLength={20000}
                    value={draft.body}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        body: e.target.value,
                        authorized: false,
                      })
                    }
                  />
                </label>
                <fieldset>
                  <legend>Attachments for this professor</legend>
                  {state.documents.map((d) => (
                    <label className="checkbox-label" key={d.id}>
                      <input
                        type="checkbox"
                        checked={draft.attachments.includes(d.id)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            authorized: false,
                            attachments: e.target.checked
                              ? [...draft.attachments, d.id]
                              : draft.attachments.filter((x) => x !== d.id),
                          })
                        }
                      />
                      {d.name}
                    </label>
                  ))}
                  {!state.documents.length && (
                    <p className="helper">
                      Upload a private document in the Documents tab first.
                    </p>
                  )}
                </fieldset>
                <div className="form-grid">
                  <label>
                    Send at (in selected timezone)
                    <input
                      type="datetime-local"
                      required
                      value={draft.scheduled_at}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          scheduled_at: e.target.value,
                          authorized: false,
                        })
                      }
                    />
                  </label>
                  <label>
                    IANA timezone
                    <input
                      required
                      list="timezones"
                      value={draft.timezone}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          timezone: e.target.value,
                          authorized: false,
                        })
                      }
                    />
                  </label>
                </div>
                <p className="helper">
                  A repeated daylight-saving hour resolves to one valid
                  occurrence. Review the UTC time after saving.
                </p>
                {draft.mode === "auto" && (
                  <label className="authorization">
                    <input
                      required
                      type="checkbox"
                      checked={draft.authorized}
                      onChange={(e) =>
                        setDraft({ ...draft, authorized: e.target.checked })
                      }
                    />
                    <span>
                      I reviewed this exact subject, body, recipient, schedule,
                      and attachments. I explicitly authorize its automatic mock
                      delivery without another approval.
                    </span>
                  </label>
                )}
                <button
                  className="primary full"
                  disabled={busy || !professors.length}
                >
                  {draft.mode === "auto"
                    ? "Authorize & schedule mock email"
                    : "Save draft for review"}
                  <Send size={16} />
                </button>
              </form>
            )}
            {review && (
              <>
                <div className="review-recipient">
                  <span className="badge draft">{review.mode}</span>
                  <strong>To: {review.professor_name}</strong>
                  <small>{review.professor_email}</small>
                </div>
                <h3>{review.subject}</h3>
                <pre className="email-preview">{review.body}</pre>
                <p className="helper">
                  {displayDate(review.scheduled_at, review.timezone)} ·{" "}
                  {review.timezone}
                  <br />
                  UTC: {review.scheduled_at}
                  <br />
                  Attachments:{" "}
                  {review.attachments
                    .map(
                      (a) => state.documents.find((d) => d.id === a)?.name || a,
                    )
                    .join(", ") || "None"}
                </p>
                {review.status === "draft" && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request("/messages/approve", "POST", {
                          ids: [review.id],
                        });
                        setReview(null);
                      }, "Reviewed email approved for mock delivery")
                    }
                  >
                    <Check size={16} /> Approve this exact email
                  </button>
                )}
                {review.status === "sent" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      act(async () => {
                        await request(
                          `/messages/${review.id}/followup`,
                          "POST",
                          {
                            date: zonedISO(
                              String(data.get("date")),
                              review.timezone,
                            ),
                          },
                        );
                        setReview(null);
                      }, "Follow-up reminder saved");
                    }}
                  >
                    <label>
                      Follow-up reminder in {review.timezone}
                      <input name="date" type="datetime-local" required />
                    </label>
                    <button className="primary" disabled={busy}>
                      Set reminder <Bell size={16} />
                    </button>
                  </form>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
