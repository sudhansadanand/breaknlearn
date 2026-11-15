"use client";

import { GRADE_SUBJECTS } from "@bnl/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiPost } from "../../_components/api";

const SUBJECTS = { "2": GRADE_SUBJECTS[2], "6": GRADE_SUBJECTS[6] } as const;

type Status = { ok: boolean; text: string } | null;

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <p className={`status ${status.ok ? "ok" : "err"}`} role={status.ok ? "status" : "alert"}>
      {status.text}
    </p>
  );
}

export function CreatePlanForm() {
  const router = useRouter();
  const [grade, setGrade] = useState<"2" | "6">("2");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const f = new FormData(el);
    const opt = (k: string) => {
      const v = String(f.get(k) ?? "").trim();
      return v ? { [k]: v } : {};
    };
    setBusy(true);
    const res = await apiPost("/api/v1/admin/school-plans", {
      grade: Number(grade),
      subject_key: String(f.get("subject_key") ?? ""),
      academic_year: String(f.get("academic_year") ?? "").trim(),
      ...opt("school_label"),
      ...opt("textbook_title"),
      ...opt("edition"),
    });
    setBusy(false);
    if (res.ok) {
      el.reset();
      setStatus({ ok: true, text: "School plan created." });
      router.refresh();
    } else setStatus({ ok: false, text: res.message ?? "Could not create the plan." });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="filters">
        <div>
          <label htmlFor="sp-grade">Grade</label>
          <select id="sp-grade" value={grade} onChange={(e) => setGrade(e.target.value === "6" ? "6" : "2")}>
            <option value="2">Grade 2</option>
            <option value="6">Grade 6</option>
          </select>
        </div>
        <div>
          <label htmlFor="sp-subject">Subject</label>
          <select id="sp-subject" name="subject_key" required>
            {SUBJECTS[grade].map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sp-year">Academic year</label>
          <input id="sp-year" name="academic_year" required pattern="[0-9]{4}(-[0-9]{2,4})?" placeholder="2026-27" />
        </div>
      </div>
      <label htmlFor="sp-school">School (optional)</label>
      <input id="sp-school" name="school_label" maxLength={120} />
      <label htmlFor="sp-book">Textbook title (optional)</label>
      <input id="sp-book" name="textbook_title" maxLength={200} />
      <label htmlFor="sp-edition">Edition (optional)</label>
      <input id="sp-edition" name="edition" maxLength={80} />
      <div>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Create school plan"}
        </button>
      </div>
      <StatusLine status={status} />
    </form>
  );
}

function csrfToken(): string {
  const m = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("bnl_csrf="));
  return m ? decodeURIComponent(m.slice("bnl_csrf=".length)) : "";
}

export function ImportForm({ plans }: { plans: readonly { id: string; label: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const f = new FormData(el);
    const planId = String(f.get("school_plan_id") ?? "");
    const headers: Record<string, string> = { "X-CSRF-Token": csrfToken(), "Idempotency-Key": crypto.randomUUID() };
    let body: BodyInit;
    if (mode === "file") {
      const file = f.get("file");
      if (!(file instanceof File) || file.size === 0) {
        setStatus({ ok: false, text: "Choose a file to upload." });
        return;
      }
      const form = new FormData();
      form.set("school_plan_id", planId);
      form.set("file", file);
      body = form;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ school_plan_id: planId, toc_text: String(f.get("toc_text") ?? ""), format: String(f.get("format") ?? "lines") });
    }
    setBusy(true);
    const res = await fetch("/api/v1/admin/imports", { method: "POST", credentials: "same-origin", headers, body });
    const payload = (await res.json().catch(() => null)) as { job_id?: string; duplicate_of?: string | null; status?: string; chapters?: number; error?: { message?: string } } | null;
    setBusy(false);
    if (res.ok && payload?.job_id) {
      el.reset();
      router.push(`/admin/imports/${payload.job_id}`);
      return;
    }
    setStatus({ ok: false, text: payload?.error?.message ?? `Import failed (${res.status})` });
  }

  if (plans.length === 0) return <p className="muted">Create a school plan first.</p>;
  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="im-plan">School plan</label>
      <select id="im-plan" name="school_plan_id" required>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <fieldset>
        <legend>Source</legend>
        <label>
          <input type="radio" name="mode" value="file" checked={mode === "file"} onChange={() => setMode("file")} /> Upload a file (PDF, DOCX, CSV or TXT)
        </label>
        <label>
          <input type="radio" name="mode" value="paste" checked={mode === "paste"} onChange={() => setMode("paste")} /> Paste the table of contents
        </label>
      </fieldset>
      {mode === "file" ? (
        <>
          <label htmlFor="im-file">File</label>
          <input id="im-file" name="file" type="file" accept=".pdf,.docx,.csv,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,text/plain" />
          <p className="muted">
            CSV columns: <code>chapter_no,title,page_start,grade,subject</code>. Files stay private to your household. Scanned PDFs are not read (no OCR): paste the contents instead.
          </p>
        </>
      ) : (
        <>
          <label htmlFor="im-text">Table of contents</label>
          <textarea id="im-text" name="toc_text" maxLength={200000} placeholder={"1. Numbers up to 100 ........ 1\n2. Shapes and Patterns ........ 14"} />
          <label htmlFor="im-format">Format</label>
          <select id="im-format" name="format" defaultValue="lines">
            <option value="lines">One chapter per line</option>
            <option value="csv">CSV with header</option>
          </select>
        </>
      )}
      <div>
        <button type="submit" disabled={busy}>
          {busy ? "Importing…" : "Import for review"}
        </button>
      </div>
      <p className="muted">Imports only create suggestions for you to review. Nothing is published.</p>
      <StatusLine status={status} />
    </form>
  );
}
