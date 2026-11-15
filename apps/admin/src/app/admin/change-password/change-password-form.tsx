"use client";

import { useRef, useState, type FormEvent } from "react";
import { apiPost } from "../_components/api";

const MIN_LENGTH = 12;

/** Same pattern as the login form: same-origin fetch with the CSRF header (a classic form POST would send Origin: null). */
export function ChangePasswordForm({ email }: { email: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  function fail(message: string) {
    setError(message);
    // Move focus so screen readers and keyboard users land on the message (it is also role="alert").
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const current = String(form.get("current_password") ?? "");
    const next = String(form.get("new_password") ?? "");
    const confirm = String(form.get("confirm_password") ?? "");
    setError(null);
    if (next.length < MIN_LENGTH) return fail(`The new password must be at least ${MIN_LENGTH} characters.`);
    if (next !== confirm) return fail("The two new passwords do not match.");
    setBusy(true);
    const res = await apiPost("/api/v1/auth/password", { current_password: current, new_password: next });
    setBusy(false);
    if (res.ok) window.location.assign("/admin");
    else fail(res.message ?? "Password could not be changed.");
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <label htmlFor="current_password">Current (one-time) password</label>
      <input id="current_password" name="current_password" type="password" autoComplete="current-password" required />
      <label htmlFor="new_password">New password</label>
      <input
        id="new_password"
        name="new_password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_LENGTH}
        aria-describedby="password-rules"
        required
      />
      <label htmlFor="confirm_password">Repeat new password</label>
      <input id="confirm_password" name="confirm_password" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required />
      <p id="password-rules" className="muted">
        At least {MIN_LENGTH} characters, different from the current one, and not containing the part of your email before the @.
        A passphrase of several unrelated words works well.
      </p>
      <div>
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </div>
      {error && (
        <p className="status err" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
    </form>
  );
}
