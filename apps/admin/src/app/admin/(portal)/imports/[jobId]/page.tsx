import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getCurriculumDeps } from "../../../../../server/curriculum/deps";
import { loadJob } from "../../../../../server/curriculum/import-handlers";
import { loadForHousehold, requireAdultPage } from "../../../../../server/page-auth";
import { MappingDecision } from "./mapping-review";
import "../../curriculum/curriculum.css";

export const dynamic = "force-dynamic";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export default async function ImportJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const adult = await requireAdultPage();
  const { jobId } = await params;
  const id = z.string().uuid().safeParse(jobId);
  if (!id.success) notFound();
  const deps = getCurriculumDeps();
  const view = await loadForHousehold(adult, (sql, m) => loadJob(sql, deps, id.data.toLowerCase(), m.householdId));
  if (view.kind === "no_household") {
    return <p className="status err" role="alert">{view.message}</p>;
  }
  const job = view.data;
  if (!job) notFound();
  const errors = job.errors.filter((e) => e.severity !== "warning");
  const warnings = job.errors.filter((e) => e.severity === "warning");
  return (
    <>
      <p>
        <Link href="/admin/imports">← All imports</Link>
      </p>
      <h1>Review chapter mapping</h1>
      <p className="muted">
        {job.plan ? `Grade ${job.plan.grade} · ${job.plan.subject_key} · ${job.plan.academic_year}` : ""} · status <span className="chip status">{job.status}</span> · Nothing here is published.
        {" "}
        <a href={`/api/v1/admin/imports/${job.id}/file`}>Download the uploaded file</a> (private link, expires quickly).
      </p>
      {errors.length > 0 && (
        <section className="card" aria-labelledby="err-h">
          <h2 id="err-h">Problems</h2>
          <ul>
            {errors.map((e, i) => (
              <li key={`e${i}`}>
                {e.row !== null ? `Row ${e.row}: ` : ""}
                {e.message} <span className="muted">({e.code})</span>
              </li>
            ))}
          </ul>
          {errors.some((e) => e.code === "needs_manual_toc") && (
            <p>
              <Link href="/admin/imports">Paste the table of contents instead</Link>
            </p>
          )}
        </section>
      )}
      {warnings.length > 0 && (
        <details className="card">
          <summary>{warnings.length} warning(s)</summary>
          <ul>
            {warnings.map((e, i) => (
              <li key={`w${i}`}>
                {e.row !== null ? `Row ${e.row}: ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <section className="card" aria-labelledby="ch-h">
        <h2 id="ch-h">Chapters</h2>
        {job.chapters.length === 0 ? (
          <p className="muted">No chapters were staged.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Chapter</th>
                  <th scope="col">Page</th>
                  <th scope="col">Extraction</th>
                  <th scope="col">Suggested topics</th>
                </tr>
              </thead>
              <tbody>
                {job.chapters.map((ch) => (
                  <tr key={ch.id}>
                    <td>{ch.chapter_number ?? "—"}</td>
                    <td>{ch.title}</td>
                    <td>{ch.page_start ?? "—"}</td>
                    <td className="conf">{pct(ch.extraction_confidence)}</td>
                    <td>
                      {ch.suggestions.length === 0 ? (
                        <span className="muted">No confident match</span>
                      ) : (
                        <ul className="suggestions">
                          {ch.suggestions.map((s) => (
                            <li key={s.curriculum_node_id}>
                              <span>{s.node_title}</span>
                              <span className="conf">{s.suggested ? pct(s.confidence) : "manual"}</span>
                              <span className={`chip state-${s.state}`}>{s.state}</span>
                              <MappingDecision jobId={job.id} chapterId={ch.id} nodeId={s.curriculum_node_id} chapterTitle={ch.title} nodeTitle={s.node_title} state={s.state} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
