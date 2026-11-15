"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiPost } from "../../_components/api";

/** Dismiss (or restore) a recommendation. Reversible; the page itself renders without JavaScript. */
export function DismissButton({ id, dismissed, label }: { id: string; dismissed: boolean; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={busy}
        aria-label={`${dismissed ? "Restore" : "Dismiss"} suggestion: ${label}`}
        onClick={async () => {
          setBusy(true);
          const res = await apiPost(`/api/v1/admin/recommendations/${encodeURIComponent(id)}/dismiss`, dismissed ? { undo: true } : undefined);
          setBusy(false);
          if (res.ok) router.refresh();
          else setError(res.message);
        }}
      >
        {dismissed ? "Restore" : "Dismiss"}
      </button>
      {error && <span role="alert" className="muted"> {error}</span>}
    </>
  );
}
