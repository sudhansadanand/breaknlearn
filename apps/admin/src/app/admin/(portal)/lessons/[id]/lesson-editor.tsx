"use client";

import { ThemeKey, WORLDS } from "@bnl/contracts";
import { previewPictureGroups, validateLessonContent } from "@bnl/lesson-engine";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { call, errorList } from "../_lib/client-api";
import { fromForm, toForm, type FormState } from "../_lib/content-form";
import { StatusChip } from "../status-chip";

interface Version {
  readonly id: string;
  readonly version_no: number;
  readonly status: string;
  readonly content: unknown;
  readonly validation_errors: readonly { path: string; message: string }[];
  readonly created_by: string | null;
  readonly review_comment: string | null;
  readonly updated_at: string | null;
}
interface Props {
  readonly lesson: { id: string; template_key: string };
  readonly versions: readonly Version[];
  readonly liveVersionId: string | null;
  readonly viewer: { user_id: string; roles: readonly string[] };
}
interface PreviewItem {
  question_version_key: string;
  prompt: string;
  options: { id: string; label: string }[];
  correct_option_id?: string;
}

type Msg = { ok: boolean; text: string; errors?: { path: string; message: string }[] } | null;

export function LessonEditor({ lesson, versions, liveVersionId, viewer }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(versions[0]?.id ?? "");
  const selected = versions.find((v) => v.id === selectedId) ?? versions[0];
  const [form, setForm] = useState<FormState>(() => toForm(selected?.content));
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [world, setWorld] = useState<string>("puppy");
  const [step, setStep] = useState(0);
  const [items, setItems] = useState<{ withKeys: boolean; list: PreviewItem[] } | null>(null);
  const has = (r: string) => viewer.roles.includes(r);

  useEffect(() => setForm(toForm(selected?.content)), [selected?.id, selected?.content]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    void call<{ quiz_items: PreviewItem[]; answer_keys_included: boolean }>("GET", `/api/v1/admin/lessons/${lesson.id}/versions/${selected.id}/preview`).then((r) => {
      if (live && r.ok && r.data) setItems({ withKeys: r.data.answer_keys_included, list: r.data.quiz_items });
    });
    return () => {
      live = false;
    };
  }, [lesson.id, selected?.id, selected]);

  const draftContent = useMemo(() => fromForm(selected?.content, form), [selected?.content, form]);
  const liveErrors = useMemo(() => validateLessonContent(draftContent), [draftContent]);
  const preview = useMemo(() => previewPictureGroups(draftContent), [draftContent]);
  const theme = preview?.find((t) => t.theme_key === world) ?? preview?.[0];
  const slide = theme?.slides[Math.min(step, theme.slides.length - 1)];

  async function act(label: string, fn: () => Promise<{ ok: boolean; message: string | null; details: Record<string, unknown> | null }>) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: `${label}: done.` } : { ok: false, text: res.message ?? `${label} failed.`, errors: errorList(res.details) });
    if (res.ok) router.refresh();
  }

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isOwn = selected?.created_by === viewer.user_id;
  const editable = has("editor");

  return (
    <div className="editor-grid">
      <section className="card" aria-labelledby="ver-h">
        <h2 id="ver-h">Version</h2>
        <label htmlFor="ver-select">Showing</label>
        <select id="ver-select" value={selected?.id ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version_no} — {v.status}{v.id === liveVersionId ? " (live)" : ""}
            </option>
          ))}
        </select>
        {selected && (
          <p>
            <StatusChip status={selected.status} /> {selected.id === liveVersionId && <span className="chip live">live for students</span>}
            {selected.review_comment && <span className="muted"> Review note: {selected.review_comment}</span>}
          </p>
        )}
        {selected && selected.validation_errors.length > 0 && (
          <ul className="errors-list" aria-label="Saved validation errors">
            {selected.validation_errors.map((e) => <li key={`${e.path}:${e.message}`}>{e.path}: {e.message}</li>)}
          </ul>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act("Save draft", () => call("POST", "/api/v1/admin/lessons", { lesson_id: lesson.id, content: draftContent }));
          }}
        >
          <fieldset disabled={!editable || busy}>
            <legend>Content{selected && selected.status !== "draft" ? " (saving creates a new draft version)" : ""}</legend>
            <label htmlFor="f-title">Title</label>
            <input id="f-title" value={form.title} maxLength={120} onChange={(e) => update("title", e.target.value)} />
            <label htmlFor="f-factor">Table (factor)</label>
            <select id="f-factor" value={form.factor} onChange={(e) => update("factor", Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>×{n}</option>)}
            </select>
            <fieldset>
              <legend>Worlds</legend>
              {WORLDS.map((w) => (
                <label key={w.key} className="check">
                  <input
                    type="checkbox"
                    checked={form.themes.includes(w.key as ThemeKey)}
                    onChange={(e) => update("themes", e.target.checked ? [...form.themes, w.key as ThemeKey] : form.themes.filter((t) => t !== w.key))}
                  />
                  {w.icon} {w.name}
                </label>
              ))}
            </fieldset>
            <label htmlFor="f-secs">Seconds per slide</label>
            <input id="f-secs" type="number" min={3} max={30} value={form.secondsPerSlide} onChange={(e) => update("secondsPerSlide", Number(e.target.value))} />
            <label htmlFor="f-quiz">Quiz questions</label>
            <input id="f-quiz" type="number" min={1} max={10} value={form.quizCount} onChange={(e) => update("quizCount", Number(e.target.value))} />
            <label htmlFor="f-outcomes">Learning outcome keys (one per line)</label>
            <textarea id="f-outcomes" rows={2} value={form.outcomeKeys} onChange={(e) => update("outcomeKeys", e.target.value)} />
            <label htmlFor="f-rights">Rights</label>
            <select id="f-rights" value={form.rightsType} onChange={(e) => update("rightsType", e.target.value as FormState["rightsType"])}>
              <option value="original_generated_content">Original generated content</option>
              <option value="licensed">Licensed</option>
              <option value="public_domain">Public domain</option>
              <option value="owner_supplied">Owner supplied</option>
            </select>
            <label htmlFor="f-attr">Attribution</label>
            <input id="f-attr" value={form.attribution} maxLength={500} onChange={(e) => update("attribution", e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={form.rightsReviewed} onChange={(e) => update("rightsReviewed", e.target.checked)} /> Rights reviewed
            </label>
            {editable && (
              <div>
                <button type="submit">Save draft</button>
              </div>
            )}
          </fieldset>
        </form>
        {liveErrors.length > 0 && (
          <ul className="errors-list" aria-label="Problems in the form">
            {liveErrors.map((e) => <li key={`${e.path}:${e.message}`}>{e.path}: {e.message}</li>)}
          </ul>
        )}

        {selected && (
          <div className="row-actions spaced">
            {has("editor") && selected.status === "draft" && (
              <button type="button" disabled={busy} onClick={() => act("Submit for review", () => call("POST", `/api/v1/admin/lessons/${lesson.id}/versions/${selected.id}/transition`, { action: "submit" }))}>
                Submit for review
              </button>
            )}
            {has("reviewer") && selected.status === "in_review" && !isOwn && (
              <>
                <button type="button" disabled={busy} onClick={() => act("Approve", () => call("POST", `/api/v1/admin/lessons/${lesson.id}/versions/${selected.id}/transition`, { action: "approve" }))}>
                  Approve
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    const comment = window.prompt("What should the editor change?") ?? "";
                    if (!comment.trim()) return;
                    void act("Reject", () => call("POST", `/api/v1/admin/lessons/${lesson.id}/versions/${selected.id}/transition`, { action: "reject", comment: comment.slice(0, 1000) }));
                  }}
                >
                  Reject
                </button>
              </>
            )}
            {has("reviewer") && selected.status === "in_review" && isOwn && <span className="muted">You wrote this version, so another reviewer must review it.</span>}
            {has("publisher") && selected.status === "approved" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Reason for publishing (shown in the audit log)") ?? "";
                  if (!reason.trim()) return;
                  void act("Publish", () => call("POST", `/api/v1/admin/lessons/${lesson.id}/publish`, { version_id: selected.id, reason: reason.slice(0, 500) }, { idempotent: true }));
                }}
              >
                Publish
              </button>
            )}
            {has("publisher") && liveVersionId && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Reason for unpublishing") ?? "";
                  if (!reason.trim()) return;
                  void act("Unpublish", () => call("POST", `/api/v1/admin/lessons/${lesson.id}/unpublish`, { reason: reason.slice(0, 500) }, { idempotent: true }));
                }}
              >
                Unpublish
              </button>
            )}
          </div>
        )}
        {msg && (
          <div className={`status ${msg.ok ? "ok" : "err"}`} role={msg.ok ? "status" : "alert"}>
            {msg.text}
            {msg.errors && msg.errors.length > 0 && (
              <ul className="errors-list">{msg.errors.map((e) => <li key={`${e.path}:${e.message}`}>{e.path}: {e.message}</li>)}</ul>
            )}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="prev-h">
        <h2 id="prev-h">Live preview</h2>
        {!preview || !theme || !slide ? (
          <p className="muted">Fix the problems listed to see the TV preview.</p>
        ) : (
          <>
            <div className={`tv world-${theme.theme_key}`} aria-live="polite">
              <div className="tv-title">{theme.icon} {theme.name} · {slide.title}</div>
              <div className="tv-formula">{slide.headline}</div>
              <div className="groups" role="img" aria-label={slide.alt}>
                {Array.from({ length: slide.group_count }, (_, g) => (
                  <span key={g} className="group">{slide.icon.repeat(slide.objects_per_group)}</span>
                ))}
              </div>
              <div className="tv-caption">{slide.caption}</div>
            </div>
            <div className="tv-controls">
              <label htmlFor="pv-world" className="skip">World</label>
              <select id="pv-world" value={theme.theme_key} onChange={(e) => { setWorld(e.target.value); setStep(0); }}>
                {preview.map((t) => <option key={t.theme_key} value={t.theme_key}>{t.icon} {t.name}</option>)}
              </select>
              <button type="button" className="small" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>◀ Prev</button>
              <span>Slide {Math.min(step, theme.slides.length - 1) + 1} of {theme.slides.length} · {form.secondsPerSlide}s each</span>
              <button type="button" className="small" disabled={step >= theme.slides.length - 1} onClick={() => setStep((s) => s + 1)}>Next ▶</button>
            </div>
          </>
        )}
        <h3>Quiz item bank (saved version)</h3>
        <p className="muted">
          Students get {form.quizCount} of these per quiz.{" "}
          {items?.withKeys ? "Correct answers are underlined (reviewer view)." : "Answer keys are shown to reviewers only."}
        </p>
        {items && items.list.length === 0 && <p className="muted">No items until the content is valid and saved.</p>}
        {items?.list.map((it) => (
          <div key={it.question_version_key} className="quiz-item">
            <strong>{it.prompt}</strong>{" "}
            {it.options.map((o) => (
              <span key={o.id} className={`opt ${it.correct_option_id === o.id ? "correct" : ""}`}>{o.label}</span>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
