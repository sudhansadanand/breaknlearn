/**
 * ADR-0006: one origin. Student static files (copied into public/ at build)
 * keep their URLs: `/` → /index.html, /logo.webp, /music.wav. Admin UI under
 * /admin, BFF under /api/v1. Security headers are set in src/middleware.ts.
 */
import type { NextConfig } from "next";

/** School demo pages served at /demo/<page> from apps/prototype/<page>.html. */
const DEMO_PAGES = ["teacher", "child", "growth", "class", "privacy"] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@bnl/auth", "@bnl/contracts", "@bnl/student-progress", "@bnl/telemetry"],
  // Lint runs once at the monorepo root (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    // The student service worker must always be revalidated so the kill switch reaches every TV.
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
        // Concept prototype (static, no data): see apps/prototype.
        { source: "/prototype", destination: "/prototype/index.html" },
        // School demo (static, fictional data, no ribbon): see apps/prototype/demo.html.
        { source: "/demo", destination: "/prototype/demo.html" },
        ...DEMO_PAGES.map((page) => ({ source: `/demo/${page}`, destination: `/prototype/${page}.html` })),
      ],
    };
  },
};

export default nextConfig;
