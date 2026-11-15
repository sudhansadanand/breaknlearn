import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · BreakNLearn Admin" };

export default function LoginPage() {
  return (
    <main id="main" className="login">
      <div className="card">
        <p className="brand">
          Break<span>N</span>Learn
        </p>
        <h1>Grown-ups sign in</h1>
        <p className="muted">For parents and guardians only. Children never need an account.</p>
        <LoginForm />
      </div>
    </main>
  );
}
