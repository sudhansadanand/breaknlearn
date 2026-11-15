import { loadForHousehold, requireAdultPage } from "../../../../server/page-auth";
import { loadDashboard, type ChildDashboard, type LessonStatusRow } from "../../../../server/analytics";
import { formatDuration } from "../../../../server/analytics/intelligence";
import { DismissButton } from "./dismiss-button";
import "./analytics.css";

export const dynamic = "force-dynamic";

const dateFmt = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

function Badge({ b }: { b: LessonStatusRow["mastery"] }) {
  return (
    <>
      <span className={`ev ev-${b.tone}`}>{b.text}</span>
      {b.detail && <span className="detail">{b.detail}</span>}
    </>
  );
}

function StatusTable({ rows, caption }: { rows: LessonStatusRow[]; caption: string }) {
  return (
    <div className="table-wrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Lesson</th>
            <th scope="col">Quiz right after lesson</th>
            <th scope="col">Later review (memory)</th>
            <th scope="col">Learning score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.lesson_id}>
              <th scope="row">{r.title}</th>
              <td><Badge b={r.mastery} /></td>
              <td><Badge b={r.retention} /></td>
              <td className="num">
                {r.score === null ? <span className="ev ev-none">{r.started ? r.status_text : "Not started yet"}</span> : <strong>{Math.round(r.score)}</strong>}
                {r.score !== null && (
                  <span className="detail">
                    {r.status_text}
                    {r.coverage_pct !== null && r.coverage_pct < 100 ? ` · based on ${Math.round(r.coverage_pct)}% of the evidence` : ""}
                    {r.flags.includes("low_confidence") ? " · few questions so far" : ""}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Child({ ch, timezone }: { ch: ChildDashboard; timezone: string }) {
  const h = `child-${ch.learner_id}`;
  return (
    <section className="card" aria-labelledby={h}>
      <h2 id={h}>{ch.display_name}</h2>

      <h3>Suggestions</h3>
      {ch.recommendations.length === 0 ? (
        <p className="muted">No suggestions right now.</p>
      ) : (
        <ul className="recs">
          {ch.recommendations.map((r) => (
            <li key={r.id} className={r.dismissed_at ? "dismissed" : undefined}>
              <strong>{r.action}</strong>
              {r.dismissed_at && <span className="muted"> (dismissed)</span>}
              <span className="detail">Why: {r.why}</span>
              <DismissButton id={r.id} dismissed={r.dismissed_at !== null} label={r.action} />
            </li>
          ))}
        </ul>
      )}

      <h3>Reviews ready</h3>
      {ch.due_reviews.length === 0 ? (
        <p className="muted">No reviews are due.</p>
      ) : (
        <ul>
          {ch.due_reviews.map((r) => (
            <li key={r.review_id}>
              {r.title}: ready since {dateFmt(r.due_at, timezone)}
              {r.overdue ? " (optional; a missed review is never counted as zero)" : ""}
            </li>
          ))}
        </ul>
      )}

      <StatusTable rows={ch.tables} caption={`Multiplication tables ×1–×10 for ${ch.display_name}`} />
      {ch.other_lessons.length > 0 && <StatusTable rows={ch.other_lessons} caption={`Other lessons for ${ch.display_name}`} />}

      <h3>Recent activity</h3>
      <p className="note">{ch.activity.note}</p>
      <dl className="activity">
        <dt>Period</dt>
        <dd>{dateFmt(ch.activity.from, timezone)} to {dateFmt(ch.activity.to, timezone)}</dd>
        <dt>Days with a session</dt>
        <dd>{ch.activity.active_days}</dd>
        <dt>Sessions</dt>
        <dd>{ch.activity.sessions}</dd>
        <dt>Estimated active playback</dt>
        <dd>{formatDuration(ch.activity.playback_ms)}</dd>
        <dt>App visible on screen (estimate)</dt>
        <dd>{formatDuration(ch.activity.foreground_estimated_ms)}</dd>
        <dt>Interactions</dt>
        <dd>{ch.activity.interaction_count}</dd>
      </dl>
    </section>
  );
}

export default async function AnalyticsPage() {
  const adult = await requireAdultPage();
  const view = await loadForHousehold(adult, (sql, m, c) => loadDashboard(sql, c, m));
  return (
    <div className="analytics">
      <h1>Learning progress</h1>
      {view.kind === "no_household" ? (
        <p className="status err" role="alert">{view.message}</p>
      ) : (
        <>
          <p className="muted">
            {view.data.scores_as_of
              ? `Scores include quiz answers up to ${dateFmt(`${view.data.scores_as_of}T12:00:00Z`, "UTC")} and are updated nightly.`
              : "Scores have not been calculated yet. They are updated nightly once quizzes have been taken."}
          </p>
          <p className="note">{view.data.notes.evidence} {view.data.notes.causality}</p>
          {view.data.children.length === 0 ? (
            <p>No child profiles yet.</p>
          ) : (
            view.data.children.map((ch) => <Child key={ch.learner_id} ch={ch} timezone={view.data.timezone} />)
          )}
        </>
      )}
    </div>
  );
}
