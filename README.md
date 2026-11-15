# BreakNLearn

Little breaks. Big discoveries.

TV-first learning app for two children (Grade 2 and Grade 6), plus the platform behind it: curriculum CMS, school syllabus mapping, telemetry, assessments, learning-score engine and a guardian/admin dashboard.

| Path | What |
|---|---|
| `legacy/live-snapshot-2026-11-14/` | Exact bytes of the live app on 2026-11-14. Never edit. |
| `apps/student/` | Student TV app (currently identical to the live app). |
| `apps/admin/` | Next.js: `/admin` UI and `/api/v1` BFF (from P1). |
| `packages/contracts/` | Frozen Zod schemas, OpenAPI 3.1, telemetry JSON Schema, catalog constants. |
| `supabase/` | Migrations, seeds, RLS tests (from P1). Blueprint for reference only. |
| `tests/e2e/` | Playwright: live-app regression + platform E2E. |
| `docs/` | Inventory, ADRs, handoff spec, runbooks. |

## Quick start

```bash
corepack enable          # or: npm i -g pnpm@10.28.0
pnpm install
pnpm check:snapshot      # live snapshot integrity
pnpm lint && pnpm typecheck && pnpm test
pnpm exec playwright install chromium   # first time only
pnpm test:e2e            # live-app regression suite
pnpm --filter @bnl/student dev          # http://127.0.0.1:4173
```

Copy `.env.example` to `.env.local` for later milestones. No production credentials are needed or stored anywhere in this repo.

Progress and blockers: [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md). Design decisions: [`docs/adr/`](docs/adr).

**Production is owner-gated:** nothing in this repo deploys to `breaknlearn.vercel.app`.
