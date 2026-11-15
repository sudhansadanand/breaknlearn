const LABELS: Record<string, string> = { draft: "Draft", in_review: "In review", approved: "Approved", published: "Published", archived: "Archived" };

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${status in LABELS ? status : ""}`}>{LABELS[status] ?? status}</span>;
}
