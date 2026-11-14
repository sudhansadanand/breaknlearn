"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiPost } from "../../_components/api";

export function PairDeviceForm() {
  const router = useRouter();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    const res = await apiPost<{ device_id: string }>("/api/v1/devices/pair", {
      code: String(form.get("code") ?? ""),
      device_label: String(form.get("device_label") ?? ""),
    });
    setBusy(false);
    if (res.ok) {
      formEl.reset();
      setStatus({ ok: true, text: "Approved. The TV will connect within a few seconds." });
      router.refresh();
    } else {
      setStatus({ ok: false, text: res.message ?? "Could not approve that code." });
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="code">Code shown on the TV</label>
      <input id="code" name="code" required maxLength={9} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="e.g. 7KQ4MZ2P" />
      <label htmlFor="device_label">Name for this TV</label>
      <input id="device_label" name="device_label" required maxLength={40} placeholder="Living room TV" />
      <div>
        <button type="submit" disabled={busy}>{busy ? "Approving…" : "Approve TV"}</button>
      </div>
      {status && (
        <p className={`status ${status.ok ? "ok" : "err"}`} role={status.ok ? "status" : "alert"}>
          {status.text}
        </p>
      )}
    </form>
  );
}

export function RevokeButton({ deviceId, label }: { deviceId: string; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="danger"
        aria-label={`Revoke ${label}`}
        onClick={async () => {
          if (!window.confirm(`Revoke “${label}”? It will stop syncing until paired again.`)) return;
          const res = await apiPost(`/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, undefined);
          if (res.ok) router.refresh();
          else setError(res.message);
        }}
      >
        Revoke
      </button>
      {error && <span role="alert" className="muted"> {error}</span>}
    </>
  );
}
