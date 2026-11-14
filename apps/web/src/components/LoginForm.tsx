"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { writeJsonPublic } from "./login-api";
interface FieldErrors {
  email?: string;
  password?: string;
}
export function LoginForm({ reauth = false }: { reauth?: boolean }): ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const summary = useRef<HTMLDivElement>(null);
  const hasProblem = formError !== null || errors.email !== undefined || errors.password !== undefined;
  useEffect(() => {
    if (hasProblem) summary.current?.focus();
  }, [hasProblem, errors, formError]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next: FieldErrors = {};
    if (!/^\S+@\S+$/.test(email.trim())) next.email = "Enter your email address.";
    if (password.length === 0) next.password = "Enter your password.";
    setFormError(null);
    setErrors(next);
    if (next.email !== undefined || next.password !== undefined) return;
    setBusy(true);
    void writeJsonPublic("/api/auth/login", { email: email.trim(), password }).then((res) => {
      if (res.status === 200) {
        window.location.assign("/");
        return;
      }
      setBusy(false);
      setPassword("");
      if (res.status === 429) {
        const wait = typeof res.retryAfter === "number" ? ` Try again in about ${String(res.retryAfter)} seconds.` : " Try again later.";
        setFormError(`Too many sign-in attempts.${wait}`);
      } else if (res.status === 401) setFormError("The email or password is not correct.");
      else setFormError("Sign-in is not available right now. Try again.");
    });
  };
  return (
    <form onSubmit={submit} noValidate aria-labelledby="login-title" className="glass-card login-card">
      <h1 id="login-title" className="page-title">Sign in</h1>
      {reauth ? <p className="lede">Sign in again to change payment rules. This keeps a stolen session from loosening your limits.</p> : null}
      {hasProblem ? (
        <div className="error-summary" role="alert" tabIndex={-1} ref={summary}>
          <h2>There is a problem</h2>
          <ul>
            {formError !== null ? <li>{formError}</li> : null}
            {errors.email !== undefined ? (
              <li>
                <a href="#email">{errors.email}</a>
              </li>
            ) : null}
            {errors.password !== undefined ? (
              <li>
                <a href="#password">{errors.password}</a>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={errors.email !== undefined} aria-describedby={errors.email === undefined ? undefined : "email-error"} />
        {errors.email !== undefined ? (
          <p id="email-error" className="field-error">
            {errors.email}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={errors.password !== undefined} aria-describedby={errors.password === undefined ? undefined : "password-error"} />
        {errors.password !== undefined ? (
          <p id="password-error" className="field-error">
            {errors.password}
          </p>
        ) : null}
      </div>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
