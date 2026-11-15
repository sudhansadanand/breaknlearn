"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiPost } from "../../_components/api";

interface ScopeOption {
  scope: string;
  label: string;
  statement: string;
  required: string;
  ifOff: string;
  granted: boolean;
  current: boolean;
  grantedAt: string;
}

type Status = { ok: boolean; text: string } | null;

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p className={`status ${status.ok ? "ok" : "err"}`} role={status.ok ? "status" : "alert"}>
      {status.text}
    </p>
  );
}

/** Mutations need the CSRF header, so this form needs JavaScript (see _components/api.ts). */
export function ConsentForm({ version, scopes }: { version: string; scopes: ScopeOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const on = new Set(form.getAll("scope").map(String));
    const grant = scopes.filter((s) => on.has(s.scope) && !(s.granted && s.current)).map((s) => s.scope);
    const revoke = scopes.filter((s) => !on.has(s.scope) && s.granted).map((s) => s.scope);
    if (grant.length === 0 && revoke.length === 0) {
      setStatus({ ok: true, text: "No changes to save." });
      return;
    }
    setBusy(true);
    for (const [decision, list] of [["grant", grant], ["revoke", revoke]] as const) {
      if (list.length === 0) continue;
      const res = await apiPost("/api/v1/admin/consent", { consent_version: version, decision, scopes: list });
      if (!res.ok) {
        setBusy(false);
        setStatus({ ok: false, text: res.message ?? "Could not save your choices." });
        return;
      }
    }
    setBusy(false);
    setStatus({ ok: true, text: "Your choices are saved." });
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit}>
      <fieldset>
        <legend>Choose what you agree to</legend>
        {scopes.map((s) => (
          <div className="privacy-option" key={s.scope}>
            <input type="checkbox" id={`scope-${s.scope}`} name="scope" value={s.scope} defaultChecked={s.granted} aria-describedby={`scope-${s.scope}-d`} />
            <label htmlFor={`scope-${s.scope}`}>{s.label}</label>
            <p id={`scope-${s.scope}-d`}>
              {s.statement} <span className="muted">{s.required} {s.ifOff}</span>
            </p>
            <p className="state muted">
              {s.granted ? `Given on ${s.grantedAt}${s.current ? "" : " for an older version of this notice"}.` : "Not given."}
            </p>
          </div>
        ))}
      </fieldset>
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save my choices"}</button>
      <StatusLine status={status} />
    </form>
  );
}

export function DeletionForm({ learners, confirmation, targetDays }: { learners: { id: string; name: string }[]; confirmation: string; targetDays: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState("telemetry_only");
  const [status, setStatus] = useState<Status>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const learner = String(form.get("learner_id") ?? "");
    const body: Record<string, string> = { scope, confirmation: String(form.get("confirmation") ?? "") };
    if (scope === "learner" || (scope === "telemetry_only" && learner !== "")) body.learner_id = learner;
    setBusy(true);
    const res = await apiPost("/api/v1/admin/privacy/deletion-requests", body);
    setBusy(false);
    if (res.ok) {
      formEl.reset();
      setScope("telemetry_only");
      setStatus({ ok: true, text: `Request received. It will be carried out at the next nightly run, within ${targetDays} days.` });
      router.refresh();
    } else {
      setStatus({ ok: false, text: res.message ?? "Could not send the request." });
    }
  }

  const options = [
    { value: "telemetry_only", label: "Detailed activity records", help: "Lesson steps, on-screen time and sessions. Profiles, progress and quiz results stay." },
    { value: "learner", label: "Everything about one child", help: "The child's profile, progress, quiz answers, activity, scores and suggestions." },
    { value: "household", label: "The whole household", help: "Every child, TV, consent record, school upload and the household itself. You will lose access to this portal's data." },
  ];

  return (
    <form onSubmit={onSubmit}>
      <p className="warn" role="note">
        <strong>Deletion cannot be undone.</strong> Download your data first if you want a copy. Requests are carried out at the next nightly
        run, within {targetDays} days. Backups age out on their own schedule. Names saved on a TV stay there until removed on the TV.
      </p>
      <fieldset>
        <legend>What should be deleted?</legend>
        {options.map((o) => (
          <div className="privacy-option" key={o.value}>
            <input
              type="radio"
              id={`del-${o.value}`}
              name="scope"
              value={o.value}
              checked={scope === o.value}
              onChange={() => setScope(o.value)}
              aria-describedby={`del-${o.value}-d`}
            />
            <label htmlFor={`del-${o.value}`}>{o.label}</label>
            <p id={`del-${o.value}-d`} className="muted">{o.help}</p>
          </div>
        ))}
      </fieldset>
      {scope !== "household" && (
        <>
          <label htmlFor="del-child">{scope === "learner" ? "Child" : "Child (leave empty for all children)"}</label>
          <select id="del-child" name="learner_id" required={scope === "learner"} defaultValue="">
            <option value="">{scope === "learner" ? "Choose a child" : "All children"}</option>
            {learners.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="del-confirm">Type {confirmation} to confirm</label>
      <input id="del-confirm" name="confirmation" required autoComplete="off" spellCheck={false} maxLength={20} />
      <div>
        <button type="submit" className="danger" disabled={busy}>{busy ? "Sending…" : "Request deletion"}</button>
      </div>
      <StatusLine status={status} />
    </form>
  );
}
