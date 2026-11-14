"use client";
import { useRef, useState, type ReactNode } from "react";
import { StatusBadge } from "./Badge";
import { str, writeJson } from "./api";
import { explainDecision } from "./decision-codes";
import { payloadFromSaved } from "./policy-logic";
import { Icon } from "./ui/Icon";
import type { OverviewData, PolicyData } from "./types";
/**
 * How the owner stops it (spec 11.4). Pause is a fail-safe write (it never loosens a rule, so no re-login is needed);
 * turning automation back on goes through Payment policies and its review step. The emergency stop is set by the operator
 * on the server and is never shown as a live value here: only what the last decision said.
 */
export function ControlPanel({ policy, lastDecisionCode }: { policy: PolicyData; lastDecisionCode: string | null }): ReactNode {
  const [saved, setSaved] = useState(policy);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const pause = (): void => {
    setBusy(true);
    setStatus("Pausing…");
    void writeJson("PUT", "/api/policy", { ...payloadFromSaved(saved), enabled: false }, { "if-match": `"${String(saved.version)}"` }).then((res) => {
      setBusy(false);
      if (res.status === 200 && typeof res.body.policy === "object" && res.body.policy !== null) {
        setSaved(res.body.policy as PolicyData);
        setStatus("Automation is paused. The payment service will approve nothing until you turn it back on.");
        // The button that was pressed is gone now, so move focus to a stable place instead of dropping it on the page.
        setTimeout(() => heading.current?.focus(), 0);
      } else if (res.status === 412) setStatus("The policy changed since this page loaded. Reload the page and try again.");
      else if (res.status === 401) setStatus("Your session has ended. Sign in again to continue.");
      else setStatus("Could not pause automation. Nothing was changed. Try again, or open Payment policies.");
    });
  };
  const stopped = lastDecisionCode === "EXECUTION_DISABLED";
  const last = explainDecision(lastDecisionCode);
  return (
    <section className="panel" aria-labelledby="control-title">
      <h2 id="control-title" ref={heading} tabIndex={-1}>
        Stop and resume
      </h2>
      <p>
        {saved.enabled ? <StatusBadge tone="ok" icon="check" label="Automation on" /> : <StatusBadge tone="neutral" icon="pause" label="Automation paused" />}
      </p>
      {saved.enabled ? (
        <p>
          <button type="button" className="btn btn-danger" onClick={pause} disabled={busy}>
            <Icon name="alert" />
            Pause automation
          </button>
        </p>
      ) : (
        <p>
          <a className="btn" href="/policy">
            <Icon name="arrow-right" />
            Review and turn automation back on
          </a>
        </p>
      )}
      <p role="status" aria-live="polite" className="status">
        {status}
      </p>
      <h3 className="mt-4 mb-1 text-base font-semibold text-white">Emergency stop</h3>
      <p>
        The emergency stop is a server setting that only your operator can change. It blocks every payment, whatever your rules say. This page cannot read its live value.
      </p>
      <p>
        {stopped ? (
          <>
            <StatusBadge tone="warn" icon="lock" label="Emergency stop was active" /> The emergency stop was active on the last decision.
          </>
        ) : lastDecisionCode === null ? (
          "No payment decision has been recorded yet."
        ) : (
          <>Last decision: {last.title}.</>
        )}
      </p>
    </section>
  );
}
/** Queues one run for the agent. The agent claims it through the payment service; the rules still decide every payment. */
export function RunAgentButton({ initial }: { initial: OverviewData["agent"]["run_request"] }): ReactNode {
  const [message, setMessage] = useState(initial?.status === "open" ? "Requested, waiting for the agent." : "");
  const [busy, setBusy] = useState(false);
  const run = (): void => {
    setBusy(true);
    setMessage("Requesting…");
    void writeJson("POST", "/api/agent-runs", {}).then((res) => {
      setBusy(false);
      if (res.status === 202) setMessage("Requested, waiting for the agent. Check Agent activity for the result.");
      else if (res.status === 409 && str(res.body.code) === "RUN_REQUESTED") setMessage("A run is already requested and waiting for the agent.");
      else if (res.status === 401) setMessage("Your session has ended. Sign in again to continue.");
      else setMessage("Could not request a run. Try again.");
    });
  };
  return (
    <>
      <p>
        <button type="button" className="btn" onClick={run} disabled={busy}>
          <Icon name="activity" />
          Run treasury agent
        </button>
      </p>
      <p role="status" aria-live="polite" className="status">
        {message}
      </p>
    </>
  );
}
