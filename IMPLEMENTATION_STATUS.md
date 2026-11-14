# Implementation status

Single source of truth for progress, blockers and verified commands. Unrun = NOT VERIFIED.

## Milestones

| Milestone | Scope | Status | PR |
|---|---|---|---|
| Baseline | Exact snapshot of live app on `main` | ✅ done (hash-verified) | direct commit `main` |
| P0 | Inventory, frozen contracts, ADRs, dev setup, regression fixture | ✅ ready for review | `foundation/contracts` |
| P1 | DB migrations + RLS, adult auth, household pairing, profile migration | ⏳ next | — |
| P2 | Curriculum explorer, school import, lesson editor, publishing, catalog API | ○ | — |
| P3 | Student runtime: catalog consumer, offline cache, legacy import | ○ | — |
| P4 | Telemetry queue/ingest, progress sync, assessments | ○ | — |
| P5 | ELS engine, parent analytics, recommendations | ○ | — |
| P6 | E2E, security review, runbooks, LG test plan | ○ | — |
| P7 | Owner-gated production rollout | ⛔ needs written owner approval | — |

## P0 gate evidence (2026-11-14, Node 22.23, pnpm 10.28)

| Gate | Command | Result |
|---|---|---|
| existing_student_regression_fixture | `pnpm test:e2e` | 9/9 passed (Chromium 1080p) |
| openapi_valid | `pnpm --filter @bnl/contracts test` (OpenAPI 3.1 validator) | passed |
| JSON_schema_valid + Zod parity | same suite (28 tests) | passed |
| snapshot integrity | `pnpm check:snapshot` | 3/3 hashes match |
| lint / typecheck | `pnpm lint`, `pnpm typecheck` | passed |

## Owner inputs (spec §14)

| Input | Status | Default in use |
|---|---|---|
| Git repository | ✅ `sudhansadanand/breaknlearn` | — |
| Supabase projects (dev/stage/prod), billing | ❓ not provided | Local Postgres/Supabase only |
| Adult admin email | ❓ not provided | Seeded synthetic owner in local dev only |
| `/admin` vs separate domain | ❓ not confirmed | `/admin` on same origin (ADR-0006) |
| Consent text / retention | ❓ not confirmed | Raw telemetry 90 d, aggregates 13 mo, consent record per guardian |
| School name / textbook TOCs | ❓ not provided | Import tested with synthetic files |
| Production deploy permission | ⛔ not given | Nothing deployed |
| Vercel project read access / deployment id | ❓ | Live site only read over public HTTPS |

## Blockers / risks
- No Vercel API access: current production deployment id and project settings unverified (needed for P7 rollback plan).
- Physical LG webOS testing (TV-006) requires the owner's TV; automation cannot substitute.
- Historical localStorage keys have unknown real-world shape (ADR-0002 §L2) — mitigated by verbatim backup.
