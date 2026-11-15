import type { Metadata } from "next";
import { requireAdultPage } from "../../../server/page-auth";
import { LogoutButton } from "../_components/logout-button";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Change password · BreakNLearn Admin" };

/**
 * Outside the (portal) group on purpose: the portal layout sends accounts with a pending one-time password here,
 * so this page must not sit under it. It is still session-gated server-side (SEC-001).
 */
export default async function ChangePasswordPage() {
  const adult = await requireAdultPage({ allowPendingPasswordChange: true });
  const forced = adult.mustChangePassword === true;
  return (
    <main id="main" className="login">
      <div className="card">
        <p className="brand">
          Break<span>N</span>Learn
        </p>
        <h1>{forced ? "Choose your own password" : "Change password"}</h1>
        {forced ? (
          <p className="muted">
            You signed in with a one-time password. Choose a new password to continue. Nothing else in the admin works until you do.
          </p>
        ) : (
          <p className="muted">Enter your current password and a new one.</p>
        )}
        <ChangePasswordForm email={adult.email} />
        <p>
          <LogoutButton />
        </p>
      </div>
    </main>
  );
}
