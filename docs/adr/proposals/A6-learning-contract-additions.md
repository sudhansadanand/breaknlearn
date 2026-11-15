# Proposal A6: telemetry, progress and legacy-import interpretations and additive fields (P4)

- Status: Proposed by A6 (Telemetry & Progress), 2026-11-14. Needs lead/A0 approval as a follow-up ADR.
- No frozen contract file was changed. The additive fields below are implemented in
  `apps/admin/src/server/learning/legacy-import.ts` as `LegacyImportRequestV1A` / `LegacyImportReceiptV1A`
  (Zod `.extend()` of the frozen schemas), so v1.1 clients keep working.

## 1. Legacy import: explicit assignment of historical-key entries (additive request field)
`breaknlearn.progress.v1` / `learnbreak-x3-v4-progress` entries belong to no profile (ADR-0002 L2). The frozen
`profile_mapping` (max 2) has no slot for them. Proposal:
- `LegacyImportRequest.historical_learner_id?: Uuid | null`. When set, the guardian assigns every historical
  (×3-only, MIG-003) entry to that learner. It must be in the device's household (else 403).
- When absent, nothing from those keys is written; they stay in the device backup and are reported as pending.

## 2. Legacy import receipt (additive response fields)
- `historical: { entries_found, entries_pending_assignment, entries_unrecognized }` (always present).
- Assigned historical entries appear in `per_profile` with the reserved `local_profile_id = "legacy:historical"`.
- `entries_skipped_newer_on_server` counts entries whose (learner, lesson, theme) already holds progress that
  is the same or further (any attempt, or the legacy attempt unchanged). A re-import of the same snapshot under
  a new `migration_run_id` therefore reports `imported` with all entries skipped and writes nothing.
- Same `(migration_run_id, legacy_fingerprint)` returns the stored receipt with `outcome: "already_imported"`.

## 3. Legacy import rules (interpretations)
- Fingerprint = `sha256_hex(canonicalJson({ the three legacy keys, missing = null }))`, computed by
  `legacyFingerprint()` in `@bnl/student-progress` (WebCrypto, same code on TV and server). Extra keys in `raw`
  are not part of the snapshot. Mismatch → 422 `validation_failed` (`fingerprint_mismatch`).
- Mapping must be one-to-one and name only profiles present in the snapshot; every profile with entries must be
  mapped (422 codes `unknown_local_profile`, `duplicate_mapping`, `profile_mapping_missing`). A local profile
  already aliased on this device to a different learner → 409 `conflict` (no silent remap).
- Attempt id = UUIDv5(`3a6f0c52-6d1b-4f7e-9b0a-6a6c2f1e5d01`, `legacy-import:<learner>:<lesson>:<theme>`):
  one legacy attempt per (learner, lesson, theme), **independent of the run id**, so any re-import merges into
  the same row with the monotonic merge rule (MIG-004) instead of creating a duplicate attempt.
- Only `learner_progress`, `migration_runs`, `migration_aliases` and one `audit_logs` row (counts only) are
  written. No sessions, events, attempts or scores (§10.3). `completed_at` is the import time (device clocks are
  untrusted).

## 4. Telemetry
- `learning_events.quality_flag` values confirmed (A1 #5): `ok | clamped | late_arrival | clock_adjusted |
  sequence_gap | suspect`. Ingest sets, in precedence order: `suspect` (impossible heartbeat: playback > visible,
  hidden-but-visible, paused-but-playing, or a different learner inside an existing session), `clock_adjusted`
  (occurred_at after sent_at or after server now, within the 5 min skew), `late_arrival` (> 24 h old, < 72 h),
  `sequence_gap` (an earlier sequence of the session is known but not the immediate predecessor). `clamped` is
  reserved. The aggregation job excludes `suspect` events from time totals.
- `sequence_regression`: a different `event_id` in an already-used `(device, client_session_id, client_sequence)`.
- `lesson_unknown` also covers a `lesson_version_id` that is unknown/unpublished or belongs to another lesson.
- Batch envelope: `{events}` only (unknown top-level keys → 422); > 100 events → **413** `payload_too_large`
  (as for > 128 KB), 0 events → 422.
- An `event_id` already stored in another household is acknowledged as a duplicate and not stored.
- Feature flag `FEATURE_TELEMETRY` must equal `"true"`; otherwise 503 `feature_disabled` (checked before auth).

## 5. Idempotency (all learning mutations)
- Stored in `bnl.idempotency_keys` with scope `telemetry.batch | progress.sync | progress.legacy_import`, owner =
  device id, request hash = sha256 of canonical JSON of the body. Only 2xx responses are stored (errors roll back).
  Replays return the stored body with header `Idempotent-Replayed: true`. Same key + different body → 409
  `idempotency_conflict`. Missing/invalid header → 422. TTL 24 h.
- Suggest documenting `Idempotent-Replayed` and the 409 in OpenAPI for all three operations.

## 6. Progress
- `POST /progress/sync`: `base_server_revision` greater than the server's, or non-null for a row that does not
  exist → 409 `conflict` with `details.server_revision`. Unknown/unpublished lesson or a version of another
  lesson → 422 (`lesson_unknown`). Learner outside the household → 403 (also for `GET`).
  Slide order uses the trailing number of `slide_id` (`step-N`).
- `GET /progress`: cursor is the last row id (opaque UUID); rows without `theme_key` (non-picture templates) are
  omitted until ProgressState allows a null theme.
- Suggest adding 401/409/422/429 to the OpenAPI responses of these operations.

## 7. Rate limits (per device / caller, fixed window)
telemetry 60/min, progress sync 120/min, progress read 120/min, legacy import 10/h.
