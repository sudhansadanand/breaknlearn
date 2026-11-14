import Link from "next/link";
import { requireAdultPage } from "../../../server/page-auth";

export default async function AdminHome() {
  await requireAdultPage();
  return (
    <>
      <h1>Welcome</h1>
      <p>Little breaks. Big discoveries.</p>
      <div className="grid2">
        <section className="card" aria-labelledby="dev-h">
          <h2 id="dev-h">TV devices</h2>
          <p className="muted">Pair the TV by entering the code it shows, or revoke a TV you no longer use.</p>
          <Link href="/admin/devices">Manage devices</Link>
        </section>
        <section className="card" aria-labelledby="kids-h">
          <h2 id="kids-h">Children</h2>
          <p className="muted">View and edit the two child profiles shown on the TV.</p>
          <Link href="/admin/children">Manage profiles</Link>
        </section>
      </div>
      <p className="muted">Curriculum, Lessons, Imports and Analytics arrive in later milestones.</p>
    </>
  );
}
