# BreakNLearn acceptance tests and fixtures

For every test capture `test_id`, module, command, evidence/screenshot, actual, expected, owner and status. Unrun = NOT VERIFIED. Implement all below as Vitest/Playwright/pgTAP/Supabase DB tests where feasible.

## Identity, privacy and access (BLOCKING)
- **SEC-001** unauthenticated `/admin` and `/api/v1/admin/*` give 401/redirect without leaking data.
- **SEC-002** editor can save drafts but cannot publish; reviewer approves; publisher can publish.
- **SEC-003** household A device reading/writing B learner is denied even if UUID guessed.
- **SEC-004** revoked TV device denied progress/telemetry writes; cached lessons still play locally.
- **SEC-005** all exposed tables have RLS+explicit grants; no broad authenticated read.
- **SEC-006** published catalog excludes all draft/unreviewed lessons and source uploads.
- **SEC-007** restricted private school PDF cannot be opened by another household or unauthenticated URL.
- **SEC-008** server rejects XSS/HTML injection, oversized file, wrong file type, path traversal, excessive requests.
- **SEC-009** login brute force protection and CSRF/Origin protection for cookie session mutations.
- **SEC-010** only guardian/owner can see names and answers for own children; editors get aggregate stats only if explicitly permitted.

## Learning/catalog correctness
- **CAT-001** exact Grade 2 subjects: English, Math, Tamil, Hindi, Science, Aadritha, Music.
- **CAT-002** exact Grade 6 subjects: English, Math, Tamil, Hindi, Physics, Chemistry, Biology, History & Civics, Geography, Western Violin, Carnatic Violin, Aadritha.
- **CAT-003** Grade 2 Math has Tables ×1..×10. Each table has 6 named worlds, 10 facts, 3-question quiz, 7s slide default.
- **CAT-004** property test: for all `factor in 1..10, step in 1..10`, visual count = factor*step, displayed product matches; answers have 1 unique correct value.
- **CAT-005** only ten multiplication lesson references are initially published; others are draft, no Grade 6 live lessons.
- **CAT-006** verified canonical CISCE outcomes require source doc/page and reviewer; editorial seed remains unverified.
- **CAT-007** modifying a published version creates a new immutable version; original attempt stays pinned.
- **CAT-008** publish triggers manifest revision and client ETag refresh; stale clients still use last valid cache if API fails.
- **CAT-009** import PDF/CSV with one-to-many topic mapping produces review candidates; no published rows before review.
- **CAT-010** import duplicate file checksum does not create duplicate chapter mapping or publish content.

## Profiles/migration/offline
- **MIG-001** two profiles retain names, grades, avatars after refresh/relaunch; two profiles never share progress unless explicit data migration.
- **MIG-002** preserve `breaknlearn.profiles.v1` example (two profiles, ×1 and ×3 progress and different worlds) accurately.
- **MIG-003** `learnbreak-x3-v4-progress` and `breaknlearn.progress.v1` legacy entries map only to ×3 when table absent.
- **MIG-004** importing same profile snapshot twice has no new duplicates or overwritten newer completion.
- **MIG-005** no network: cached lesson works, quiz works, progress queues; after network returns, no duplicated events.
- **MIG-006** interrupted sync, stale client revision and revoked device produce safe conflict/failure states.

## TV UX, autoplay and audio
- **TV-001** arrow keys move spatially, Enter selects, Back leaves lesson, Play/Pause toggles; no mouse required.
- **TV-002** controls hidden after inactivity and revealed by key input, remaining keyboard reachable.
- **TV-003** lesson 1..10 auto-advances in original order with 7s slide setting; pause does not increment time.
- **TV-004** music gesture fallback and mute preference preserved; failure does not hide lesson.
- **TV-005** focus indicators, 64px target sizing, 16:9 safe margins, mobile responsive, reduced motion.
- **TV-006** physical LG webOS browser test: tested model/version/remote, audio, caching, Back and performance logged; NEVER mark automatic Chromium E2E as equivalent.

## Telemetry, time and assessment
- **TEL-001** same `event_id` twice → once in store and once in aggregate; replay same batch idempotent.
- **TEL-002** unseen tab for 120s → zero active time; playback vs estimated foreground clearly separated.
- **TEL-003** 5m offline buffer and reload → correctly sequenced delivery, finite retries, bounded storage.
- **TEL-004** forged learner ID, future timestamp beyond allowed skew, payload over limit → rejected with code.
- **TEL-005** quiz correctness computed by server; client cannot submit is_correct override.
- **TEL-006** baseline/immediate/delayed use different question IDs by default, link to same learning outcome.
- **TEL-007** session-day visit counts respect timezone; no double count on background/foreground flapping.
- **TEL-008** out-of-order events do not yield negative time, duplicate slide completion or inflated score.

## ELS and dashboard
- **ELS-001** pre=40 post=90 delayed=80 completion=100 → improvement=83.333..., ELS=86.666... rounds to 86.67.
- **ELS-002** no baseline and no delayed, post=80 completion=100 → provisional 84, coverage 50%.
- **ELS-003** pre=100 post=100 excludes improvement from weights, not divided by zero.
- **ELS-004** missing immediate quiz → `insufficient_evidence` if no mastery; score nullable, never manufactured.
- **ELS-005** fewer than 5 distinct valid questions → `low_confidence`/provisional even if quiz=100%.
- **ELS-006** 40 minutes of passive autoplay with no answers does NOT raise ELS.
- **ELS-007** analytics topic table equals raw event/assessment aggregation for fixture, honors profile/household boundaries.
- **ELS-008** score version changes do not mutate historical stored snapshots; re-run produces new as-of/version.
- **ELS-009** content-level correlations shown as observational with small-sample warning; no causality claims.

## Ops
- **OPS-001** fresh dev install with `.env.example` and local Supabase starts apps, seeds and mocked accounts.
- **OPS-002** migration up/down or verified rollback + DB restore; CI test and deploy preview.
- **OPS-003** failed publish transaction leaves prior manifest intact.
- **OPS-004** daily aggregate job rerun is idempotent, emits lag/error metrics.
- **OPS-005** child data export/delete scoped to household and audited; test deletion of raw telemetry and derived caches.
