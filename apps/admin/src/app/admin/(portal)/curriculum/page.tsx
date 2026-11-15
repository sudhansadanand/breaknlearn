import { HttpError, newRequestId } from "@bnl/auth";
import { GRADE_SUBJECTS } from "@bnl/contracts";
import Link from "next/link";
import { CurriculumQuery, loadCurriculum, type CurriculumView } from "../../../../server/curriculum/curriculum-handlers";
import { getDeps } from "../../../../server/deps";
import { requireAdultPage } from "../../../../server/page-auth";
import { NodeReviewActions } from "./review-actions";
import "./curriculum.css";

export const dynamic = "force-dynamic";

const STATUS_LABEL = { draft: "Draft", in_review: "In review", verified: "Verified", archived: "Archived" } as const;

type Search = Record<string, string | string[] | undefined>;

export default async function CurriculumPage({ searchParams }: { searchParams: Promise<Search> }) {
  const adult = await requireAdultPage();
  const raw = await searchParams;
  const flat = Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" && v !== "" ? [[k, v]] : [])));
  const parsed = CurriculumQuery.safeParse(flat);
  const query = parsed.success ? parsed.data : CurriculumQuery.parse({});
  let view: CurriculumView | null = null;
  let denied: string | null = null;
  try {
    view = await loadCurriculum({ requestId: newRequestId(), deps: getDeps() }, adult, query);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 409 || err.status === 422)) denied = err.message;
    else throw err;
  }
  const canSubmit = view?.staffRoles.some((r) => r === "editor" || r === "reviewer") ?? false;
  const canReview = view?.staffRoles.includes("reviewer") ?? false;
  const grade = query.grade;
  const subjects = grade ? GRADE_SUBJECTS[grade] : [...new Map([...GRADE_SUBJECTS[2], ...GRADE_SUBJECTS[6]].map((s) => [s.key, s])).values()];
  const nextHref = view?.nextCursor ? `/admin/curriculum?${new URLSearchParams({ ...flat, cursor: view.nextCursor }).toString()}` : null;

  return (
    <>
      <h1>Curriculum</h1>
      <p className="muted">
        Grade-wise topics. Seeded topics are editorial proposals: they stay <span className="chip editorial_unverified">Editorial (unverified)</span> until a
        reviewer cites the official CISCE source by page or section.
      </p>
      {!parsed.success && <p className="status err" role="alert">Some filters were invalid and were ignored.</p>}
      <section className="card" aria-labelledby="filter-h">
        <h2 id="filter-h">Find topics</h2>
        <form method="get" action="/admin/curriculum" className="filters" role="search">
          <div>
            <label htmlFor="f-grade">Grade</label>
            <select id="f-grade" name="grade" defaultValue={grade ? String(grade) : ""}>
              <option value="">All</option>
              <option value="2">Grade 2</option>
              <option value="6">Grade 6</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-subject">Subject</label>
            <select id="f-subject" name="subject_key" defaultValue={query.subject_key ?? ""}>
              <option value="">All</option>
              {subjects.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-status">Review status</label>
            <select id="f-status" name="review_status" defaultValue={query.review_status ?? ""}>
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-q">Search titles</label>
            <input id="f-q" name="q" type="search" maxLength={100} defaultValue={query.q ?? ""} />
          </div>
          <div>
            <button type="submit">Apply</button>
          </div>
        </form>
      </section>

      {denied ? (
        <p className="status err" role="alert">{denied}</p>
      ) : view && view.nodes.length === 0 ? (
        <p className="muted">No topics match these filters.</p>
      ) : view ? (
        <section className="card" aria-labelledby="list-h">
          <h2 id="list-h">Topics</h2>
          <div className="table-wrap">
            <table>
              <caption className="muted">{canReview ? "You can submit, verify and archive topics." : canSubmit ? "You can submit topics for review." : "Read-only view."}</caption>
              <thead>
                <tr>
                  <th scope="col">Grade</th>
                  <th scope="col">Topic</th>
                  <th scope="col">Authority</th>
                  <th scope="col">Status</th>
                  <th scope="col">Source</th>
                  {canSubmit && <th scope="col">Review</th>}
                </tr>
              </thead>
              <tbody>
                {view.nodes.map((n) => (
                  <tr key={n.id} className={n.node_type === "subject" ? "row-subject" : undefined}>
                    <td>{n.grade}</td>
                    <td>
                      {n.title}
                      <div className="muted">
                        <small>{n.stable_key}</small>
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${n.authority}`}>{n.authority_label}</span>
                    </td>
                    <td>
                      <span className="chip status">{STATUS_LABEL[n.review_status]}</span>
                    </td>
                    <td>{n.source_ref ?? <span className="muted">—</span>}</td>
                    {canSubmit && (
                      <td>
                        <NodeReviewActions nodeId={n.id} title={n.title} reviewStatus={n.review_status} canReview={canReview} canSubmit={canSubmit} sourceDocuments={view.sourceDocuments} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextHref && (
            <div className="pager">
              <Link href={nextHref}>Next page →</Link>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
