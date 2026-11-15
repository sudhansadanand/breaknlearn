import Link from "next/link";
import { Uuid } from "@bnl/contracts";
import { ANY_STAFF, loadLessonDetail } from "../../../../../server/content/lessons";
import { loadForStaff } from "../../../../../server/content/page";
import { requireAdultPage } from "../../../../../server/page-auth";
import { ManifestRevisions } from "../lesson-actions";
import { LessonEditor } from "./lesson-editor";
import "../lessons.css";

export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const adult = await requireAdultPage();
  const { id } = await params;
  const parsed = Uuid.safeParse(id);
  const view = parsed.success ? await loadForStaff(adult, ANY_STAFF, (sql, held) => loadLessonDetail(sql, parsed.data, held, adult.userId)) : null;
  if (view?.kind === "forbidden") {
    return (
      <>
        <h1>Lesson</h1>
        <p className="status err" role="alert">{view.message}</p>
      </>
    );
  }
  if (!view || !view.data) {
    return (
      <>
        <h1>Lesson not found</h1>
        <p><Link href="/admin/lessons">Back to lessons</Link></p>
      </>
    );
  }
  const d = view.data;
  return (
    <>
      <p><Link href="/admin/lessons">← All lessons</Link></p>
      <h1>{d.versions[0] ? String((d.versions[0].content as { title?: unknown }).title ?? d.lesson.title) : d.lesson.title}</h1>
      <p className="muted mono">{d.lesson.stable_key} · grade {d.lesson.grade} · {d.lesson.template_key}</p>
      <LessonEditor lesson={d.lesson} versions={d.versions} liveVersionId={d.live_version_id} viewer={d.viewer} />
      <section className="card" aria-labelledby="pubs-h">
        <h2 id="pubs-h">Publication history</h2>
        {d.publications.length === 0 ? (
          <p className="muted">Never published.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Published</th>
                <th scope="col">Reason</th>
                <th scope="col">Manifest</th>
                <th scope="col">Unpublished</th>
              </tr>
            </thead>
            <tbody>
              {d.publications.map((p) => (
                <tr key={p.id}>
                  <td>v{p.version_no} {p.unpublished_at === null && <span className="chip live">live</span>}</td>
                  <td>{p.published_at ? new Date(p.published_at).toLocaleString("en-IN") : "—"}</td>
                  <td>{p.reason}</td>
                  <td>{p.manifest_revision !== null ? `#${p.manifest_revision}` : "—"}</td>
                  <td>{p.unpublished_at ? `${new Date(p.unpublished_at).toLocaleString("en-IN")} — ${p.unpublish_reason ?? ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" aria-labelledby="man-h">
        <h2 id="man-h">Manifest revisions (grade {d.lesson.grade})</h2>
        <ManifestRevisions grade={d.lesson.grade} revisions={d.manifests} canPin={d.viewer.roles.includes("publisher")} />
      </section>
    </>
  );
}
