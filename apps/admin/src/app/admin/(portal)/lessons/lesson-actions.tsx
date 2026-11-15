"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { call } from "./_lib/client-api";
import { defaultContent } from "./_lib/content-form";

interface Revision {
  readonly revision: number;
  readonly checksum: string;
  readonly pinned_from_revision: number | null;
  readonly created_at: string | null;
  readonly lesson_count: number;
}

export function ManifestRevisions({ grade, revisions, canPin }: { grade: number; revisions: readonly Revision[]; canPin: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const current = revisions[0]?.revision;
  return (
    <div>
      <h3>Grade {grade}</h3>
      {revisions.length === 0 ? (
        <p className="muted">No manifest yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Revision</th>
              <th scope="col">Lessons</th>
              <th scope="col">Created</th>
              <th scope="col"><span className="skip">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.revision}>
                <td>
                  #{r.revision} {r.revision === current && <span className="chip live">current</span>}
                  {r.pinned_from_revision !== null && <div className="muted">pinned from #{r.pinned_from_revision}</div>}
                </td>
                <td>{r.lesson_count}</td>
                <td>{r.created_at ? new Date(r.created_at).toLocaleString("en-IN") : "—"}</td>
                <td>
                  {canPin && r.revision !== current && (
                    <button
                      type="button"
                      className="small ghost"
                      onClick={async () => {
                        if (!window.confirm(`Roll grade ${grade} back to manifest #${r.revision}?`)) return;
                        const res = await call<{ manifest_revision: number }>("POST", `/api/v1/admin/manifests/${r.revision}/pin`, {}, { idempotent: true });
                        setMsg(res.ok ? { ok: true, text: `Pinned. New revision #${res.data?.manifest_revision}.` } : { ok: false, text: res.message ?? "Pin failed." });
                        if (res.ok) router.refresh();
                      }}
                    >
                      Pin
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className={`status ${msg.ok ? "ok" : "err"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </div>
  );
}

export function NewLessonForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim().toLowerCase();
    const factor = Number(form.get("factor"));
    setBusy(true);
    const res = await call<{ lesson_id: string }>("POST", "/api/v1/admin/lessons", {
      content: defaultContent(`grade2.math.multiplication.${slug}`, factor, String(form.get("title") ?? "")),
    });
    setBusy(false);
    if (res.ok && res.data) router.push(`/admin/lessons/${res.data.lesson_id}`);
    else setMsg(res.message ?? "Could not create the lesson.");
  }
  return (
    <form onSubmit={onSubmit}>
      <p className="muted">Creates a Grade 2 Math draft in the picture-groups template under “Multiplication”. You can edit everything before review.</p>
      <label htmlFor="nl-slug">Key (letters, digits, dashes)</label>
      <input id="nl-slug" name="slug" required pattern="[a-z0-9][a-z0-9_-]{0,40}" placeholder="doubles-practice" autoComplete="off" />
      <label htmlFor="nl-title">Title</label>
      <input id="nl-title" name="title" required maxLength={120} placeholder="Doubles practice" />
      <label htmlFor="nl-factor">Table (factor)</label>
      <select id="nl-factor" name="factor" defaultValue="2">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>×{n}</option>
        ))}
      </select>
      <div>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create draft"}</button>
      </div>
      {msg && <p className="status err" role="alert">{msg}</p>}
    </form>
  );
}
