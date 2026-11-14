"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiPost } from "../../_components/api";

interface Props {
  readonly nodeId: string;
  readonly title: string;
  readonly reviewStatus: "draft" | "in_review" | "verified" | "archived";
  readonly canSubmit: boolean;
  readonly canReview: boolean;
  readonly sourceDocuments: readonly { id: string; title: string; versionLabel: string | null }[];
}

/** Submit / verify (with citation) / archive for one curriculum node. The server re-checks every role. */
export function NodeReviewActions({ nodeId, title, reviewStatus, canSubmit, canReview, sourceDocuments }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"none" | "verify" | "archive">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/v1/admin/curriculum/${encodeURIComponent(nodeId)}/review`;
  const idp = `n-${nodeId.slice(0, 8)}`;

  async function send(body: unknown) {
    setBusy(true);
    setError(null);
    const res = await apiPost(path, body);
    setBusy(false);
    if (res.ok) {
      setMode("none");
      router.refresh();
    } else setError(res.message);
  }

  function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void send({
      action: "verify",
      source_document_id: String(f.get("source_document_id") ?? ""),
      source_ref: String(f.get("source_ref") ?? ""),
      authority: String(f.get("authority") ?? ""),
    });
  }

  function onArchive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void send({ action: "archive", reason: String(f.get("reason") ?? "") });
  }

  if (reviewStatus === "archived") return <span className="muted">—</span>;
  return (
    <div>
      <div className="actions">
        {reviewStatus === "draft" && canSubmit && (
          <button type="button" className="small" disabled={busy} aria-label={`Submit ${title} for review`} onClick={() => void send({ action: "submit" })}>
            Submit
          </button>
        )}
        {reviewStatus === "in_review" && canReview && (
          <button type="button" className="small" aria-expanded={mode === "verify"} aria-controls={`${idp}-panel`} onClick={() => setMode(mode === "verify" ? "none" : "verify")}>
            Verify…
          </button>
        )}
        {canReview && (
          <button type="button" className="small ghost" aria-expanded={mode === "archive"} aria-controls={`${idp}-panel`} onClick={() => setMode(mode === "archive" ? "none" : "archive")}>
            Archive…
          </button>
        )}
      </div>
      {mode === "verify" && (
        <form id={`${idp}-panel`} className="review-panel" onSubmit={onVerify} aria-label={`Verify ${title}`}>
          <label htmlFor={`${idp}-doc`}>Source document</label>
          <select id={`${idp}-doc`} name="source_document_id" required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {sourceDocuments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
                {d.versionLabel ? ` (${d.versionLabel})` : ""}
              </option>
            ))}
          </select>
          <label htmlFor={`${idp}-ref`}>Page / section</label>
          <input id={`${idp}-ref`} name="source_ref" required maxLength={200} placeholder="p. 42, §3.1" />
          <label htmlFor={`${idp}-auth`}>Authority</label>
          <select id={`${idp}-auth`} name="authority" defaultValue="cisce_verified">
            <option value="cisce_verified">Verified CISCE</option>
            <option value="local_enrichment">Local enrichment</option>
          </select>
          <div>
            <button type="submit" className="small" disabled={busy}>
              Verify
            </button>
          </div>
        </form>
      )}
      {mode === "archive" && (
        <form id={`${idp}-panel`} className="review-panel" onSubmit={onArchive} aria-label={`Archive ${title}`}>
          <label htmlFor={`${idp}-reason`}>Reason</label>
          <input id={`${idp}-reason`} name="reason" required maxLength={500} />
          <div>
            <button type="submit" className="small danger" disabled={busy}>
              Archive
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="status err">
          {error}
        </p>
      )}
    </div>
  );
}
