import { requireAdultPage, loadForHousehold } from "../../../../server/page-auth";
import { toDevice } from "../../../../server/handlers/devices";
import { PairDeviceForm, RevokeButton } from "./device-actions";

export default async function DevicesPage() {
  const adult = await requireAdultPage();
  const view = await loadForHousehold(adult, async (sql, m, c) => (await c.deps.repos.devices.listForHousehold(sql, m.householdId)).map(toDevice));
  return (
    <>
      <h1>TV devices</h1>
      {view.kind === "no_household" ? (
        <p className="status err" role="alert">{view.message}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="pair-h">
            <h2 id="pair-h">Pair a TV</h2>
            <p className="muted">On the TV, open BreakNLearn and choose “Connect to family”. Enter the 8-character code it shows.</p>
            <PairDeviceForm />
          </section>
          <section className="card" aria-labelledby="list-h">
            <h2 id="list-h">Paired devices</h2>
            {view.data.length === 0 ? (
              <p className="muted">No devices paired yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Paired</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.data.map((d) => (
                    <tr key={d.id}>
                      <td>{d.label}</td>
                      <td>{new Date(d.paired_at).toLocaleString("en-IN")}</td>
                      <td>{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("en-IN") : "—"}</td>
                      <td>{d.revoked_at ? <span className="badge revoked">Revoked</span> : <RevokeButton deviceId={d.id} label={d.label} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
