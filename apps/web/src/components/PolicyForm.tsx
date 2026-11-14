"use client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { StatusBadge } from "./Badge";
import { getJson, str, writeJson } from "./api";
import { formatInstant } from "./format";
import { Icon } from "./ui/Icon";
import { draftFrom, payloadFromSaved, riskyChanges, validate, type Draft, type FieldErrors, type FieldKey, type PolicyPayload } from "./policy-logic";
import type { PolicyData, PolicyResponse, RlusdPair } from "./types";
interface Props {
  initial: PolicyData;
  timezone: string | null;
  pair: RlusdPair;
}
interface SummaryItem {
  text: string;
  href?: string;
}
const FIELD_IDS: Record<FieldKey, string> = {
  max_payment_amount: "max_payment_amount",
  daily_spend_limit: "daily_spend_limit",
  minimum_reserve: "minimum_reserve",
  valid_until: "valid_until",
};
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function PolicyForm({ initial, timezone, pair }: Props): ReactNode {
  const [saved, setSaved] = useState<PolicyData>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, pair));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverItems, setServerItems] = useState<SummaryItem[]>([]);
  const [conflict, setConflict] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ payload: PolicyPayload; items: string[] } | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const items: SummaryItem[] = [
    ...(Object.keys(errors) as FieldKey[]).flatMap((k) => (errors[k] === undefined ? [] : [{ text: errors[k] ?? "", href: `#${FIELD_IDS[k]}` }])),
    ...serverItems,
  ];
  const hasSummary = items.length > 0;
  useEffect(() => {
    if (hasSummary) summaryRef.current?.focus();
  }, [hasSummary, errors, serverItems]);
  useEffect(() => {
    if (review !== null) dialogTitleRef.current?.focus();
  }, [review]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((d) => ({ ...d, [key]: value }));
  const closeReview = (): void => {
    setReview(null);
    // Return focus to the control that opened the review so keyboard users keep their place.
    const target = opener.current;
    setTimeout(() => target?.focus(), 0);
  };
  const apply = (p: PolicyData): void => {
    setSaved(p);
    setDraft(draftFrom(p, pair));
  };
  const send = (payload: PolicyPayload, confirmed: boolean): void => {
    setBusy(true);
    setServerItems([]);
    setConflict(false);
    setReauth(false);
    setStatus("Saving…");
    void writeJson("PUT", "/api/policy", confirmed ? { ...payload, confirm_risky: true } : payload, { "if-match": `"${String(saved.version)}"` }).then((res) => {
      setBusy(false);
      const code = str(res.body.code);
      if (res.status === 200 && typeof res.body.policy === "object" && res.body.policy !== null) {
        apply(res.body.policy as PolicyData);
        const changed = Array.isArray(res.body.changed) ? res.body.changed.length : 0;
        setStatus(changed === 0 ? "No changes to save." : "Saved. The payment service now enforces these limits on its next request.");
        return;
      }
      setStatus("");
      if (res.status === 412) {
        setConflict(true);
        setServerItems([{ text: "The policy was changed since you opened this page. Load the latest values, review them and try again." }]);
      } else if (res.status === 401 && code === "REAUTH_REQUIRED") {
        setReauth(true);
        setServerItems([{ text: "For your safety, sign in again before changing payment rules." }]);
      } else if (res.status === 401) {
        setReauth(true);
        setServerItems([{ text: "Your session has ended. Sign in again to continue." }]);
      } else if (res.status === 422 && code === "CONFIRMATION_REQUIRED") {
        const list = riskyChanges(saved, payload);
        setReview({ payload, items: list.length > 0 ? list : ["This change loosens a protection."] });
      } else if (res.status === 400) {
        setServerItems([{ text: "The payment service did not accept these values. Check each field and try again." }]);
      } else {
        setServerItems([{ text: "The policy could not be saved. Nothing was changed. Try again." }]);
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    opener.current = document.getElementById("save-policy");
    setServerItems([]);
    const result = validate(draft, pair, Date.now());
    setErrors(result.errors);
    setStatus("");
    if (result.payload === null) return;
    const risky = riskyChanges(saved, result.payload);
    if (risky.length > 0) {
      setReview({ payload: result.payload, items: risky });
      return;
    }
    send(result.payload, false);
  };
  const onPause = (event: { currentTarget: HTMLButtonElement }): void => {
    opener.current = event.currentTarget;
    setErrors({});
    send({ ...payloadFromSaved(saved), enabled: false }, false);
  };
  const reload = (): void => {
    setBusy(true);
    void getJson("/api/policy").then((res) => {
      setBusy(false);
      if (res.status === 200 && typeof res.body.policy === "object" && res.body.policy !== null) {
        apply((res.body as unknown as PolicyResponse).policy);
        setErrors({});
        setServerItems([]);
        setConflict(false);
        setStatus("Loaded the latest policy.");
      } else setServerItems([{ text: "Could not load the latest policy. Try again." }]);
    });
  };
  const trapTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeReview();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogTitleRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const field = (key: "max_payment_amount" | "daily_spend_limit" | "minimum_reserve", label: string, hint: string): ReactNode => (
    <div className="field">
      <label htmlFor={key}>{label} (RLUSD)</label>
      <span id={`${key}-hint`} className="hint">
        {hint}
      </span>
      <input
        id={key}
        name={key}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        aria-invalid={errors[key] !== undefined}
        aria-describedby={errors[key] === undefined ? `${key}-hint` : `${key}-hint ${key}-error`}
      />
      {errors[key] !== undefined ? (
        <p id={`${key}-error`} className="field-error">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const updated =
    saved.updated_at === null
      ? "These values have not been changed since setup."
      : `Last updated by ${saved.updated_by === "you" ? "you" : saved.updated_by === "another_user" ? "another user" : "the system"} on ${formatInstant(saved.updated_at, timezone)} (version ${String(saved.version)}).`;
  return (
    <>
      <div inert={review !== null}>
        <h1>Payment policies</h1>
        <p className="guard-note">These limits are enforced by Flow AI&apos;s independent payment service. The AI agent cannot change them.</p>
        <p>
          Automation is{" "}
          {saved.enabled ? <StatusBadge tone="ok" label="On" /> : <StatusBadge tone="neutral" label="Paused" />} <span>{updated}</span>
        </p>
        {saved.enabled ? (
          <p>
            <button type="button" className="btn btn-danger" onClick={onPause} disabled={busy}>
              <Icon name="alert" />
              Pause automation
            </button>{" "}
            <span className="hint">Stops all automated payments immediately.</span>
          </p>
        ) : null}
        <form onSubmit={onSubmit} noValidate aria-label="Payment policy">
          {hasSummary ? (
            <div className="error-summary" role="alert" tabIndex={-1} ref={summaryRef}>
              <h2>
                <Icon name="alert" className="mr-2 inline size-5 align-text-bottom" />
                There is a problem
              </h2>
              <ul>
                {items.map((item) => (
                  <li key={item.text}>{item.href === undefined ? item.text : <a href={item.href}>{item.text}</a>}</li>
                ))}
              </ul>
              {conflict ? (
                <button type="button" className="btn btn-secondary" onClick={reload} disabled={busy}>
                  Load latest values
                </button>
              ) : null}
              {reauth ? (
                <p>
                  <a href="/login?reauth=1">Sign in again</a>
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="field">
            <div className="check">
              <input id="enabled" name="enabled" type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} aria-describedby="enabled-hint" />
              <label htmlFor="enabled">Automation on</label>
            </div>
            <span id="enabled-hint" className="hint">
              When off, the payment service blocks every payment request.
            </span>
          </div>
          {field("max_payment_amount", "Largest single payment", "The most the agent can pay in one invoice.")}
          {field("daily_spend_limit", "Daily limit", "The most the agent can pay in total on one business day.")}
          {field("minimum_reserve", "Minimum reserve", "The treasury balance that must always stay untouched.")}
          <fieldset aria-describedby="assets-hint">
            <legend>Allowed assets</legend>
            <span id="assets-hint" className="hint">
              Only test RLUSD on XRPL Testnet can be paid. Unticking this blocks all payments.
            </span>
            <div className="check">
              <input id="allow_rlusd" name="allow_rlusd" type="checkbox" checked={draft.allowRlusd} onChange={(e) => set("allowRlusd", e.target.checked)} />
              <label htmlFor="allow_rlusd">RLUSD (Testnet)</label>
            </div>
          </fieldset>
          <fieldset aria-describedby="expiry-hint">
            <legend>Policy expiry</legend>
            <span id="expiry-hint" className="hint">
              After this time every payment request is blocked until you set a new date. Times are in UTC.
            </span>
            <div className="check">
              <input id="has_expiry" name="has_expiry" type="checkbox" checked={draft.hasExpiry} onChange={(e) => set("hasExpiry", e.target.checked)} />
              <label htmlFor="has_expiry">Set an expiry date</label>
            </div>
            {draft.hasExpiry ? (
              <div className="field">
                <label htmlFor="valid_until">Expires at (UTC)</label>
                <input
                  id="valid_until"
                  name="valid_until"
                  type="datetime-local"
                  value={draft.expiry}
                  onChange={(e) => set("expiry", e.target.value)}
                  aria-invalid={errors.valid_until !== undefined}
                  aria-describedby={errors.valid_until === undefined ? undefined : "valid_until-error"}
                />
                {errors.valid_until !== undefined ? (
                  <p id="valid_until-error" className="field-error">
                    {errors.valid_until}
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
          <button id="save-policy" type="submit" className="btn" disabled={busy}>
            Save changes
          </button>
        </form>
      </div>
      <p role="status" aria-live="polite" className="status">
        {status}
      </p>
      {review !== null ? (
        <div className="dialog-backdrop">
          <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" onKeyDown={trapTab}>
            <h2 id="review-title" tabIndex={-1} ref={dialogTitleRef}>
              <Icon name="shield" className="mr-2 inline size-5 align-text-bottom" />
              Review before saving
            </h2>
            <p>This change loosens a protection. The payment service will apply it to the next payment request:</p>
            <ul>
              {review.items.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const next = review.payload;
                  closeReview();
                  send(next, true);
                }}
              >
                <Icon name="check" />
                Confirm and save
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeReview}>
                Go back
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
