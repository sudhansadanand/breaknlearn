# ADR-0005: Database access model and required changes to the schema blueprint

- Status: Accepted (2026-11-14) — binding on A1 (DB & RLS) for `supabase/migrations/0001_*`.
- Blueprint (reference only, not to be applied as-is): `supabase/blueprint/001_schema_blueprint.sql`.

## Access model
- Schema `bnl` is **not** exposed through Supabase's REST/GraphQL (`anon`/`authenticated` get no grants; tests assert denial — SEC-005).
- The server BFF connects with a pooled Postgres URL and, per request, runs inside a transaction that does `SET LOCAL ROLE` to one of: `bnl_public` (published catalog only), `bnl_device` (one household + device), `bnl_adult` (one user; household via membership), `bnl_staff` (content roles), plus `set_config('bnl.household_id'| 'bnl.device_id'| 'bnl.actor_id', …, true)` from the **verified** credential. RLS policies key on those settings, so a handler bug cannot cross households (defence in depth on top of handler checks).
- `service_role`/owner connections are for migrations and scheduled jobs only, never request paths.
- Uses plain Postgres features only (no FK to `auth.users`), so the suite runs on stock Postgres 16 in CI as well as local Supabase.

## Required changes to the blueprint
1. Roles split per ADR-0003: `household_memberships.role ∈ (owner, guardian)`; new `staff_roles`.
2. `migration_aliases(id, household_id, device_id, local_profile_id, learner_id, migration_run_id, legacy_fingerprint, created_at, unique(device_id, local_profile_id))` and `migration_runs` (idempotency of legacy import).
3. `paired_devices`: `label not null`, `last_seen_at`, `refresh_token_hash`, `refresh_rotated_at`; `device_pairing_codes`: `pairing_id`, `poll_secret_hash`, `approved_by`, `approved_at`, `device_id`, `redeemed_at`, `failed_attempts`.
4. `learner_progress`: add `theme_key` (check in 6 worlds or null for non-picture templates), `client_revision`, `completed_at`; unique `(learner_id, lesson_id, theme_key, attempt_id)`; trigger: `completed` cannot go true→false within an attempt.
5. `lesson_versions`: `validation_errors jsonb`, `submitted_by/at`, `rejected_by/at`, `review_comment`; trigger makes `content`/`checksum` immutable once status ≠ `draft`; check reviewer ≠ author at approve.
6. `quiz_items(id, lesson_version_id, question_version_key unique, outcome_key, stage_eligibility text[], prompt, options jsonb, correct_option_id)` — readable only by `bnl_device` scoring functions / staff, never by `bnl_public`.
7. `published_manifests`: add `grade`, `pinned_from_revision`, `created_by`; ETag = checksum. Publish/unpublish/pin are single SQL functions (one transaction: publication record + audit + manifest) — OPS-003.
8. `assessment_attempts`: `client_attempt_id unique`, `seed`, `question_keys jsonb`, `device_id`.
9. `learning_sessions`: `client_session_id` unique per device; `learning_events`: index `(device_id, client_session_id, client_sequence)`, `quality_flag` enum.
10. `mastery_snapshots`: add `confidence`, `limitation`, `score_run_id`; new `score_runs`, `metric_definitions`.
11. New `idempotency_keys(key, scope, actor_or_device, request_sha256, response jsonb, status_code, created_at)`, `rate_limit_buckets`, `data_deletion_requests`, `content_audit` merged into `audit_logs` (metadata must not contain names/answers/tokens).
12. All child/private tables carry `household_id` and `updated_at`; every table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`, explicit grants per app role, and at least one deny test.
13. Storage: buckets `school-syllabi` (private, household-scoped paths `household_id/…`), `lesson-assets` (private; signed URLs for published assets). Policies tested (SEC-007).
14. Retention defaults (pending owner): raw `learning_events` 90 days, aggregates 395 days, via scheduled purge job with audit.
