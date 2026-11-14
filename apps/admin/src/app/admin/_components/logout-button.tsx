"use client";

import { apiPost } from "./api";

export function LogoutButton() {
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        await apiPost("/api/v1/auth/logout", undefined);
        window.location.assign("/admin/login");
      }}
    >
      Sign out
    </button>
  );
}
