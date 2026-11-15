import { GRADE_SUBJECTS } from "@bnl/contracts";
import Link from "next/link";
import { getCurriculumDeps } from "../../../../server/curriculum/deps";
import { loadForHousehold, requireAdultPage } from "../../../../server/page-auth";
import { CreatePlanForm, ImportForm } from "./import-forms";
import "../curriculum/curriculum.css";

export const dynamic = "force-dynamic";

const subjectLabel = (grade: 2 | 6, key: string) => GRADE_SUBJECTS[grade].find((s) => s.key === key)?.label ?? key;
const STATUS = { queued: "Queued", extracting: "Extracting", review: "Ready for review", failed: "Needs attention", approved: "Approved" } as const;

export default async function ImportsPage() {
  const adult = await requireAdultPage();
  const deps = getCurriculumDeps();
  const view = await loadForHousehold(adult, async (sql, m) => ({
    plans: await deps.repo.listPlans(sql, m.householdId),
    jobs: await deps.repo.listJobs(sql, m.householdId, 50),
  }));
  if (view.kind === "no_household") {
    return (
      <>
        <h1>School imports</h1>
        <p className="status err" role="alert">{view.message}</p>
      </>
    );
  }
  const { plans, jobs } = view.data;
  const planLabel = (id: string) => {
    const p = plans.find((x) => x.id === id);
    return p ? `Grade ${p.grade} ${subjectLabel(p.grade, p.subjectKey)} · ${p.academicYear}${p.schoolLabel ? ` · ${p.schoolLabel}` : ""}` : "Unknown plan";
  };
  return (
    <>
      <h1>School imports</h1>
      <p className="muted">
        Map your school&apos;s textbook chapters to BreakNLearn topics. Uploads are private to your household; suggestions need your approval and never publish anything.
      </p>
      <div className="grid2">
        <section className="card" aria-labelledby="plan-h">
          <h2 id="plan-h">New school plan</h2>
          <CreatePlanForm />
        </section>
        <section className="card" aria-labelledby="import-h">
          <h2 id="import-h">Import a table of contents</h2>
          <ImportForm plans={plans.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, label: planLabel(p.id) }))} />
        </section>
      </div>
      <section className="card" aria-labelledby="jobs-h">
        <h2 id="jobs-h">Imports</h2>
        {jobs.length === 0 ? (
          <p className="muted">No imports yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Type</th>
                  <th scope="col">Chapters</th>
                  <th scope="col">Status</th>
                  <th scope="col">Imported</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link href={`/admin/imports/${j.id}`}>{planLabel(j.schoolPlanId)}</Link>
                    </td>
                    <td>{j.jobType === "pdf_text" ? "PDF" : j.jobType === "docx" ? "DOCX" : j.jobType === "csv" ? "CSV" : "Pasted / text"}</td>
                    <td>{j.chapterCount}</td>
                    <td>
                      <span className="chip status">{STATUS[j.status]}</span>
                    </td>
                    <td>{j.createdAt.toLocaleString("en-IN")}</td>
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
