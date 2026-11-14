import type { ReactNode } from "react";
import { requireAdultPage } from "../../../server/page-auth";
import { LogoutButton } from "../_components/logout-button";
import { Nav } from "../_components/nav";

/** Every portal page also calls requireAdultPage() itself (layouts are not re-run on every navigation). */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const adult = await requireAdultPage();
  return (
    <>
      <header className="topbar">
        <div className="brand">
          Break<span>N</span>Learn <small>Admin</small>
        </div>
        <div className="who">
          <span>{adult.email}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="shell">
        <Nav />
        <main id="main">{children}</main>
      </div>
    </>
  );
}
