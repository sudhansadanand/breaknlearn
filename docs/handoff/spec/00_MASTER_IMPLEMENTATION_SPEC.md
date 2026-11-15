# BreakNLearn — CMS, Curriculum, Telemetry & Learning Intelligence
## Agent-executable engineering specification | v1.0 | 2026-11-14

**Status:** APPROVED TARGET DESIGN / IMPLEMENTATION HANDOFF; NOT A CLAIM OF DEPLOYED FEATURES.
**Primary objective:** Produce tested, secure, maintainable source code for the complete BreakNLearn content-management system, CISCE Curriculum Explorer, school-syllabus mapping, learning telemetry, assessments, learning-intelligence engine, parent/admin analytics, and the integrations needed in the existing student app.
**Primary audience:** Lead AI coding agent and parallel specialist coding agents.
**Source-of-truth order:** (1) security/privacy invariants and acceptance tests in this pack; (2) signed-off module contracts; (3) existing working BreakNLearn behavior; (4) visual spec v1.0; (5) current curriculum-prototype seed. When contradictions arise, document an ADR and choose the safest backwards-compatible solution, not a silent rewrite.

## 0. Hard constraints and existing system baseline

- Preserve the live student experience at **https://breaknlearn.vercel.app**, or maintain a functioning rollback until cutover. Existing Vercel project ID `prj_JtDSfO23dh2PuyOBkLFFIfvaXIUb`; do **not** recreate or delete it. Do not rename its URL or break old bookmarks.
- Existing student experience: two locally persisted profiles; child-entered name, grade (2 or 6), avatar; grade-specific subject tiles; Grade 2 Math → Multiplication Tables → ×1–×10; six picture worlds (Puppy Park, Candy Land, Unicorn Sky, School Box, Treat Time, Animal Farm), ten facts per table, default seven seconds per slide, three-question multiple-choice quiz, background music, TV-remote navigation, per-profile progress. All other Grade 2/6 subject tiles remain stubs until independently approved and published.
- Current browser localStorage root: `breaknlearn.profiles.v1`. Historical progress keys: `breaknlearn.progress.v1` and `learnbreak-x3-v4-progress`. Preserve and migrate, never clear or silently reset.
- Existing UI brand: BreakNLearn; tagline **Little breaks. Big discoveries.** Brand colors #5422A5, #31BFF2, #FFCC32, #A8DF68, #FFF8EB, #17132B; mascot logo; LG webOS browser/remote first. UI reference: `reference/BreakNLearn_UI_UX_Design_Specification_v1.0.pdf`.
- Prior standalone curriculum prototype and topic outline are **not production database or authenticated CMS**. `reference/curriculum_seed_prototype.json` contains an 80-topic editorial outline and 10 multiplication lesson references. The topic labels are preliminary editorial mappings, NOT independently audited verbatim CISCE standards; do not present them as authoritative learning outcomes until reviewed against the primary documents.
- Never insert a child account/password screen; administrator/guardian authentication may be required on a separate route; profile selector stays simple.
- Preserve multiplication curriculum content and ordering; newly imported Grade 2/6 topics must default to **draft/unpublished**, with precisely the existing Grade 2 multiplication tables ×1–×10 live. No empty Grade 6 lesson exposed as playable content.
- A Vercel URL such as `admin.breaknlearn.vercel.app` is NOT guaranteed to be assignable. Implement secure `/admin` on current origin first, or a distinct `breaknlearn-admin.vercel.app` project after availability verification. A future owned custom domain may provide `admin.breaknlearn.com`.
- All PII, progress and telemetry belong to a protected household tenant; no public exposure, cross-household joins, child-targeted ads, session replay, unrestricted data exports or client-side embedded admin passwords.

## 1. Scope, deliverables, definition of done

**IN:** reproducible monorepo; secure Supabase Postgres schema/migrations/RLS; authenticated guardian/admin portal; authoring CMS; curriculum import and versioning; school PDF/CSV TOC parser with human review; lesson versioning/publishing; read-only published-content API; media handling; student-app adapter; device pairing and two profiles; local offline cache and event queue; event ingestion/deduplication; pre/post/delayed quizzes; analytics aggregates; provisional Effective Learning Score (ELS) with evidence and confidence; transparent recommendation rules; automated tests; CI; operational docs; backups; migration/rollback.

**OUT initially:** automatic autonomous publishing; claims of causal learning impact; image/audio content scraping without rights; school LMS integrations; payments; social/leaderboards; public multi-family registration without explicit privacy review; surveillance or recording of children; video/audio recording of users; remote access to a household's child data by unrelated admins.

**Deliverables from coding agents:** working source code, migrations and seeds, OpenAPI contracts, test suites, CI workflows, environment templates, local setup scripts, mock/synthetic data, screenshots/demo walkthrough, signed security-test results, deployment and rollback runbooks, and concise residual-risk report. Never report a module complete just because it renders: functional, security, migration, accessibility and integration tests must pass.

**Global DoD:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build` pass; local Supabase migration + RLS denial tests pass; browser E2E admin/student pass; a real LG TV manual verification checklist is supplied (cannot be inferred from headless Chromium). Automated/CI results logged and evidenced. At least one dry-run migration using legacy profile fixtures; rollback proven. Production cutover requires owner approval and production secrets supplied securely.

## 2. Recommended implementation and repository layout

**Stack:** TypeScript monorepo (`pnpm` workspaces, Turborepo optional); Next.js App Router for protected admin and API/BFF, TypeScript + React for student UI (incrementally wrap existing HTML/JS instead of overwriting it), PostgreSQL with Supabase, Supabase Auth for adult admins, Supabase Storage for media/source documents, Postgres scheduled jobs or a controlled cron for aggregations and delayed review generation. Type-safe shared packages and runtime validation with Zod. Playwright E2E; Vitest unit; pgTAP/SQL RLS security tests; OpenAPI 3.1. Keep dependencies modest for LG webOS; student client should compile to a lightweight bundle, ES syntax supported by target TV engine, with polyfills only when required.

```text
breaknlearn/
  apps/
    student/                 # existing Vercel domain; React shell/adapters; TV-focused UI
    admin/                   # protected /admin or independent verified URL
  packages/
    contracts/               # Zod schemas, OpenAPI and typed SDK, event contract
    curriculum/              # CISCE normalizer, source provenance and mapping logic
    lesson-engine/           # template-based ×1–×10; visual slides and answer logic
    telemetry/               # event capture, buffering, ingestion validation
    intelligence/            # ELS, evidence sufficiency, recommendations
    ui/                      # shared branded UI primitives
  supabase/
    migrations/              # ALL SQL changes; no manual-only SQL setup
    seed/                    # grade, subject, reviewed curriculum/lesson seed
    tests/                   # RLS and migration tests
  scripts/                   # seed, local import, migrations, backfill, checks
  tests/e2e/                 # TV-keyboard, roles, publishing, offline, analytics
  docs/                     # ADRs, runbook, user/editor documentation
  .github/workflows/         # checks; preview-only auto deployment
```

**Deployment topology:**
1. `breaknlearn.vercel.app` → existing student Vercel project, public app; parent device pairing and restricted read APIs; no admin secrets in bundle.
2. `breaknlearn.vercel.app/admin` → authenticated route on same or separately routed Vercel application; choose implementation based on existing project constraints. All admin routes + APIs enforce verified identity and role SERVER-SIDE. A separate admin project is acceptable if routing and domain remain coherent.
3. Supabase project (DEV, STAGE, PROD isolated) → Postgres, Auth, Storage, RLS; schema migrations in git. Private buckets for school files; signed media URLs when private. Published non-sensitive educational assets may be public with explicit audit.
4. Serverless API/BFF → validate student household device capability tokens and admin sessions; privileged service key server-only, not in edge/client builds.
5. Background jobs → aggregate metrics, schedule spaced recall and update scores with idempotent checkpoints; use existing platform scheduler if supported, no running loops on serverless workers.
6. Git repository/CI → each PR runs checks; deployments gated; production changes reversible.

**Environment variables** (names illustrative, document precisely): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY` (server-only), `SUPABASE_DB_URL` (migration only), `APP_ORIGIN`, `ADMIN_ORIGIN`, `DEVICE_TOKEN_SIGNING_SECRET` (server-only or asymmetric private key), `IMPORT_MAX_MB`, `TELEMETRY_BATCH_MAX`, `RETENTION_DAYS`; no secrets committed, use `.env.example` placeholders.

## 3. Core system flows

### 3.1 Content-to-student
Admin sign-in → curriculum explorer → draft lesson/editor or school mapping → preview → validation → human review/approval → immutable `lesson_version` artifact → atomic publish transaction → published manifest version bump / ETag → student fetch+cache → grade/profile gated navigation → present lesson → quiz → completion.

### 3.2 Evidence feedback loop
Device paired to household → child selects profile → lesson session created → slide exposure events and periodic active/visible heartbeats → quiz attempted (option chosen, correctness computed server-side) → offline event queue flush → deduped ingest → session and assessment tables → nightly aggregations → ELS with evidence flag → guardian/admin analytics → review recommendations → curriculum editor receives anonymized topic-level quality signals → editor revises lesson version → future students see new approved version; completed old sessions remain pinned to original version.

### 3.3 School-specific topic mapping
Guardian/admin uploads school syllabus/TOC PDF/DOCX/CSV → file stored privately, virus/type/size checks → extraction/OCR only if necessary → staged chapter records with page locator and confidence → deterministic suggestions against canonical grade/subject/topic IDs → human accept/reject/override → immutable approved mapping rows per school/academic year/book edition → optional child's active school plan → student sees school order of published lessons; unmapped/unpublished topics remain stubs. Never copy entire copyrighted textbook content into a lesson without rights.

## 4. Module contracts (all independently implemented modules MUST use these IDs)

Each module's details include ownership, runtime location, inputs, outputs, dependencies, failure handling and operations. Data shapes defined in `contracts/contracts.openapi.yaml` and `contracts/telemetry.schema.json`. Module owners publish contract types before parallel implementation.

### M01 Identity, households, profiles & device pairing
**Purpose:** Distinguish administrator/guardian and two children, securely associate anonymous TV selections with correct household. **Location:** `apps/admin/auth`, `apps/student/profile`, API `/api/v1/devices/*`, tables `households`, `memberships`, `learner_profiles`, `devices`, `device_sessions`.
**Inputs:** authenticated guardian JWT; invite/pair code; local profile name/grade/avatar/legacy data; device signed request. **Outputs:** household ID, learner UUID, device-scoped short-lived credential, profile list, migration receipt. **Interaction:** every telemetry/progress request must resolve household and learner via verified device session, never trust submitted arbitrary learner ID; lesson gateway filters by grade. **Implementation:** adult provisions one household; pairing code TTL 10 min and one-time use; TV displays code; guardian approves using admin; rotate/revoke device tokens; two active child profiles initially; store first name/display name only; redact in logs. Retain local-only mode if never paired, explicitly label telemetry unsynced. **Maintain:** token rotation, membership revocation, recover pairing, privacy deletion; audit changes. **Failure:** offline student remains functional using local profile/cache; queued data syncs after valid pairing.

### M02 Curriculum Explorer & official provenance
**Purpose:** Search/filter grade-wise curriculum topics with standards/outcomes. **Location:** `packages/curriculum`, `apps/admin/curriculum`, tables `curriculum_frameworks`, `curriculum_nodes`, `learning_outcomes`, `source_documents`.
**Inputs:** official CISCE Primary/Upper Primary PDFs, source date/version, editorial JSON prototype, reviewer corrections. **Outputs:** stable curriculum IDs, hierarchical grade→subject→strand→topic→outcome records, mapping eligibility, search results. **Interaction:** M03 maps chapters to topic IDs; M04 attaches lessons/outcomes; M10 reports by topic. **Implementation:** seed 80 prototype topics with `authority='editorial_unverified'`, `publication_state='draft'`, provenance `proposed_from_cisce`; separate reviewed verified outcomes from editorial wording. Official PDFs must be revisited by editor and cited by page/section; preserve order from source when verified. Grade 2 subject list and Grade 6 subject list preserve existing app, including enrichment subjects tagged `local_enrichment` rather than falsely `CISCE`. **Maintain:** source revision records, human verification status, immutable source metadata, review workflow; yearly school-plan imports do not mutate CISCE nodes. **Failure:** unverifiable topic stays draft and unpublishable until reviewed.

### M03 School syllabus ingestion & mapping
**Purpose:** Reconcile each school's textbook chapter ordering with M02 canonical topics. **Location:** `apps/admin/imports`, `packages/curriculum/mapping`, server extraction worker, private Storage `school-syllabi/`; tables `school_plans`, `syllabus_uploads`, `chapters`, `topic_mappings`, `import_jobs`.
**Inputs:** PDF/DOCX/CSV or manually pasted TOC; grade, subject, academic year, book edition, school label; reviewer corrections. **Outputs:** staged extraction preview, chapter candidates, confidence/provenance, approved topic mappings and exceptions. **Interaction:** pulls M02 nodes, supplies school-specific sequence to M05 catalog; passes review needs to admin. **Implementation:** max 20 MB initially, MIME+magic verification, malicious upload scan, PDF text extraction first; OCR only where text extraction fails, queue as separate explicit task; no arbitrary external fetch. CSV schema `chapter_no,title,page_start,grade,subject`; preserve page numbers and original source. Mappings are suggestions until approved; many-to-many allowed; confidence thresholds configurable; every mapping includes editor ID/time. **Maintain:** reimport diff by checksum/version, retain previous approved map, explicit archival, storage retention. **Failure:** malformed import yields row-level error report, no partial publish.

### M04 Lesson authoring, templates & media
**Purpose:** Create content with a reusable lesson engine and explicit learning outcomes. **Location:** `apps/admin/lessons`, `packages/lesson-engine`, Storage `lesson-assets`, tables `lessons`, `lesson_versions`, `lesson_slides`, `quiz_items`, `media_assets`, `outcome_links`.
**Inputs:** grade/topic/outcome IDs; title, author, ordered slides; template settings; licensed images/audio/video; objective quiz questions; draft status. **Outputs:** validated version snapshot, rendering JSON, preview link, media manifest, checksum. **Interaction:** M05 publishes versions, M06 renders content, M08 assesses quiz answers and retains question provenance. **Implementation:** templates `picture_groups_v1` (factor 1..10, multiplier step 1..10, each repeated icon), `slides_v1`, `video_v1`, `audio_v1`, `story_v1`, `quiz_v1`. Keep exactly six ×1–×10 picture worlds, 7s slides, three MCQ. Each variation should be a configurable rendering template, not 60 duplicated educational texts. Quiz options generated deterministically per session seed; avoid duplicate/equivalent answers; enough distractors. Rich text sanitized, links allowlisted, assets sized/transcoded, captions/alt text required. **Maintain:** duplicate/edit/version/restore, content lint, accessible previews, attribution/rights fields. **Failure:** an invalid draft is saveable but not publishable; preview provides errors.

### M05 Publishing & read-only catalog
**Purpose:** Gate exposure of approved content. **Location:** `apps/admin/publishing`, API `/api/v1/catalog/*`, tables `publication_records`, `published_manifests`, `content_audit`.
**Inputs:** approved immutable lesson version, reviewer role, grade/audience, start/end optional, audit reason. **Outputs:** atomic publication row, semver/manifest revision, ETag, published lesson JSON, cache invalidation marker. **Interaction:** M04 drafts → M05; M06 reads M05 only; M10 queries published outcomes. **Implementation:** state machine `draft → in_review → approved → published → archived`, explicit authorized publish action in server transaction; immutable lesson version; never allow a draft subject stub to appear as playable. Seed only Grade 2 Math tables 1..10 as approved+published and all remaining as draft; legacy seed details mapped to IDs. Support safe rollback and a pinned previous manifest. **Maintain:** editorial audit log, review checklist, schedule rollback drill monthly. **Failure:** atomic rollback if manifest publish fails; clients continue cached previous version.

### M06 Student app runtime, TV UI & offline cache
**Purpose:** Child-friendly consuming app and local-first resilience. **Location:** `apps/student`, deployed under existing `breaknlearn.vercel.app` project/domain. **Inputs:** two child profiles; authenticated or local-only device; published catalog; manifest ETag; saved progress; remote key events; audio prefs. **Outputs:** rendered subjects, worlds, slides, quiz choices, progress actions/telemetry. **Interaction:** M01 profiles, M05 catalog, M07 telemetry, M08 quizzes, M09 progress. **Implementation:** preserve mascot, logo/palette, 64px targets, directional spatial navigation, Enter/Back/Play-Pause, reduced-motion; presentation controls hidden unless interacted; fallback when sound autoplay blocked; cache latest N published lessons in IndexedDB (with localStorage fallback); queue telemetry while offline; no auth blocking local playback. Implement backward compatibility adapter for `breaknlearn.profiles.v1` and historical keys, with per-profile user confirmation at pairing if ambiguous, no overwrite. **Maintain:** browser compatibility matrix, asset budgets, LG TV tests, cache migration/eviction/versioning. **Failure:** network errors show cached content; no white screen; error boundary/retry.

### M07 Telemetry capture, ingestion & lifecycle
**Purpose:** Collect privacy-minimized, de-duplicable evidence. **Location:** `packages/telemetry`, `/api/v1/telemetry/batch`, `learning_events`, `learning_sessions`, scheduled reducer; no third-party analytics SDK for child data. **Inputs:** event envelope V1, session ID, lesson-version ID, monotonic delta, device-signed token; session heartbeat. **Outputs:** per-event accepted/duplicate/rejected IDs, normalized DB rows and aggregate job triggers. **Interaction:** M06 emits; M08 emits assessment; M09 reducer consumes; M10 analytics. **Implementation:** buffer 25 events or 30 sec (foreground); flush on page visibility/pagehide if supported; durable IndexedDB queue; retry exponential backoff with jitter; cap queue size; deterministic UUID idempotency key; server validates scope/schema, max batch 100, max 128KB, timestamps skew and impossible durations; never accept user-submitted correctness as authoritative; allow up to 72h offline arrival with original times. Session time counts foreground/visible playback as *estimated exposure*, not verified attention; clamp intervals to max 30s since last heartbeat, never count hidden tabs, paused or unobserved time as active. **Maintain:** schema version, retention, partitioning, data-quality dashboard, dead-letter review, replay idempotently. **Failure:** locally queue, return partial acknowledgements, no lost lessons, no duplicate counts.

### M08 Assessments, answer validation & retention scheduling
**Purpose:** Evaluate learning beyond autoplay exposure. **Location:** `packages/lesson-engine/assessment`, `/api/v1/assessments/*`, tables `assessment_attempts`, `question_responses`, `review_schedule`, `item_bank`.
**Inputs:** published quiz/lesson version, learner, stage `baseline|immediate|delayed`, answer choices, time budget, item IDs and item bank tags. **Outputs:** scored responses, first-attempt correct, per-outcome score, assessment quality metadata, next recommended delayed review date. **Interaction:** M04 questions, M06 UI, M07 events, M09 evidence engine. **Implementation:** minimum 3–5 baseline items, 3–5 immediate items, 3–5 fresh delayed items at +3–7 days where available; do NOT re-use exact questions across stages by default; randomization uses deterministic seed and version. Keep existing 3-question post-lesson quiz as working behavior; baseline/delayed can be opt-in gentle steps before evidence score is complete. Scores based on server-side answer key, log `question_version_id` and `attempt_stage`; control exposure leakage, provide non-punitive feedback. **Maintain:** question item difficulty, coverage, correctness review, retirement and versioning. **Failure:** when no suitable quiz items are available, present `insufficient_evidence` and do not fabricate mastery/retention.

### M09 Progress sync & learner state
**Purpose:** Persist accurate resume/completion across device restarts, with eventual sync to household. **Location:** `packages/student-progress`, `/api/v1/progress/*`, tables `learner_progress`, `progress_conflicts`. **Inputs:** local snapshot, device timestamps and sequence, lesson version, slide stable ID, completion evidence, authenticated device. **Outputs:** canonical per-learner resume state, conflicts and sync cursors. **Interaction:** M01 identity, M06 local, M05 lesson version, M07 telemetry, M10 reporting. **Implementation:** adopt client revision and server revision, monotonic completion within same lesson version, reset only with explicit restart action/new attempt; use `(profile, lesson, attempt)` identity; reconcile offline updates by server-side version/sequence, not blind last-write-wins based on untrusted clocks. Upon legacy migration preserve all local source JSON in a quarantined client backup until verified sync; `legacy-import` is idempotent. **Maintain:** conflict inspection, schema migration tests. **Failure:** indicate unsynced but continue learning offline.

### M10 Learning effectiveness engine (ELS) & recommendations
**Purpose:** Compute transparent evidence-based scores per child/topic/subject and suggest reviews without maximizing screen time. **Location:** `packages/intelligence`, scheduled server job, tables `mastery_snapshots`, `metric_definitions`, `recommendations`, `score_runs`. **Inputs:** valid baseline/immediate/delayed assessments, completed slides, topic weights, age-appropriate outcome mapping, quality flags, scoring config version. **Outputs:** provisional/mastery ELS score 0–100, subcomponents M/R/I/C, confidence/evidence count, as-of date, recommended next action and reason code. **Interaction:** M07/M08/M09/M02 → M10; M11 dashboard; M04 editor content-quality signal. **Implementation:** proposed full score `0.40*M + 0.30*R + 0.20*I + 0.10*C`, each 0–100. Improvement `I=100*max(0,(post-pre)/(100-pre))`, clamped 0..100; if pre=100, improvement not applicable (exclude and renormalize remaining weights), not automatically 100. If `R`/`pre` missing, calculate *provisional* score only from observed components, renormalize known weights and label coverage of maximum possible weight; do not conflate lower evidence with lower performance. M = immediate quiz aggregate with optional question calibration after sufficient data; R = delayed quiz aggregate; C = genuinely completed slides / slides assigned. Data sufficiency threshold initially at least 5 distinct questions for stable topic mastery; existing 3-question quiz yields `low_confidence`. No causal efficacy claims from observation. Recommendation rules: retention low → spaced recall; mastery low → prerequisite visual practice; high accuracy/coverage → next topic. **Maintain:** scoring formulas are versioned, backtests with synthetic fixtures, fairness review, admin explanation view; no automated adaptive loops that pressure children into more screen time.

### M11 Admin analytics & content-quality dashboard
**Purpose:** Show learning history for two children and diagnostic lesson performance with meaningful uncertainty. **Location:** `apps/admin/analytics`, `/api/v1/admin/analytics/*`, optimized materialized views. **Inputs:** verified admin role, date range, grade/profile/topic/lesson/version filters; M09/M10 aggregates, telemetry quality stats. **Outputs:** profile overview, topic heatmap, session trend, active days, time by subject, baseline-vs-immediate-vs-delayed charts, ELS decomposition, difficulty flags, content review queue; CSV export of guardian-owned records. **Interaction:** M01 access, M07-10 metrics, M04 editorial feedback. **Implementation:** segregate `playback_ms`, `foreground_estimated_ms`, `interaction_count`; deduplicate days in household TZ `Asia/Kolkata` by default, stored UTC; do not infer that time means attention. Flag low samples (n < 5 for child concept mastery, and small cohort for any global insight). Guardians see only own children; CMS editors only aggregated/redacted content metrics unless explicit approved need; no cross-household child-level view. **Maintain:** metric dictionary/version, query explain plans, report validations, export access audits.

### M12 Admin RBAC, workflow, audit & operations
**Purpose:** Ensure only adults can edit/publish or read child analytics; keep accountable change history. **Location:** `apps/admin/auth`, middleware/BFF, DB RLS/grants, `audit_logs`. **Inputs:** Supabase adult JWT, DB membership and role, requests to content/publish/export/import, session/mfa if configured. **Outputs:** allow/deny + audit event, authenticated admin UI. **Interaction:** all privileged modules. **Implementation:** roles `owner`, `guardian`, `editor`, `reviewer`, `analyst`, `system`; `owner` can administer household; `guardian` views household analytics/consents; `editor` drafts; `reviewer` approves; publishing requires `owner` or explicit `publisher` capability, never mere editor. Enforce role check in server handlers AND RLS/grants; cookie-based sessions protected against CSRF, rate-limit login/import/publish, anti-brute force controls, restrictive Content Security Policy. No unauthenticated admin route even if frontend hidden. **Maintain:** secret rotation and backup restoration, role recertification, audit retention; logs exclude child names/answers/raw auth tokens. **Failure:** fail closed for privileged routes; student cached lessons continue.

### M13 Jobs, observability, privacy, backup & CI
**Purpose:** Make platform operable after an AI-agent build. **Location:** `scripts/`, `supabase/`, `.github/workflows`, monitoring dashboard, ops docs. **Inputs:** scheduled events, DB changes, deploy triggers, error reports. **Outputs:** durable jobs, backups, alerts, deploy artifacts, operation checklists. **Interaction:** M01-M12. **Implementation:** idempotent nightly aggregation by UTC date plus household timezone, retention scheduler, retry/dead-letter, storage usage thresholds, DB backup and point-in-time recovery strategy dependent on plan; restore rehearsal; production metrics exclude child personal data; alert if event acceptance falls, processing lag or RLS tests fail. Separate dev/stage/prod env; block prod deploy if security or migration tests fail. **Maintain:** on-call playbook, quarterly restore and annual data-retention review, cost budgets, dependency vulnerability scans. **Failure:** degrade to known good published content; alerts and transparent data-delay indicators.

## 5. Canonical database contract

Refer to `db/001_schema_blueprint.sql` for executable starting migrations and policy TODOs, and to the API contract for interface shapes. UUID primary keys, UTC `timestamptz`, `created_at`,`updated_at`, explicit `household_id` for child/private rows. Do NOT create `public` tables with overly permissive grants; ensure every exposed table has explicit grants + RLS tests. Recommended entities:

- **Access** `households`, `household_memberships`, `learner_profiles`, `paired_devices`, `device_tokens`, `consent_records`.
- **Content** `curriculum_frameworks`, `curriculum_nodes`, `learning_outcomes`, `source_documents`, `school_plans`, `syllabus_uploads`, `syllabus_chapters`, `chapter_topic_mappings`, `lessons`, `lesson_versions`, `lesson_slides`, `quiz_items`, `media_assets`, `publication_records`, `published_manifests`, `lesson_outcomes`.
- **Learning** `learning_sessions`, `learning_events`, `learner_progress`, `assessment_attempts`, `question_responses`, `review_schedule`, `mastery_snapshots`, `recommendations`, `aggregation_runs`.
- **Admin/ops** `audit_logs`, `import_jobs`, `job_runs`, `data_deletion_requests`.

Indexes: `(household_id, learner_id, started_at desc)`, `(learner_id, lesson_id, updated_at desc)`, `(learner_id, topic_id, score_date desc)`, unique `event_id`, `(lesson_id, version_number)`, `(published_manifest_revision)`, `(framework_id, source_ref)`, `(school_plan_id, chapter_sort)`. Event partitions by month if growth justifies; start with indexes and retention policy rather than premature complexity.

## 6. API rules

- Root `/api/v1`; OpenAPI in `contracts/contracts.openapi.yaml`. Use JSON over HTTPS; request/response validated via Zod; all failures have `{error:{code,message,details?,request_id}}` and never leak PII.
- Access classes: `PUBLIC_PUBLISHED` only non-sensitive approved content; `PAIRED_DEVICE` scoped to household and learner; `ADULT_GUARDIAN` scoped own household; `EDITOR`, `REVIEWER`, `PUBLISHER` scoped authorized content; `SYSTEM_JOB` server-only.
- Idempotency-Key required on progress import, telemetry batch (plus per-event unique ID), publishing action and syllabus import. Rate limits by device/actor/IP; all mutation APIs audit as appropriate.
- Student published manifest should be cacheable with ETag; do not cache private profile/analytics responses in a public CDN.
- Pagination via `cursor` and bounded `limit <=100`, server UTC timestamps, stable IDs never display-name derived.

## 7. Telemetry semantics and data validity

**Events:** `app_opened`, `profile_selected`, `session_started`, `lesson_started`, `slide_entered`, `slide_exited`, `playback_paused`, `playback_resumed`, `playback_heartbeat`, `quiz_started`, `answer_submitted`, `quiz_completed`, `lesson_completed`, `session_ended`, `app_hidden`, `sync_failed`, `sync_succeeded`.

**Required envelope:** `event_id`, `schema_version`, `event_type`, `occurred_at`, `client_session_id`, `client_sequence`, `learner_id`, `device_id`, `lesson_id?`, `lesson_version_id?`, `slide_id?`, `payload`, `sent_at`. Server derives `household_id`, checks credential and ownership, stores `received_at` and ingest quality flags. No child names or arbitrary text in telemetry payload; answer value IDs only.

**Active time definition:** Sum of visible, unpaused, bounded heartbeat intervals; cap each contribution at 30 seconds; no hidden-tab or background time. Show as **estimated active playback**. App visit = from session start to last valid observed activity, capped across inactivity. Return frequency = distinct activity days and days since last visit; do not score habit or penalize missed days. Test crash/duplicate/offline/fast-forward scenarios.

**Quiz evidence:** Immediate correctness is not causal improvement; record baseline before exposure and delayed follow-up with different questions. Match item difficulty; compare within-topic and only with adequate evidence. Clinical or psychological inference out of scope.

## 8. Learning-score calculation and defensible interpretation

All outputs must include `{score, status:'provisional'|'evidence_sufficient'|'insufficient_evidence', components, weights_version, questions_count, confidence_note, computed_at, limitation}`; distinguish not assessed from scored zero. `completion` is number of verified completed slides divided by available slides, not mere opening. ELS does not include visit frequency or time spent, avoiding a counterproductive screen-time objective. Dashboard displays metrics alongside ELS rather than collapsing learning into a single number. Recommendations must provide reason codes and be reversible by guardian/admin.

**Examples (illustrative; not student data):**
- pre 40, post 90, delayed 80, completion 100 → improvement 83.33, ELS 86.67 (after weighting); assess confidence from sample count.
- pre missing, post 80, delayed missing, completion 100 → provisional based on M and C only, score `(0.4*80+0.1*100)/0.5=84`, coverage 50%; NOT equivalent to a high-confidence 84.
- pre 100, post 100 → improvement not applicable; renormalize known relevant weights.

## 9. Security/privacy controls and legal readiness

- Children should be identified by random UUIDs, nicknames/avatars, not school admission numbers; no birthdates unless essential; child profile data encrypted in transit and protected by tenant authorization at rest.
- No third-party trackers, ads or monetization signals on children; no audio/video capture; no public profiles, leaderboards or social posting.
- Guardian consent/notice, data export and deletion; consent version and revocation effects; short retention for raw event rows with configurable aggregation retention. Suggested initial policy **raw telemetry 90 days, analytics aggregates 13 months**, subject to jurisdiction, guardian consent, legal review and product requirements; document actual configured policy.
- Restrict source textbooks and uploaded school documents to private Storage; do not expose uploader filenames or extract copyrighted chapters for general public distribution. Automations/AI extraction must not transmit student identifiers to third-party model providers absent explicit authorization.
- Default-deny RLS and grants for every table, authorization integration tests: forged learner IDs, cross-household reading/writing, revoked devices, forged grade, draft content access, old token, replay batch, oversized upload, XSS in slides, incorrect owner roles, signed URL expiry.
- Verify current Indian child privacy/consent requirements with legal counsel before a public multi-household launch; do not claim this implementation alone establishes legal compliance.

## 10. Existing-data migration, fallback and rollback

1. Snapshot currently deployed student code/asset manifest, record URL, test two-profile fixture locally; export/store legacy key samples. Do NOT modify production early.
2. Stand up new schema in staging; create one household with two learner UUIDs, preserve nicknames/grade/avatar and choose correct profile mapping. `migration_alias` links legacy `(device_id, local_profile_id)` to learner UUID.
3. Convert historical progress for grade2 math ×1..×10 by table/world; where original record lacks `table`, only map to ×3. Preserve every completion and last slide validly; never fabricate sessions, quiz scores or telemetry before instrumentation.
4. Save each migration operation keyed by `migration_run_id` + legacy fingerprint; repeat imports must be no-op. Produce per-profile summary and quarantined backup on client for verified window.
5. Run student app in read-only content compatibility mode with backend API feature flags; expose backend features gradually to paired devices. Offline students retain core lessons on failure.
6. Cutover only when acceptance matrix passes, admin login and RLS locked, production secrets verified, and owner authorizes production action. Keep prior Vercel deployment available for rollback.
7. If backend unavailable, student local app must remain operable; show sync pending, not loss. Rollback should not delete new-schema events.

## 11. Quality gates and acceptance examples

See `testing/ACCEPTANCE_MATRIX.md` for all scenarios and `agents/AGENTS.md` for orchestration, but release MUST demonstrate:
1. Two distinct child profiles persist on same device; no profile data ever crosses households; TV navigation works without mouse.
2. Grade 2/Grade 6 subject matrices exact; only Grade 2 Math ×1..×10 published, all other topics drafts/stubs. Newly created draft or uploaded school plan never leaks into public catalog.
3. 10 tables × 6 visual worlds × 10 slides with correct multiplication products, no wrong MCQ answer keys, 7-second autoplay and effective pause/resume.
4. Admin password-authenticated, login rejection, server-side role checks, XSS/CSRF hardening, cross-tenant RLS denial tests, signed media access.
5. Editor can make and preview draft; reviewer approves; publisher publishes; student sees new manifest without deploy; unpublish rollback works.
6. Syllabus PDF/CSV import → review → one-to-many approved chapter-topic mapping; invalid input rejected and no accidental publish.
7. Telemetry includes deduped page and quiz events; offline queue survives reload; active time excludes hidden/background; batch duplication not double-counted.
8. Baseline/post/delayed assessment recorded; missing evidence yields provisional/insufficient score, not inflated result; ELS equals known fixture outputs.
9. Admin dashboard filtered to one child/subject/time has exactly matching aggregated figures; unknown actions logged without PII.
10. Migration fixture from live localStorage preserves per-table/per-theme state and profile names. No invented historical accuracy.
11. Basic load/performance budgets: on 1080p TV no essential CTA smaller than 64px target; home screen navigation no unbounded scroll; cached content works offline; API p95 <500ms under agreed staging workload (excluding media upload); error path friendly.
12. Manual LG webOS physical remote testing, audio autoplay, browser Back and localStorage persistence documented with evidence or explicit blocked status.

## 12. Operations, maintenance and SLOs

- Content operators: weekly topic review and imported mappings approval; prepublish checklists; publish log; version rollback.
- Engineering: dependency/security updates monthly; CI every PR; DB migration review by DB/security agent; restore rehearsals quarterly; event quality and failing-job alerts; daily backup verification.
- Targets (initial, not SLA): 99.5% API availability monthly; event ingestion lag <5min for 95% healthy online devices; dashboard aggregation freshness <24h; content manifest cached/stale-while-offline. Set incident severity for cross-tenant leak as SEV-0, disable affected endpoints, rotate keys, investigate.
- Metrics/data maintenance: source timestamps, version identifiers, definition dictionary, scheduled score recomputation when formula version changes, audit of deleted/archived questions.
- Cost maintenance: caps on source PDF size, media storage, retention periods, batch aggregation, sampling only of performance (never drop learning correctness events), no surprise LLM spending. AI-assisted content generation requires per-job cost limits and approval.

## 13. Development order and agent orchestration

The lead agent reads `agents/AGENTS.md` and `agents/WORK_BREAKDOWN.yaml` first. Never let agents alter DB schema and API contract independently: freeze contracts in a Phase 0 PR, then split modules by file ownership. Merge only after contract tests. Agent count is workload-dependent; suggested **10 specialists**: architecture/integration; database/RLS; curriculum + import; CMS + publishing; student integration; identity/security; telemetry; assessment/progress; intelligence/analytics; QA/DevOps. Multiple subagents may work in each area; lead resolves cross-module interfaces through ADRs.

**Milestones:** P0 inventory + frozen contracts → P1 secure backend/id/profile migration → P2 curriculum/CMS/import + published read API → P3 student integration and offline → P4 telemetry/assessments → P5 scoring/analytics → P6 security/load/LG testing → P7 staged launch and handoff. Unreleased modules feature-flagged off.

## 14. Implementation prohibitions and owner inputs

**DO NOT** invent prod credentials, expose Supabase service role, spin up public admin without auth, create a production database using test data as if real, replace live project with a blank Next.js app, assume actual school textbook or copyright rights, use unreviewed AI text as official CISCE curriculum, treat all autoplay as verified attention, claim learning impact from correlation, or perform prod cutover without owner authorization.

**Owner-required before real production provisioning:** accessible Git repo or permission to initialize one; Supabase account/project creation and billing choice; adult admin email credential setup; whether admin is `/admin` or separate domain; consent/retention decision; school name/book TOC uploads; production deploy permission. Coding agent MUST implement local/dev flow and document blockers rather than hard-code guesses.

## 15. Source references and provenance

- User-supplied BreakNLearn UI/UX Design Specification v1.0 (included in `/reference`).
- Current app behavior as observed in prior implementation/deployment context; coding agent must verify actual live code with the Vercel project rather than assume file layout.
- Curriculum seed from user's earlier CMS prototype (`reference/curriculum_seed_prototype.json`), explicitly editorial/unverified.
- CISCE official publications/curriculum: https://cisce.org/wp-content/uploads/2025/03/PrimaryCurriculum.pdf and https://cisce.org/wp-content/uploads/2025/03/UpperPrimary.pdf (verify availability/version; do not replace with scraped third parties).
- Supabase security reference: https://supabase.com/docs/guides/database/postgres/row-level-security and https://supabase.com/docs/guides/api/securing-your-api . RLS alone is insufficient without appropriate grants and Storage policies.
- Vercel deployment protection and domain rules: https://vercel.com/docs/deployment-protection and https://vercel.com/docs/domains/working-with-domains/add-a-domain . `vercel.app` sub-subdomain availability should not be presumed.
