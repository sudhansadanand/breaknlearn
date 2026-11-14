"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/devices", label: "TV devices" },
  { href: "/admin/children", label: "Children" },
] as const;

/** Later milestones (P2/P5) fill these in. */
const PLACEHOLDERS = ["Curriculum", "Lessons", "Imports", "Analytics"] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Admin">
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
        {PLACEHOLDERS.map((label) => (
          <li key={label}>
            <span className="soon" aria-disabled="true">
              {label}
              <small>Coming soon</small>
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
