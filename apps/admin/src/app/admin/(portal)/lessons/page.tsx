import Link from "next/link";
import { contentRepo } from "../../../../server/content/port";
import { ANY_STAFF, lessonListItem, manifestRevisionOut } from "../../../../server/content/lessons";
import { loadForStaff } from "../../../../server/content/page";
import { requireAdultPage } from "../../../../server/page-auth";
import { ManifestRevisions, NewLessonForm } from "./lesson-actions";
import { StatusChip } from "./status-chip";
import "./lessons.css";

export const dynamic = "force-dynamic";

export default async function LessonsPage() {
  const adult = await requireAdultPage();
  const view = await loadForStaff(adult, ANY_STAFF, async (sql) => {
    const repo = contentRepo();
    return {
      lessons: (await repo.listLessons(sql, { afterKey: null, limit: 100 })).map(lessonListItem),
      manifests: { 2: (await repo.listManifests(sql, 2, 10)).map(manifestRevisionOut), 6: (await repo.listManifests(sql, 6, 10)).map(manifestRevisionOut) },
    };
  });
  if (view.kind === "forbidden") {
    return (
      <>
        <h1>Lessons</h1>
        <p className="status err" role="alert">{view.message}</p>
      </>
    );
  }
  const { lessons, manifests } = view.data;
  const isEditor = view.roles.includes("editor");
  const isPublisher = view.roles.includes("publisher");
  return (
    <>
      <h1>Lessons</h1>
      <p className="muted">Your roles: {view.roles.join(", ")}. Drafts are never shown to students; only published versions appear in the catalog.</p>
      <section className="card" aria-labelledby="lessons-h">
        <h2 id="lessons-h">All lessons</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Lesson</th>
              <th scope="col">Grade</th>
              <th scope="col">Latest version</th>
              <th scope="col">Live</th>
            </tr>
          </thead>
          <tbody>
            {lessons.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/admin/lessons/${l.id}`}>{l.latest_version?.title ?? l.title}</Link>
                  <div className="muted mono">{l.stable_key}</div>
                </td>
                <td>{l.grade}</td>
                <td>
                  {l.latest_version ? (
                    <>
                      v{l.latest_version.version_no} <StatusChip status={l.latest_version.status} />{" "}
                      {l.latest_version.validation_error_count > 0 && <span className="chip errors">{l.latest_version.validation_error_count} errors</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{l.live_version ? <span className="chip live">v{l.live_version.version_no} live</span> : <span className="muted">Not published</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {isEditor && (
        <section className="card" aria-labelledby="new-h">
          <h2 id="new-h">New multiplication lesson</h2>
          <NewLessonForm />
        </section>
      )}
      <section className="card" aria-labelledby="manifests-h">
        <h2 id="manifests-h">Published manifest revisions</h2>
        <p className="muted">Pinning re-publishes an earlier revision as a new one (emergency rollback). Students pick it up on their next catalog check.</p>
        <div className="grid2">
          <ManifestRevisions grade={2} revisions={manifests[2]} canPin={isPublisher} />
          <ManifestRevisions grade={6} revisions={manifests[6]} canPin={isPublisher} />
        </div>
      </section>
    </>
  );
}
