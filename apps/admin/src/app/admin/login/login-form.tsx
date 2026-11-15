"use client";

import { useState, type FormEvent } from "react";
import { apiPost } from "../_components/api";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await apiPost<{ must_change_password?: boolean }>("/api/v1/auth/login", { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") });
    setBusy(false);
    if (res.ok) window.location.assign(res.data?.must_change_password ? "/admin/change-password" : "/admin");
    else setError(res.message);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="username" required />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      <div>
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </div>
      {error && (
        <p className="status err" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
