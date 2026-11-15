"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/devices", label: "TV devices" },
  { href: "/admin/children", label: "Children" },
  { href: "/admin/curriculum", label: "Curriculum" },
  { href: "/admin/imports", label: "School imports" },
  { href: "/admin/lessons", label: "Lessons" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/privacy", label: "Privacy" },
] as const;

const isCurrent = (pathname: string, href: string) =>
  href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Admin">
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} aria-current={isCurrent(pathname ?? "", l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
