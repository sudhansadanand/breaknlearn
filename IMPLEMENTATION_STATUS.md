# Implementation status

Single source of truth for progress, blockers and verified commands. Unrun = NOT VERIFIED.

## Milestones

| Milestone | Scope | Status | PR |
|---|---|---|---|
| Baseline | Exact snapshot of live app on `main` | ✅ done (hash-verified) | direct commit `main` |
| P0 | Inventory, frozen contracts, ADRs, dev setup, regression fixture | ✅ ready for review | #1 `foundation/contracts` |
| P1 | DB migrations + RLS, adult auth, household pairing, profiles | ✅ ready for review (legacy-import endpoint moves to P3 with the student adapter) | #2 `p1/secure-backend` |
| P2 | Curriculum explorer, school import, lesson editor, publishing, catalog API (+ pure engines: lesson-engine, telemetry, student-progress, intelligence) | ✅ ready for review (catalog API behind `FEATURE_CATALOG_API`, enforced from P6) | `p2/content-pipeline` |
| P3 | Student runtime: catalog consumer, offline cache, legacy import | ✅ ready for review (paired mode off unless `FEATURE_STUDENT_PAIRED`) | `p3/student-app` |
| P4 | Telemetry queue/ingest, progress sync, assessments | ✅ ready for review (flags `FEATURE_TELEMETRY`, `FEATURE_ASSESSMENTS` off) | `p4/telemetry-sync` |
| P5 | ELS engine, parent analytics, recommendations | ✅ ready for review | `p5/analytics-int` |
| P6 | E2E, security review, runbooks, LG test plan | ✅ ready for review (A9-SEC-01, A9-OPS-01, A9-PRIV-01 fixed; consent wording awaiting owner approval) | `p6/qa-ops` |
| P7 | Owner-gated production rollout | ⛔ needs written owner approval | — |

## P0 gate evidence (2026-11-14, Node 22.23, pnpm 10.28)

| Gate | Command | Result |
|---|---|---|
| existing_student_regression_fixture | `pnpm test:e2e` | 9/9 passed (Chromium 1080p) |
| openapi_valid | `pnpm --filter @bnl/contracts test` (OpenAPI 3.1 validator) | passed |
| JSON_schema_valid + Zod parity | same suite (28 tests) | passed |
| snapshot integrity | `pnpm check:snapshot` | 3/3 hashes match |
| lint / typecheck | `pnpm lint`, `pnpm typecheck` | passed |

## P1 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| cross_tenant_tests_pass | `pnpm --filter @bnl/db test:integration` (throwaway Postgres 16) | 44/44 |
| device_revocation_test, identity_spoof_denied | `pnpm --filter @bnl/admin test:integration` (handlers × real RLS) | 6/6 |
| auth / BFF unit + route tests | `pnpm test` | auth 41, admin 92, db 9, contracts 28 |
| student bytes unchanged when co-hosted | `pnpm --filter @bnl/admin build && pnpm --filter @bnl/admin test:served` | 4/4 sha256 match |

Deferred from P1 (tracked): Supabase Storage buckets/policies (SEC-007, needs Supabase project → P2 imports), data-deletion job (OPS-005 → P6), Supabase session refresh (sessions ~1 h).

## P2 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| SEC-001 every admin route fails closed | `apps/admin/test/sec-001.test.ts` auto-discovers every `route.ts` under `api/v1/admin` | 53/53: 401 + `no-store`, no audit rows, no storage/config built before auth |
| curriculum + import + CMS route tests | `pnpm test` | admin 168 (7 files), all packages green |
| RLS / publish / item-bank backstops | `pnpm test:integration` (throwaway Postgres 16, migrations 0001–0005) | db 44/44, admin 35/35 |
| student bytes unchanged | `pnpm build && pnpm --filter @bnl/admin test:served` | sha256 match |
| live regression | `pnpm test:e2e`, `pnpm check:snapshot` | 9/9, 3/3 |

Known P2 limits: Supabase Storage driver is unit-tested against a fake only (no Supabase project yet); local-FS storage is refused in production. Quiz item keys in `bnl.quiz_items` (A4) differ from `multiplicationItemKey` in lesson-engine; reconciled in P4.

## P4 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| duplicate_events_deduped, hidden_time_excluded | `pnpm test` (telemetry 18) + `apps/admin` learning integration | pass |
| scorer_server_authoritative | `assessment-db.test.ts` (forged counts/responses rejected by 0006 guards), route tests (no answer key before submit) | pass |
| legacy import idempotent | `learning-legacy-import.test.ts` | pass |
| all suites | `pnpm test` / `pnpm test:integration` | admin 201, assessment 24; db 44/44, admin 64/64 |
| live regression + student bytes | `pnpm test:e2e`, `test:served` | 9/9, unchanged |

P4 defaults **approved by owner 2026-11-15**: review ladder 3→7→14→30 days (first check local midnight +3 d), pass mark 80%, 6-hour answer window, 3–5 questions per stage.

## P3 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| 10_tables_x_6_worlds, two_profiles_independent, legacy_migration_idempotent, offline_playback | `pnpm test:e2e` (student-* specs + legacy regression against the new bundle) | 30/30, twice in a row |
| parity with live app | `student-parity.spec.ts` drives snapshot and new bundle side by side | markup, storage and focus identical at every step |
| frozen live app still passes | `STUDENT_DIR=legacy/live-snapshot-2026-11-14 playwright test tests/e2e/legacy-regression.spec.ts` | 9/9 |
| ES5 only | `node apps/student/scripts/es5-check.mjs …` + acorn ecmaVersion 5 test | pass |
| served bytes | `pnpm build && pnpm --filter @bnl/admin test:served` | 6/6 (index, app.js, sw.js from build; logo/music = snapshot) |
| unit | `pnpm test` | student 42, admin 205 |

Not verifiable here: physical LG webOS (TV-006): service worker support, Back key 461, audio autoplay.

## P5 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| formula_fixtures, missing_retention_not_zero, no_time_in_ELS | `pnpm --filter @bnl/intelligence test` | 46/46 (incl. renormalization edges, time-invariance) |
| dashboard/API auth, cross-household | `pnpm test` (admin 242; SEC-001 auto-covers 4 new routes) | pass |
| RLS, scoring idempotency, purge | `pnpm test:integration` (migrations 0001–0007) | db 44/44, admin 70/70 |
| everything else | build, test:served, test:e2e | pass, 30/30 |

Not built yet: `GET /admin/analytics/content-quality` (editor report, falls through to 401/404); time per subject (sessions not stored per lesson). Jobs to schedule at deploy: `aggregate-sessions.mjs` → `score-learners.mjs` nightly, `score-retention-purge.mjs` daily (`BNL_JOB_DB_URL`).

## P6 gate evidence (2026-11-14)

| Gate | Command | Result |
|---|---|---|
| cross_tenant_redteam_pass | `pnpm test:integration` (redteam-tenancy, redteam-schema, redteam-deletion, redteam-routes) | db 103/103, admin 78/78 |
| full stack (login → pair → play → sync → assess → score → dashboard) | `pnpm test:fullstack` | 16/16 |
| rollback_rehearsed | `pnpm rehearse:rollback`, `pnpm rehearse:backup` | 22/22 steps; restore identical (42 tables, 333 rows, 183 policies, 54 functions) |
| all_CI_green | local: lint, typecheck, test (admin 259), build, test:served, test:e2e 39/39 | pass; CI on the PR |

Findings: A9-SEC-01 (pairing code could point at another household's device at SQL level) fixed by migration 0008; A9-OPS-01 (FEATURE_PAIRING / FEATURE_CATALOG_API / FEATURE_SCORES documented but unenforced) fixed, 503 `feature_disabled` when off; A9-PRIV-01 fixed in the owner/consent follow-up: consent enforced (403 `consent_required`), self-service export and deletion on `/admin/privacy`, nightly `process-deletion-requests.mjs`; consent wording v1 is a DRAFT awaiting owner approval (docs/privacy/CONSENT_TEXT.md). axe-core not added (focused WCAG checks in tests/a11y instead). Traceability: docs/ops/ACCEPTANCE_TRACE.md. Owner checklist for P7: docs/ops/P7_OWNER_CHECKLIST.md.

## Owner inputs (spec §14)

| Input | Status | Default in use |
|---|---|---|
| Git repository | ✅ `sudhansadanand/breaknlearn` | — |
| Supabase projects (dev/stage/prod), billing | ❓ not provided | Local Postgres/Supabase only |
| Adult admin email | ✅ provided 2026-11-15 (not stored in repo; passed to `scripts/ops/bootstrap-owner.mjs` at setup) | One-time generated password, forced change at first sign-in |
| `/admin` vs separate domain | ❓ not confirmed | `/admin` on same origin (ADR-0006) |
| Consent text / retention | ⏳ consent wording drafted by Claude for owner approval (docs/privacy/CONSENT_TEXT.md); retention not answered | Raw telemetry 90 d, aggregates 13 mo |
| School name / textbook TOCs | ❓ not provided | Import tested with synthetic files |
| Production deploy permission | ⛔ not given | Nothing deployed |
| Vercel project read access / deployment id | ❓ | Live site only read over public HTTPS |

## Blockers / risks
- No Vercel API access: current production deployment id and project settings unverified (needed for P7 rollback plan).
- Physical LG webOS testing (TV-006) requires the owner's TV; automation cannot substitute.
- Historical localStorage keys have unknown real-world shape (ADR-0002 §L2) — mitigated by verbatim backup.
