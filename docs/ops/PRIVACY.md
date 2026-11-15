# Privacy: data inventory, retention, consent, deletion

Scope:
- the BreakNLearn household learning app for children;
- adults are guardians (owner/guardian) and optional content staff;
- all data in this repo, tests and fixtures is SYNTHETIC.

This document states what the code does today. Legal obligations (for example India's DPDP Act 2023 rules on
children's data and verifiable parental consent) have **not** been assessed in this repo. The owner must
confirm them (`P7_OWNER_CHECKLIST.md`).

## 1. Data inventory

| Data | Where | Personal? | Who can read (RLS) | Retention today |
|---|---|---|---|---|
| Adult email, password hash | Supabase Auth (not in `bnl`) | yes (adult) | Supabase Auth only; the BFF sees the user id and email at sign-in | until the account is deleted in Supabase |
| Household label, time zone | `bnl.households` | low | members of that household | until household deletion |
| Memberships (owner/guardian), staff roles | `household_memberships`, `staff_roles` | auth user ids | own household; a staff user sees only their own role | until revoked or deleted |
| **Child display name, grade, avatar, slot** | `learner_profiles` | **yes (child)** | owner/guardian of that household; that household's paired TVs | until learner or household deletion |
| Child names on the TV | TV localStorage `breaknlearn.profiles.v1` and `breaknlearn.legacy-backup.v1` | yes (child) | anyone with the TV | until cleared on the TV (not reachable from the server) |
| Paired devices (label, token hashes, last seen) | `paired_devices`, `device_pairing_codes` | device | household adults (no token columns); codes are purged 1 day after expiry | until revoked or household deletion |
| Consent records | `consent_records` | adult id | that household's adults | until household deletion |
| Raw learning telemetry (events with learner id, lesson, slide, timestamps, answer option ids) | `learning_events` | yes (pseudonymous, child) | household adults; the device that wrote them; `bnl_job` | **90 days** (`RETENTION_RAW_TELEMETRY_DAYS`), daily purge |
| Sessions and time totals | `learning_sessions` | yes (pseudonymous) | household adults, `bnl_job` | **395 days** (`RETENTION_AGGREGATE_DAYS`) |
| Progress (resume points, completion) | `learner_progress` | yes (pseudonymous) | household adults and devices | until learner deletion (product state, no time limit) |
| Assessment attempts, responses, review schedule | `assessment_attempts`, `question_responses`, `review_schedule` | yes (child answers) | household adults; the device for its own attempt | 395 days |
| Scores and recommendations | `mastery_snapshots`, `recommendations`, `score_runs` | yes (derived) | household adults | 395 days |
| Legacy import receipts and aliases | `migration_runs`, `migration_aliases` | pseudonymous | household adults and devices | until household deletion |
| School plans, syllabus uploads (PDF/DOCX/CSV), chapters, mappings | `school_plans`, `syllabus_uploads`, `import_jobs`, `syllabus_chapters`, `chapter_topic_mappings`; objects in bucket `school-syllabi` under `<household_id>/` | possibly (school documents) | that household's adults, through 60 s signed URLs | until household deletion (no time limit) |
| Audit log (actions, UUIDs, no names) | `audit_logs` | ids only | own household's adults (household rows); staff (staff rows) | no purge yet (see §4) |
| Idempotency caches, rate-limit buckets | `idempotency_keys`, `rate_limit_buckets` | ids / hashed IP keys | nobody but the functions | 24 h / about 1 day |
| Server logs | Vercel | request ids, redacted errors | operator | Vercel plan retention |

What is **not** collected:
- no child email, birth date, photo, voice or location;
- no third-party analytics or ads SDK on the TV or in the portal;
- no free-text answers (quiz answers are option ids).

## 2. Retention: 90 d / 395 d, pending owner confirmation

- The defaults come from `.env.example` and `packages/intelligence` (`RETENTION_DEFAULTS`, tested).
- `scripts/jobs/score-retention-purge.mjs` runs `bnl.purge_expired` and `bnl.purge_expired_analytics` (audited, idempotent; tested in `apps/admin/test/integration/analytics-db.test.ts` › "retention purge (real DB)").
- **Status: PENDING OWNER DECISION.** The owner must confirm 90 days (raw telemetry) and 395 days (aggregates) or choose other values before P7.
- Data with no time limit today:
  - profiles, progress and uploads, until deletion;
  - the audit log (no purge exists; proposal in §6).

## 3. Consent

- The portal records consent per household and version: `POST /api/v1/admin/consent` writes `bnl.consent_records` (grant and revoke, audited). The scopes are `learning_data`, `telemetry` and `school_uploads`.
- **Honest status:** no code path **checks** consent yet. Telemetry ingest, assessments and uploads work whether a consent row exists or not. Until consent gating is implemented, the owner must get consent **before** a TV is paired and the telemetry/assessment flags are turned on (`DEPLOYMENT_RUNBOOK.md` §5 step 3). The consent text and its version string are owner deliverables.
- There is no verifiable-parental-consent mechanism beyond the guardian's authenticated adult account.

## 4. Data subject requests: export and deletion

**OPS-005 status: partial.** The table `bnl.data_deletion_requests` exists. There is **no** guardian-facing API or
automated job for export or deletion. Until one is built, an operator runs the procedure below on a written request
from the household owner.

### Deletion procedure (interim, tested)

1. Verify the request comes from the household **owner**, using the authenticated email on file. Record it:
   ```sql
   insert into bnl.data_deletion_requests (household_id, requested_by, scope, learner_id)
   values ('<household uuid>', '<owner auth user id>', '<telemetry_only|learner|household>', <'<learner uuid>' or null>) returning id;
   ```
   (Run this with the migration login, after `set local role bnl_owner`, or have the owner submit the request
   through a future API.)
2. Take a fresh backup if a full-household deletion is being done (`BACKUP_RESTORE.md`). Backups must age out
   within the backup retention period, and the owner must accept that window.
3. Execute:
   ```sh
   psql "$MIGRATION_DB_URL" -X -v ON_ERROR_STOP=1 -1 \
     -c "select set_config('bnl_ops.request_id', '<request id>', false)" \
     -f scripts/ops/sql/process-deletion-request.sql
   ```

   | Scope | Deletes |
   |---|---|
   | `telemetry_only` | raw events and sessions (of one learner, or of the whole household) |
   | `learner` | every row about the learner: responses, review schedule, attempts, events, sessions, progress, scores, recommendations, aliases; the household's idempotency caches; then the profile |
   | `household` | everything in the household. The household row cascades memberships, devices, profiles, consent, plans and the request itself |

   The procedure:
   - refuses replays;
   - refuses a learner who is not in the request's household;
   - writes an audit row `privacy.deletion_completed` with counts and no names.

   Proof: `packages/db/test/integration/redteam-deletion.test.ts` (6 tests).
4. Household scope only: delete the Storage objects listed in the audit row's `object_keys_to_remove` from bucket
   `school-syllabi`, then delete the adult accounts in Supabase Auth if the owner asked for that.
5. Tell the guardian to clear the TV: Profiles → edit → delete, or clear site data. The server cannot reach TV localStorage.
6. Target: completion within 7 days of a verified request (alert in `MONITORING.md`).

### Export (manual)

There is no export endpoint. As an interim, the operator runs read-only queries (`set local role bnl_owner`) for the
household's tables in §1 and hands over a JSON file over a channel the owner chooses.
**Gap:** this needs an authenticated `GET /api/v1/admin/export` (proposal).

### Known gaps (proposed in `docs/adr/proposals/A9-qa-ops.md`)

- Guardian self-service deletion and export API, plus a job that processes `data_deletion_requests`.
- Consent gating on telemetry, assessments and uploads.
- Audit log retention (proposal: 395 days, purged by `bnl.purge_expired`).
- Storage object deletion that follows a household delete automatically.

## 5. Safeguards in place (tested)

- RLS enabled and forced on every table, no PUBLIC/anon grants (`redteam-schema.test.ts`).
- Cross-household isolation for 12 attacker types × 24 household tables (`redteam-tenancy.test.ts`) and every `[id]` route (`redteam-routes.test.ts`).
- Staff (content roles) never see child rows (SEC-010).
- Logs and audits carry UUIDs only. TV-facing ids never contain names.
- Private uploads are only reachable through 60 s signed URLs after a household check (SEC-007).
- Admin pages are `no-store`.
