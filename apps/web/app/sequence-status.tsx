"use client";
export type SequenceStatus = {
  root_id: string;
  step: number;
  subject: string;
  body: string;
  delay_value: number;
  delay_unit: string;
  relative_to: string;
  authorized_at: number;
  due_at: number | null;
  cancel_reason: string | null;
  root_status: string;
  account_status: string;
  sync_checked_at: number;
  sending_status: string | null;
  transport_state: string | null;
  provider_id: string | null;
  next_at: number | null;
  error: string | null;
};
const time = (value: number | null | undefined) =>
  value
    ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) +
      " (Asia/Karachi)"
    : "Pending";
export function SchedulerStatus({
  scheduler,
}: {
  scheduler?: {
    started_at: number;
    completed_at: number;
    failure: string | null;
  } | null;
}) {
  return (
    <p role="status">
      Last scheduler execution: {time(scheduler?.started_at)}. Last completed:{" "}
      {time(scheduler?.completed_at)}.
      {scheduler?.failure && ` ${scheduler.failure}`} Due times are earliest
      eligible times; cron and Gmail can delay delivery.
    </p>
  );
}
export function SequenceSteps({
  steps,
  recipient,
  cancel,
  busy,
}: {
  steps: SequenceStatus[];
  recipient: (id: string) => string;
  cancel: (root: string, step: number) => void;
  busy: boolean;
}) {
  return (
    <>
      {steps.map((step) => {
        const status = step.provider_id
          ? "Sent Through Gmail"
          : step.cancel_reason === "reply"
            ? "Cancelled after reply"
            : step.cancel_reason
              ? "Cancelled: " + step.cancel_reason
              : step.account_status !== "connected"
                ? "Delayed: reconnect Gmail in Settings"
                : step.sending_status === "failed"
                  ? "Failed"
                  : ["submitting", "leased"].includes(
                        step.transport_state || "",
                      )
                    ? "Sending"
                    : step.transport_state === "uncertain"
                      ? "Delayed: reconciling Gmail acceptance; no resend"
                      : step.next_at && step.next_at > Date.now()
                        ? "Delayed due to temporary provider issue or rate limit"
                        : step.due_at && step.due_at <= Date.now()
                          ? "Due"
                          : step.due_at
                            ? "Scheduled"
                            : "Authorized; waiting for confirmed send";
        return (
          <article
            className="document-row"
            key={step.root_id + ":" + step.step}
          >
            <div>
              <strong>
                Follow-up {step.step}: {status}
              </strong>
              <p>
                {recipient(step.root_id)} ? {step.delay_value} {step.delay_unit}{" "}
                after{" "}
                {step.relative_to === "original"
                  ? "original confirmed email"
                  : "previous confirmed follow-up"}
              </p>
              <p>{step.subject}</p>
              <pre className="email-preview">{step.body}</pre>
              <p>
                Authorized: {time(step.authorized_at)} ? Due:{" "}
                {time(step.due_at)}
              </p>
              {step.due_at && <p>UTC: {new Date(step.due_at).toISOString()}</p>}
              <p>
                Last reply check: {time(step.sync_checked_at)} ? Reply detected:{" "}
                {step.cancel_reason === "reply" ||
                step.root_status === "replied"
                  ? "Yes"
                  : "No confirmed reply"}
              </p>
              <p>
                Next action:{" "}
                {step.provider_id || step.cancel_reason
                  ? "None"
                  : step.account_status !== "connected"
                    ? "Reconnect Gmail; approval is retained"
                    : step.transport_state === "uncertain"
                      ? "Reconcile Gmail; never blindly resend"
                      : "Check replies and eligibility before sending"}
              </p>
              {step.error && <p role="alert">{step.error}</p>}
              {step.provider_id && <p>Gmail message ID: {step.provider_id}</p>}
              {!step.provider_id && !step.cancel_reason && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => cancel(step.root_id, step.step)}
                >
                  Cancel this and remaining steps
                </button>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
