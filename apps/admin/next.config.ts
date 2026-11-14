/**
 * ADR-0006: one origin. Student static files (copied into public/ at build)
 * keep their URLs: `/` → /index.html, /logo.webp, /music.wav. Admin UI under
 * /admin, BFF under /api/v1. Security headers are set in src/middleware.ts.
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@bnl/auth", "@bnl/contracts", "@bnl/student-progress", "@bnl/telemetry"],
  // Lint runs once at the monorepo root (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/index.html" }],
    };
  },
};

export default nextConfig;
