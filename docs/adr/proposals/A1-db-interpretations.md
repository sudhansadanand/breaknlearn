# A1 proposal: database interpretations of the frozen v1 contracts

- Status: Proposed by A1 (DB & RLS), 2026-11-14. No contract file was changed. The lead should accept these as an ADR, or tell A1 to change them.

1. **Subject authority.** `GRADE_SUBJECTS[].authority` is `cisce | local_enrichment`, but the curriculum `Authority` enum has no `cisce`. Only `cisce_verified` exists, and it requires a cited source (CAT-006).
   - `bnl.grade_subjects.authority` stores the contract value exactly.
   - Subject nodes in `curriculum_nodes` use `editorial_unverified` (CISCE) or `local_enrichment`, and keep `provenance.subject_authority = 'cisce'`.
   - Proposal: keep this. Never seed `cisce_verified` without a citation.
2. **Manifest checksum.** `PublishedManifest` contains its own `checksum`, so the hash cannot cover the whole object.
   - Rule: `checksum = sha256_hex((manifest - 'checksum')::text)`, the canonical Postgres `jsonb` text.
   - The ETag is this checksum.
   - `revision` comes from one global identity sequence: it increases within each grade but is not contiguous per grade.
3. **`score_answer` records the response.** Devices have no INSERT on `question_responses`, so correctness can only come from the server (TEL-005). The function takes an optional `p_response_ms`, returns `already_answered` for idempotent retries, and returns the stored result on retry.
4. **Spec §5 / M-module table names not created** (renamed or merged by ADR-0005 or the contracts):
   - `memberships` → `household_memberships` + `staff_roles`
   - `devices` and `device_tokens`/`device_sessions` → `paired_devices` (`token_version`, `refresh_token_hash`)
   - `content_audit` → `audit_logs`
   - `item_bank` → `quiz_items`
   - `outcome_links` → `lesson_outcomes`
   - `chapters`/`topic_mappings` → `syllabus_chapters`/`chapter_topic_mappings`
   - `lesson_slides` and `progress_conflicts` are not created: slides live in the immutable version `content`, and progress conflicts are resolved by `server_revision`. Add them later as new migrations if A4 or A6 need them.
5. **Column names follow the contracts, not the blueprint:**
   - `learner_profiles.slot` (blueprint: `profile_slot`)
   - `topic_id` (blueprint: `topic_node_id`)
   - `mastery_snapshots.questions_count` and `confidence_note`
   - `learning_events.quality_flag ∈ ok|clamped|late_arrival|clock_adjusted|sequence_gap|suspect`. ADR-0005 names the enum but not its values, so A6 should confirm them.
