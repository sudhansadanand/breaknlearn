# Acceptance trace (P6)

Maps every ID in `docs/handoff/testing/ACCEPTANCE_MATRIX.md` to the automated tests that prove it, to a
manual or hardware procedure, or to a gap. Paths are relative to the repo root. `file › "test name"` refers to a
Vitest `it`/`describe` or a Playwright `test`. Commands:

| Suite | Command |
|---|---|
| unit | `pnpm test` |
| integration (throwaway Postgres 16, real roles + RLS) | `pnpm test:integration` |
| served admin build | `pnpm --filter @bnl/admin test:served` |
| student E2E (built bundle, headless Chromium 1080p) | `pnpm test:e2e --trace off` |
| full stack (`next start` + harness DB + dev auth + all flags on) | `node tests/fullstack/run.mjs --trace off` (needs `pnpm build` first) |
| rehearsals | `node scripts/ops/rehearse-rollback.mjs`, `node scripts/ops/rehearse-backup-restore.mjs` |

Status key:
- **auto**: an automated test proves the whole requirement.
- **auto (partial)**: an automated test proves part of it; the remainder is listed.
- **manual/hardware**: a person has to check it; the procedure is linked.
- **gap**: nothing proves it yet.

Evidence for the run on 2026-11-14 is in the A9 final report and in `docs/security/SECURITY_REVIEW.md`.

## Identity, privacy and access (blocking)

| ID | Status | Evidence |
|---|---|---|
| SEC-001 | auto | `apps/admin/test/sec-001.test.ts` › "SEC-001 API", "SEC-001 pages"; `apps/admin/test/content/content-routes.test.ts` › "SEC-001 coverage of the CMS surface"; `apps/admin/test/curriculum/routes.test.ts` › "SEC-001: every new route requires an adult session", "SEC-001: curriculum/import pages verify the session server-side"; `apps/admin/test/integration/redteam-routes.test.ts` › "an adult session cookie is not a device credential" (garbage/forged sessions on every adult route) |
| SEC-002 | auto | `apps/admin/test/content/content-routes.test.ts` › "SEC-002 role separation"; `apps/admin/test/integration/content-workflow.test.ts` › "editor saves a draft … but cannot publish or approve (SEC-002)"; `packages/db/test/integration/security.test.ts` › "an editor cannot approve or publish; a reviewer cannot approve their own version"; `packages/db/test/integration/redteam-tenancy.test.ts` › "staff workflow functions refuse an actor id that is not the session user" |
| SEC-003 | auto | `packages/db/test/integration/redteam-tenancy.test.ts` › "every attacker × every household table: read, update and delete of household X" (24 household tables × 12 attackers), "household Y's device cannot insert any learning row claiming household X or X's learners"; `apps/admin/test/integration/redteam-routes.test.ts` › "profiles, progress, telemetry, legacy import and assessments refuse every forged or foreign device credential"; `packages/db/test/integration/security.test.ts` › "SEC-003 cross-household access with guessed UUIDs"; `apps/admin/test/integration/learning-progress.test.ts` › "SEC-003: another household's learner → 403 …"; `apps/admin/test/integration/identity-db.test.ts` › "SEC-003: writing household B's learner id is refused …" |
| SEC-004 | auto | `packages/db/test/integration/security.test.ts` › "SEC-004 revoked devices"; `apps/admin/test/integration/learning-progress.test.ts` › "SEC-004: revoked device → 401 for sync and read"; `apps/admin/test/integration/learning-telemetry.test.ts` › "SEC-004: a revoked device is refused (401) and writes nothing"; `apps/admin/test/integration/redteam-routes.test.ts` (attacker "X revoked TV"); local playback after revoke: `apps/student/test/paired.test.ts` › "… a revoked device (refresh 401) stops all device writes but keeps local progress" |
| SEC-005 | auto | `packages/db/test/integration/redteam-schema.test.ts` (15 tests: RLS enabled+forced on all 42 tables, no PUBLIC policies, PUBLIC/anon/authenticated ACL sweep over schema/tables/columns/sequences/functions/types/default ACLs, privilege and SECURITY DEFINER EXECUTE snapshots); `packages/db/test/integration/security.test.ts` › "SEC-005 schema-wide grants and RLS" |
| SEC-006 | auto | `packages/db/test/integration/security.test.ts` › "public sees exactly the ten live lessons and nothing private"; `apps/admin/test/integration/content-catalog.test.ts` › "SEC-006 / CAT-005 public catalog"; `apps/admin/test/integration/redteam-routes.test.ts` › "the public catalog never serves a draft lesson id (SEC-006 IDOR)" |
| SEC-007 | auto | `apps/admin/test/integration/curriculum-db.test.ts` › "cross-household denial and SEC-007 private file access"; `apps/admin/test/curriculum/routes.test.ts` › "job access across households (SEC-007)"; `apps/admin/test/integration/redteam-routes.test.ts` › "analytics, recommendations, devices, school plans and imports never reveal or change X" (signed URL for X's object refused for Y, outsider and anonymous); `packages/db/test/integration/redteam-tenancy.test.ts` › "object keys are household-prefixed (DB check) and invisible across households and to the public". Real Supabase Storage bucket policy: **manual**, `docs/ops/DEPLOYMENT_RUNBOOK.md` §4 |
| SEC-008 | auto | `apps/admin/test/content/content-routes.test.ts` › "SEC-008 publish re-validates content"; `packages/lesson-engine/test/lesson-engine.test.ts` › "SEC-008: rejects markup/script in text"; oversize/type/traversal: `apps/admin/test/curriculum/routes.test.ts`, `apps/admin/test/integration/curriculum-db.test.ts`, `packages/storage` tests; telemetry 413: `apps/admin/test/integration/learning-telemetry.test.ts` › "TEL-004: oversize body → 413 …"; excessive requests: `apps/admin/test/sec-009.test.ts` (pairing bootstrap per-IP limit), `apps/admin/test/integration/redteam-routes.test.ts` › "a guessed pairing_id / poll secret never yields a token, and brute force burns the code"; `apps/admin/test/redteam/static-guards.test.ts` › "R1: SQL is never built from input" |
| SEC-009 | auto | `apps/admin/test/sec-009.test.ts` › "SEC-009 CSRF / Origin", "SEC-009 login"; against the real `next start` build: `tests/fullstack/02-admin-a11y.spec.ts` › "SEC-009: repeated failed sign-ins for one email are rate limited (429) without revealing the account" |
| SEC-010 | auto | `packages/db/test/integration/security.test.ts` › "SEC-010 staff never see child-level rows"; `packages/db/test/integration/redteam-tenancy.test.ts` (five staff attackers × every household table; "adults and devices reading staff/ops tables"); `apps/admin/test/integration/redteam-routes.test.ts` › "a household owner without staff roles is refused on every lesson/manifest/curriculum mutation and on drafts"; `apps/admin/test/analytics/page-render.test.ts` › "renders only the caller's children …". Editors see no aggregate stats at all (none are permitted yet) |

## Learning/catalog correctness

| ID | Status | Evidence |
|---|---|---|
| CAT-001 | auto | `packages/contracts/test/contracts.test.ts` › "CAT-001/CAT-002 subject arrays identical to live code, in order"; `tests/e2e/legacy-regression.spec.ts` › "CAT-001/002: exact subject tiles per grade; only Grade 2 Math is live" |
| CAT-002 | auto | same two tests as CAT-001 |
| CAT-003 | auto | `tests/e2e/legacy-regression.spec.ts` › "CAT-003: Grade 2 Math -> tables x1..x10 -> six worlds each"; `tests/e2e/student-catalog.spec.ts` › "×N: all six worlds play 10 slides at 7 s, quiz, completion" (×1..×10) |
| CAT-004 | auto | `packages/lesson-engine/test/lesson-engine.test.ts` › "CAT-004: every factor 1..10 × step 1..10 …", "CAT-004: 4 unique positive options, exactly one correct …"; `packages/lesson-engine/test/item-bank.test.ts` › "CAT-004: every fact has 4 distinct positive options and exactly one correct"; `tests/e2e/legacy-regression.spec.ts` › "CAT-004: every fact for x1..x10 shows the right product and picture count" |
| CAT-005 | auto | `packages/db/test/integration/catalog.test.ts` › "CAT-005 initial catalog"; `apps/admin/test/integration/content-catalog.test.ts` › "CAT-005: grade 6 manifest has no playable lessons" |
| CAT-006 | auto | `apps/admin/test/integration/curriculum-db.test.ts` › "CAT-006: verified CISCE outcomes need a source document, page and a reviewer"; `apps/admin/test/curriculum/routes.test.ts` › "POST /admin/curriculum/{nodeId}/review (CAT-006)" |
| CAT-007 | auto | `packages/db/test/integration/workflow.test.ts` › "CAT-007 published versions are immutable"; `apps/admin/test/integration/content-workflow.test.ts` › "CAT-007 editing a published lesson"; `apps/admin/test/content/content-routes.test.ts` › "saving again edits the draft in place; after submit a save creates v2 (CAT-007)" |
| CAT-008 | auto | `apps/admin/test/integration/content-workflow.test.ts` › "publisher publishes: manifest revision bumps, ETag changes, the student manifest shows the lesson (CAT-008)"; stale client keeps last valid cache: `apps/student/test/paired.test.ts` › "replaces the built-in tables only with a complete valid catalog and caches it" |
| CAT-009 | auto | `apps/admin/test/integration/curriculum-db.test.ts` › "CAT-009 / CAT-010: imports stage review candidates and never publish"; `apps/admin/test/curriculum/routes.test.ts` › "stages chapters and suggestions from a pasted TOC, stores privately, publishes nothing (CAT-009)" |
| CAT-010 | auto | `apps/admin/test/integration/curriculum-db.test.ts` › "CAT-010: the same checksum for the same plan returns the existing job and adds no chapters or mappings"; `apps/admin/test/curriculum/routes.test.ts` › "CAT-010: the same file again returns the existing job and stages nothing new" |

## Profiles/migration/offline

| ID | Status | Evidence |
|---|---|---|
| MIG-001 | auto (partial) | `tests/e2e/student-profiles.spec.ts` › "two explorers are independent and survive relaunch"; `tests/e2e/legacy-regression.spec.ts` › "MIG-001: two independent profiles persist across reload". Persistence across an LG power cycle is **manual/hardware**: `docs/ops/LG_TV_TEST_PLAN.md` step 6 |
| MIG-002 | auto | `packages/student-progress/test/student-progress.test.ts` › "MIG-002: preserves both profiles …"; `packages/student-progress/test/legacy-import.test.ts` › "MIG-002: inserts one legacy attempt per …"; `apps/admin/test/integration/learning-legacy-import.test.ts` › "MIG-002: two profiles keep per-table/per-world progress …"; `tests/e2e/student-migration.spec.ts`; `tests/e2e/legacy-regression.spec.ts` › "MIG-002/003: live-shaped storage restores profiles …"; end to end with a paired TV: `tests/fullstack/01-guardian-tv-flow.spec.ts` › "a TV pairs through the guardian portal, links explorers and uploads its legacy progress once" |
| MIG-003 | auto | `packages/contracts/test/contracts.test.ts` › "maps keys: times-N:world -> N; bare world -> 3 only (MIG-003)"; `packages/student-progress/test/*` › "MIG-003: …"; `apps/admin/test/integration/learning-legacy-import.test.ts` › "MIG-003: historical keys map only to ×3 …" |
| MIG-004 | auto | `apps/admin/test/integration/learning-legacy-import.test.ts` › both "MIG-004: …" tests; `packages/student-progress/test/legacy-import.test.ts` › "MIG-004: stored legacy attempt with the same state → no writes …"; `apps/student/test/legacy.test.ts` › "migration idempotence (MIG-002/004)"; `tests/e2e/student-migration.spec.ts` › "launching twice is idempotent and the backup stays intact" |
| MIG-005 | auto (partial) | `tests/e2e/student-offline.spec.ts` › "all API/network requests aborted: lesson, quiz and progress work", "relaunch with no network serves the last good bundle"; `tests/e2e/student-paired.spec.ts` › "pair, link, import, catalog, progress sync, telemetry, offline queue"; against the real server: `tests/fullstack/01-guardian-tv-flow.spec.ts` (queue drains to 0, no duplicated `event_id`). Offline launch on webOS is **manual/hardware**: `LG_TV_TEST_PLAN.md` step 7 |
| MIG-006 | auto | `apps/admin/test/integration/learning-progress.test.ts` › "MIG-006: stale client revision → stale_ignored …", "SEC-004: revoked device → 401 …"; `packages/student-progress/test/student-progress.test.ts` › "MIG-004 / MIG-006: stale or replayed older state never rolls back …"; `apps/student/test/paired.test.ts` › "refreshes an expired token, and a revoked device …" |

## TV UX, autoplay and audio

| ID | Status | Evidence |
|---|---|---|
| TV-001 | auto (partial) | `tests/e2e/legacy-regression.spec.ts` › "TV-001: remote keys - arrows move focus, Enter selects, Back returns", "TV-003: … pause stops time …"; `tests/e2e/a11y-tv.spec.ts` › "arrow keys move a visible focus ring between targets without a mouse (TV-001, TV-005)". The real LG Back key (461) and Play/Pause remote keys are **manual/hardware** (`LG_TV_TEST_PLAN.md` steps 3–4) |
| TV-002 | auto | `tests/e2e/a11y-tv.spec.ts` › "lesson: controls hide after inactivity and come back on a remote key (TV-002)"; `tests/e2e/legacy-regression.spec.ts` (controls revealed by remote key) |
| TV-003 | auto | `tests/e2e/legacy-regression.spec.ts` › "TV-003: 7-second autoplay in order; pause stops time; slide 10 leads to quiz"; `tests/e2e/student-catalog.spec.ts` (all 60 worlds) |
| TV-004 | auto (partial) | **new** `tests/e2e/tv-audio.spec.ts` › "blocked music (reject) …", "blocked music (throw) leaves the lesson visible and autoplaying (TV-004)", "mute preference persists across relaunch and suppresses play() (TV-004)"; `tests/e2e/student-profiles.spec.ts` (per-explorer music). Real webOS autoplay policy is **manual/hardware**: `LG_TV_TEST_PLAN.md` step 5 |
| TV-005 | auto | **new** `tests/e2e/a11y-tv.spec.ts` (6 tests: ≥64 px targets inside the 1920 frame on every screen, ≥3 px focus ring, reduced motion, 390 px reflow, checker self-test); `tests/e2e/legacy-regression.spec.ts` › "TV-005: primary targets are at least 64px tall at 1080p"; adult portal: **new** `tests/fullstack/02-admin-a11y.spec.ts` |
| TV-006 | manual/hardware | `docs/ops/LG_TV_TEST_PLAN.md`. NOT run (no LG TV in this environment). Chromium E2E is never counted as TV-006 |

## Telemetry, time and assessment

| ID | Status | Evidence |
|---|---|---|
| TEL-001 | auto | `packages/telemetry/test/ingest.test.ts` › "TEL-001: in-batch and already-stored duplicates are acknowledged, not accepted"; `packages/telemetry/test/telemetry.test.ts` › "TEL-001: the same event twice counts once"; `apps/admin/test/integration/learning-telemetry.test.ts` › "TEL-001: same event twice is stored once; replaying the batch … is idempotent"; `apps/admin/test/integration/learning-aggregate.test.ts` › "TEL-008 / TEL-001: …" |
| TEL-002 | auto | `packages/telemetry/test/telemetry.test.ts` › "TEL-002: hidden tab for 120s contributes zero …"; `apps/admin/test/integration/learning-aggregate.test.ts` › "TEL-002: 120 s hidden contributes zero …" |
| TEL-003 | auto | `packages/telemetry/test/telemetry.test.ts` › "TEL-003: survives reload, delivers in order, dedupes, and retries with backoff after failure"; `apps/student/test/queue-outbox.test.ts` (bounded queue) |
| TEL-004 | auto | `packages/telemetry/test/telemetry.test.ts` › "TEL-004: forged learner id rejected", "TEL-004: future timestamp beyond skew rejected"; `apps/admin/test/integration/learning-telemetry.test.ts` › "TEL-004 / SEC-003: …", "TEL-004: oversize body → 413 …" |
| TEL-005 | auto | `apps/admin/test/integration/learning-telemetry.test.ts` › "TEL-005: a client correctness field is never accepted (payload or envelope)"; `packages/db/test/integration/redteam-tenancy.test.ts` › "score_answer: …"; `tests/fullstack/01-guardian-tv-flow.spec.ts` › "server-authoritative assessment with the TV credential" (start response never contains `correct`) |
| TEL-006 | auto | `packages/assessment/test/selection-scoring.test.ts` › "TEL-006: baseline, immediate (repeated) and delayed use different questions of the same outcome"; `packages/lesson-engine/test/lesson-engine.test.ts` › "TEL-006: …"; `apps/admin/test/integration/assessment-db.test.ts` › "baseline → immediate → delayed: different questions (TEL-006) …" |
| TEL-007 | auto | `packages/telemetry/test/telemetry.test.ts` › "TEL-007: activity days use the household time zone"; `packages/intelligence/test/analytics.test.ts` › "dedups days in the household timezone and keeps time separate" |
| TEL-008 | auto | `packages/telemetry/test/telemetry.test.ts` › "TEL-008: out-of-order delivery gives no negative time and no duplicate slide completion"; `apps/admin/test/integration/learning-aggregate.test.ts` › "TEL-008 / TEL-001: …" |

## ELS and dashboard

| ID | Status | Evidence |
|---|---|---|
| ELS-001 | auto | `packages/intelligence/test/els.test.ts` › "ELS-001: …"; `packages/assessment/test/scheduler-els.test.ts` › "ELS-001-shaped flow …" |
| ELS-002 | auto | `packages/intelligence/test/els.test.ts` › "ELS-002: …" |
| ELS-003 | auto | `packages/intelligence/test/els.test.ts` › "ELS-003: …"; `packages/intelligence/test/analytics.test.ts` › "pre = 100 …" |
| ELS-004 | auto | `packages/intelligence/test/els.test.ts` › "ELS-004: …"; `apps/admin/test/analytics/score-plan.test.ts` › "progress without quiz -> insufficient_evidence row …"; `tests/fullstack/01-guardian-tv-flow.spec.ts` (the child who did not play shows no score) |
| ELS-005 | auto | `packages/intelligence/test/els.test.ts` › "ELS-005: …" |
| ELS-006 | auto | `packages/intelligence/test/els.test.ts` › "ELS-006: …"; `packages/intelligence/test/analytics.test.ts` › "ELS is invariant to time inputs (no_time_in_ELS, ELS-006)"; `apps/admin/test/analytics/score-plan.test.ts` › "no_time_in_ELS: …" |
| ELS-007 | auto (partial) | `apps/admin/test/integration/analytics-db.test.ts` › "writes per-lesson and topic snapshots with evidence flags …", "another household's adult cannot read or dismiss; API returns 404"; `apps/admin/test/analytics/page-render.test.ts` › "renders only the caller's children …"; `tests/fullstack/01-guardian-tv-flow.spec.ts` (DB events → job → page). **Gap:** no test re-derives the whole topic table independently from the raw rows and compares every cell |
| ELS-008 | auto | `apps/admin/test/integration/analytics-db.test.ts` › "is idempotent per (learner, lesson, as_of) and deterministic …"; `tests/fullstack/01-guardian-tv-flow.spec.ts` › "nightly jobs run against the same DB and are idempotent" |
| ELS-009 | gap (feature absent) | No content-level correlation view exists in P0–P5, so nothing can claim causality yet. When one is built it needs a test for the "observational / small sample" wording |

## Ops

| ID | Status | Evidence |
|---|---|---|
| OPS-001 | auto (partial) | `scripts/db/test-db.mjs` builds a fresh cluster from migrations 0001–0007 and seeds on every integration/full-stack run; `node tests/fullstack/run.mjs` starts the built app with `.env.example`-shaped variables and dev accounts. **Gap:** no automated check against a local Supabase CLI stack (Supabase CLI not available) |
| OPS-002 | auto (partial) | Migrations up on fresh databases: every `pnpm test:integration` (`BNL_TEST_FRESH_DB_URLS`). Down = forward-only by design (ADR-0005); the verified rollback is `scripts/ops/rehearse-rollback.mjs` (`docs/ops/ROLLBACK.md`) and the restore is `scripts/ops/rehearse-backup-restore.mjs` (`docs/ops/BACKUP_RESTORE.md`). **Gap:** CI preview deploy (owner-gated, requested in `docs/adr/proposals/A9-qa-ops.md`) |
| OPS-003 | auto | `packages/db/test/integration/workflow.test.ts` › "OPS-003: a publish whose manifest cannot be built leaves everything unchanged"; `apps/admin/test/integration/content-workflow.test.ts` › "submit → approve; publishing before approval fails and keeps the manifest (OPS-003)", "OPS-003: a failed pin …" |
| OPS-004 | auto | `apps/admin/test/integration/learning-aggregate.test.ts` › "OPS-004: the CLI runner (bnl_job role) aggregates a date and a rerun yields identical totals"; `tests/fullstack/01-guardian-tv-flow.spec.ts` › "nightly jobs run against the same DB and are idempotent" (`sessions_changed: 0` on rerun, `max_ingest_lag_ms` emitted) |
| OPS-005 | auto (partial) | **new** `packages/db/test/integration/redteam-deletion.test.ts` (6 tests) runs the interim operator procedure `scripts/ops/sql/process-deletion-request.sql`: telemetry-only, learner and household scopes; sibling and other household untouched; replay and cross-household learner refused; audit without names; the request login cannot run it. Retention purge: `apps/admin/test/integration/analytics-db.test.ts` › "retention purge (real DB)". **Gap:** there is no guardian-facing export or delete API/job (`docs/ops/PRIVACY.md` §6) |

## Added by A9 in P6

| File | Tests | What |
|---|---|---|
| `packages/db/test/integration/redteam-tenancy.test.ts` | 38 (1 `it.fails` = A9-SEC-01) | two households × every household table × 12 attackers; forged writes; SECURITY DEFINER calls with foreign ids; role switches |
| `packages/db/test/integration/redteam-schema.test.ts` | 15 | schema-wide RLS/ACL/privilege snapshots |
| `packages/db/test/integration/redteam-deletion.test.ts` | 6 | OPS-005 interim deletion procedure |
| `packages/db/test/integration/redteam-fixtures.ts` | — | shared SYNTHETIC household seed |
| `apps/admin/test/integration/redteam-routes.test.ts` | 8 | HTTP red team: every device route, every adult `[id]` route, forged JWTs, pairing takeover |
| `apps/admin/test/redteam/static-guards.test.ts` | 13 (3 `it.fails` = A9-OPS-01) | no SQL from input, no embedded secrets, flags enforced |
| `tests/fullstack/*` | 16 | guardian → TV → play → telemetry → assessment → jobs → analytics on one origin; admin accessibility |
| `tests/e2e/a11y-tv.spec.ts`, `tests/e2e/tv-audio.spec.ts`, `tests/a11y/checks.ts` | 6 + 3 | TV accessibility, TV-004 audio fallback, dependency-free a11y checker |
| `scripts/ops/rehearse-rollback.mjs`, `scripts/ops/rehearse-backup-restore.mjs`, `scripts/ops/sql/process-deletion-request.sql` | — | rehearsals and the interim deletion procedure |
