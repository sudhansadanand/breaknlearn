"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiPost } from "../../../_components/api";

interface Props {
  readonly jobId: string;
  readonly chapterId: string;
  readonly nodeId: string;
  readonly chapterTitle: string;
  readonly nodeTitle: string;
  readonly state: "suggested" | "approved" | "rejected";
}

/** Approve/reject one (chapter, topic) suggestion. Approved mappings are final. */
export function MappingDecision({ jobId, chapterId, nodeId, chapterTitle, nodeTitle, state }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state === "approved") return null;

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    const res = await apiPost(`/api/v1/admin/imports/${encodeURIComponent(jobId)}/review`, { decisions: [{ chapter_id: chapterId, curriculum_node_id: nodeId, decision }] });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.message);
  }

  return (
    <span className="actions">
      <button type="button" className="small" disabled={busy} aria-label={`Approve ${nodeTitle} for ${chapterTitle}`} onClick={() => void decide("approve")}>
        Approve
      </button>
      {state !== "rejected" && (
        <button type="button" className="small ghost" disabled={busy} aria-label={`Reject ${nodeTitle} for ${chapterTitle}`} onClick={() => void decide("reject")}>
          Reject
        </button>
      )}
      {error && (
        <span role="alert" className="muted">
          {" "}
          {error}
        </span>
      )}
    </span>
  );
}
