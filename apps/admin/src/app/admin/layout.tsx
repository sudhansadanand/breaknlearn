import type { ReactNode } from "react";
import "./admin.css";

export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {children}
    </>
  );
}
