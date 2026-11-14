import { AVATARS } from "@bnl/contracts";
import { requireAdultPage, loadForHousehold } from "../../../../server/page-auth";
import { toProfile } from "../../../../server/handlers/profiles";
import { ProfileEditor } from "./profile-editor";

export default async function ChildrenPage() {
  const adult = await requireAdultPage();
  const view = await loadForHousehold(adult, async (sql, m, c) => (await c.deps.repos.profiles.listForHousehold(sql, m.householdId)).map(toProfile));
  const avatars = AVATARS.map((a) => ({ id: a.id, emoji: a.emoji }));
  return (
    <>
      <h1>Children</h1>
      {view.kind === "no_household" ? (
        <p className="status err" role="alert">{view.message}</p>
      ) : (
        <>
          <p className="muted">Two profiles, shown on the TV’s “Who’s learning?” screen. Use a first name or nickname only.</p>
          <div className="grid2">
            {([1, 2] as const).map((slot) => (
              <ProfileEditor key={slot} slot={slot} profile={view.data.find((p) => p.slot === slot) ?? null} avatars={avatars} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
