import { loadForHousehold, requireAdultPage } from "../../../../server/page-auth";
import { consentState } from "../../../../server/privacy/consent";
import { CONSENT_SCOPES, CONSENT_SECTIONS, CONSENT_TITLE, CONSENT_VERSION, DECLARATION, DRAFT_NOTICE, SCOPE_TEXT } from "../../../../server/privacy/consent-text";
import { DELETION_CONFIRMATION, DELETION_TARGET_DAYS, toApiDeletionRequest } from "../../../../server/privacy/handlers";
import { privacyRepo } from "../../../../server/privacy/repo";
import { ConsentForm, DeletionForm } from "./privacy-actions";
import "./privacy.css";

const SCOPE_LABEL: Record<string, string> = {
  telemetry_only: "Detailed activity records",
  learner: "One child's data",
  household: "Whole household",
};
const STATUS_LABEL: Record<string, string> = {
  requested: "Waiting for the nightly run",
  processing: "In progress",
  completed: "Completed",
  rejected: "Not carried out",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—");

/** A9-PRIV-01: parental notice, consent per scope, export and deletion requests for the signed-in household. */
export default async function PrivacyPage() {
  const adult = await requireAdultPage();
  const view = await loadForHousehold(adult, async (sql, m, c) => {
    const [active, learners, requests] = [
      await c.deps.repos.consent.active(sql, m.householdId),
      await c.deps.repos.profiles.listForHousehold(sql, m.householdId),
      await privacyRepo().listDeletionRequests(sql, m.householdId),
    ];
    return {
      consent: consentState(active),
      learners: learners.map((l) => ({ id: l.id, name: l.displayName })),
      requests: requests.map(toApiDeletionRequest),
    };
  });
  return (
    <>
      <h1>Privacy and consent</h1>
      {view.kind === "no_household" ? (
        <p className="status err" role="alert">{view.message}</p>
      ) : (
        <>
          {view.data.consent.text_status === "draft" && (
            <p className="privacy-draft" role="note">
              <strong>Draft wording.</strong> {DRAFT_NOTICE}
            </p>
          )}
          {view.data.consent.needs_review && (
            <p className="status err" role="note">
              This notice has changed since consent was given. Please read it again and save your choices.
            </p>
          )}

          <section className="card privacy-notice" aria-labelledby="notice-h">
            <h2 id="notice-h">{CONSENT_TITLE}</h2>
            <p className="muted">Version {CONSENT_VERSION}</p>
            {CONSENT_SECTIONS.map((s) => (
              <section key={s.id} aria-labelledby={`notice-${s.id}`}>
                <h3 id={`notice-${s.id}`}>{s.heading}</h3>
                {s.paragraphs.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {s.bullets.length > 0 && (
                  <ul>
                    {s.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </section>

          <section className="card privacy-choices" aria-labelledby="choices-h">
            <h2 id="choices-h">Your consent choices</h2>
            <p>{DECLARATION}</p>
            <ConsentForm
              version={CONSENT_VERSION}
              scopes={CONSENT_SCOPES.map((scope) => {
                const st = view.data.consent.scopes.find((s) => s.scope === scope);
                return { scope, ...SCOPE_TEXT[scope], granted: st?.granted ?? false, current: st?.current ?? false, grantedAt: when(st?.granted_at ?? null) };
              })}
            />
          </section>

          <section className="card" aria-labelledby="export-h">
            <h2 id="export-h">Download your data</h2>
            <p>
              Download every record the app holds for your household as one JSON file: child profiles, progress, quiz answers, activity,
              scores, TVs, consent and the activity log. Passwords, device keys and other secrets are never included.
            </p>
            <p>
              <a className="privacy-download" href="/api/v1/admin/privacy/export" download>
                Download all data (JSON)
              </a>
            </p>
          </section>

          <section className="card privacy-delete" aria-labelledby="delete-h">
            <h2 id="delete-h">Delete data</h2>
            {view.membership.role === "owner" ? (
              <DeletionForm learners={view.data.learners} confirmation={DELETION_CONFIRMATION} targetDays={DELETION_TARGET_DAYS} />
            ) : (
              <p>Only the household owner can ask for data to be deleted. You can still download the data above.</p>
            )}
          </section>

          <section className="card" aria-labelledby="requests-h">
            <h2 id="requests-h">Deletion requests</h2>
            {view.data.requests.length === 0 ? (
              <p className="muted">No deletion requests yet.</p>
            ) : (
              <div className="privacy-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">What</th>
                      <th scope="col">Requested</th>
                      <th scope="col">Status</th>
                      <th scope="col">Done by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.data.requests.map((r) => (
                      <tr key={r.id}>
                        <td>
                          {SCOPE_LABEL[r.scope] ?? r.scope}
                          {r.learner_id ? ` (${view.data.learners.find((l) => l.id === r.learner_id)?.name ?? "removed profile"})` : ""}
                        </td>
                        <td>{when(r.requested_at)}</td>
                        <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                        <td>{r.completed_at ? when(r.completed_at) : `by ${when(r.complete_by)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
