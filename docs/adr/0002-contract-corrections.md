# ADR-0002: Corrections to the handoff contracts (v1.0 → frozen v1.1)

- Status: Accepted (2026-11-14). Contracts are frozen on branch `foundation/contracts`; later changes must be additive and get their own ADR.
- Originals kept for reference in `docs/handoff/contracts-v1.0-original/`.

Each item: **problem in v1.0 → decision**.

## Identity and legacy (L)
- **L1** Live profiles use slot ids `child-1/2` and emoji avatars; v1.0 `Profile` required UUID `id` and `avatar_id`. → `Profile` has server UUID `id`, `slot` (1|2), `avatar_id` from a fixed 12-value enum mapped 1:1 to the live emoji list (`AVATARS`), and optional `preferences` (`music_enabled`, `last_theme_key`, `last_table`) because the live app persists them per profile. Server keeps a `migration_aliases` row linking `(device_id, local_profile_id)` → learner UUID; never trusts a client-chosen learner id.
- **L2** Historical keys `breaknlearn.progress.v1` / `learnbreak-x3-v4-progress` are not read by the live app and their shape is unknown. → `LegacyImportRequest.raw` carries them as opaque JSON; importer recognises only world-keyed objects and maps them to ×3 (MIG-003); everything is backed up verbatim on the device (`breaknlearn.legacy-backup.v1`) and counted as `entries_unrecognized` otherwise. Added endpoint `POST /progress/legacy-import` (idempotent by `migration_run_id` + `legacy_fingerprint`).
- **L3** Bare world keys map to ×3 **regardless** of any `table` field (matches live `entry()`).

## Pairing (P)
- **P1** v1.0 had no way for the TV to obtain a credential after approval. → `POST /devices/pairing-code` returns `pairing_id` + `poll_secret` (TV-only secret, stored hashed); guardian approves via `POST /devices/pair`; TV redeems via `POST /devices/token` (202 pending, 200 once, 410 expired/consumed). Added refresh rotation, list and revoke endpoints. Code: 8 chars from an unambiguous alphabet, TTL 600 s, one-time.
- **P2** Device token claims fixed: `sub`=device, `hid`=household, `ver`=token_version (bump = revoke all), `scope`=`device`.

## Content (C)
- **C1** Lesson identity: one lesson per multiplication table (10 lessons — matches CAT-005 "ten lesson references"); the six worlds are a `themes` config of `picture_groups_v1`, not 60 lessons. The v1.0 example key `…table-7.puppy` is therefore not canonical. Stable keys `grade2.math.multiplication.table-N`, fixed UUIDv5 ids in `MULTIPLICATION_LESSON_IDS`. See ADR-0004.
- **C2** Added `PublishedManifest` and `PublishedLesson` schemas (v1.0 only described them in prose). Manifest per grade, includes non-playable subject stubs so the student UI keeps "Coming soon" tiles without guessing.
- **C3** Answer keys (`QuizItem.correct_option_id`) are server-only; public lesson content never includes them.
- **C4** Added admin endpoints for the full state machine: version transitions (submit/approve/reject), unpublish, manifest pin (rollback), preview, media upload, curriculum review with mandatory source citation for `cisce_verified`.

## Telemetry (T)
- **T1** Payload is closed (`additionalProperties:false`) — kept, but v1.0 lacked fields the spec needs: added `theme_key`, `slide_index`, `attempt_stage`. `reason_code` restricted to `^[a-z0-9_]+$` so it cannot carry free text.
- **T2** No `is_correct` (TEL-005); correctness only from server scoring.
- **T3** `TelemetryAck.rejected[].event_id` nullable (an unparseable event may have no valid id); rejection `code` is an enum.
- **T4** The JSON Schema file is the single source; OpenAPI inlines an identical copy (test-enforced) because OpenAPI validators cannot resolve external URL refs.

## Progress (G)
- **G1** v1.0 `/progress/sync` lacked theme and conflict base. → added `theme_key`, `base_server_revision`, `client_updated_at` (informational only), response `outcome` ∈ applied|merged|stale_ignored. Identity is `(learner, lesson, theme, attempt)`; completion is monotonic within an attempt; replay = new `attempt_id`.

## Scores (S)
- **S1** v1.0 `LearningScore` lacked `limitation` required by spec §8, and ELS-005 mentions `low_confidence` which was not a status. → added `limitation`, `confidence` ∈ low|adequate (status enum unchanged), `components` as fixed `M/R/I/C` nullable fields, `learner_id`, `topic_id`.

## API-wide (A)
- **A1** One `Error` schema (`code` enum, `request_id`, optional `details`) used by every error response.
- **A2** `Idempotency-Key` required on telemetry, progress sync, legacy import, publish/unpublish/pin and syllabus import (test-enforced).
- **A3** Every `/admin/*` operation requires `AdultSession` (test-enforced); only health, pairing bootstrap and published catalog are credential-free (test-enforced allowlist).
- **A4** Cookie-session mutations require Origin check + `X-CSRF-Token` (SEC-009).
