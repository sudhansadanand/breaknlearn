# Privacy: data inventory, retention, consent, deletion

Scope:
- the BreakNLearn household learning app for children;
- adults are guardians (owner/guardian) and optional content staff;
- all data in this repo, tests and fixtures is SYNTHETIC.

This document states what the code does today. The household is a family in India (time zone `Asia/Kolkata`).
India's Digital Personal Data Protection Act 2023 requires verifiable consent of a parent or lawful guardian before a
child's personal data is processed; the consent flow below is built for that, but **no legal assessment has been made
in this repo and nothing here claims compliance**. Recommendation: have a lawyer familiar with the DPDP Act and Rules
review `docs/privacy/CONSENT_TEXT.md` and this flow before relying on it (`P7_OWNER_CHECKLIST.md`).

## 1. Data inventory

| Data | Where | Personal? | Who can read (RLS) | Retention today |
|---|---|---|---|---|
| Adult email, password hash | Supabase Auth (not in `bnl`) | yes (adult) | Supabase Auth only; the BFF sees the user id and email at sign-in | until the account is deleted in Supabase |
| Household label, time zone | `bnl.households` | low | members of that household | until household deletion |
| Memberships (owner/guardian), staff roles | `household_memberships`, `staff_roles` | auth user ids | own household; a staff user sees only their own role | until revoked or deleted |
| **Child display name, grade, avatar, slot** | `learner_profiles` | **yes (child)** | owner/guardian of that household; that household's paired TVs | until learner or household deletion |
| Child names on the TV | TV localStorage `breaknlearn.profiles.v1` and `breaknlearn.legacy-backup.v1` | yes (child) | anyone with the TV | until cleared on the TV (not reachable from the server) |
| Paired devices (label, token hashes, last seen) | `paired_devices`, `device_pairing_codes` | device | household adults (no token columns); codes are purged 1 day after expiry | until revoked or household deletion |
| Consent records (scope, version, which adult, granted/withdrawn at) | `consent_records` | adult id | that household's adults; the household's TVs only as a yes/no per scope (`bnl.household_has_consent`) | until household deletion (withdrawn rows are kept as evidence) |
| Raw learning telemetry (events with learner id, lesson, slide, timestamps, answer option ids) | `learning_events` | yes (pseudonymous, child) | household adults; the device that wrote them; `bnl_job` | **90 days** (`RETENTION_RAW_TELEMETRY_DAYS`), daily purge |
| Sessions and time totals | `learning_sessions` | yes (pseudonymous) | household adults, `bnl_job` | **395 days** (`RETENTION_AGGREGATE_DAYS`) |
| Progress (resume points, completion) | `learner_progress` | yes (pseudonymous) | household adults and devices | until learner deletion (product state, no time limit) |
| Assessment attempts, responses, review schedule | `assessment_attempts`, `question_responses`, `review_schedule` | yes (child answers) | household adults; the device for its own attempt | 395 days |
| Scores and recommendations | `mastery_snapshots`, `recommendations`, `score_runs` | yes (derived) | household adults | 395 days |
| Legacy import receipts and aliases | `migration_runs`, `migration_aliases` | pseudonymous | household adults and devices | until household deletion |
| School plans, syllabus uploads (PDF/DOCX/CSV), chapters, mappings | `school_plans`, `syllabus_uploads`, `import_jobs`, `syllabus_chapters`, `chapter_topic_mappings`; objects in bucket `school-syllabi` under `<household_id>/` | possibly (school documents) | that household's adults, through 60 s signed URLs | until household deletion (no time limit) |
| Audit log (actions, UUIDs, no names) | `audit_logs` | ids only | own household's adults (household rows); staff (staff rows) | no purge yet (see §6) |
| Idempotency caches, rate-limit buckets | `idempotency_keys`, `rate_limit_buckets` | ids / hashed IP keys | nobody but the functions | 24 h / about 1 day |
| Server logs | Vercel | request ids, redacted errors | operator | Vercel plan retention |

What is **not** collected:
- no child email, birth date, photo, voice or location;
- no third-party analytics or ads SDK on the TV or in the portal;
- no free-text answers (quiz answers are option ids).

## 2. Retention: 90 d / 395 d (owner confirmed defaults, 2026-11-15)

- The defaults come from `.env.example` and `packages/intelligence` (`RETENTION_DEFAULTS`, tested).
- `scripts/jobs/score-retention-purge.mjs` runs `bnl.purge_expired` and `bnl.purge_expired_analytics` (audited, idempotent; tested in `apps/admin/test/integration/analytics-db.test.ts` › "retention purge (real DB)").
- **Status: CONFIRMED** by the owner on 2026-11-15: 90 days (raw telemetry) and 395 days (aggregates), the defaults. The consent text states the same periods.
- Data with no time limit today:
  - profiles, progress and uploads, until deletion;
  - the audit log (no purge exists; see §6).

## 3. Consent (A9-PRIV-01, migration 0009)

### 3.1 Wording and versions

- Text: `docs/privacy/CONSENT_TEXT.md`, the same text as `apps/admin/src/server/privacy/consent-text.ts` (a unit test keeps
  them identical). Version **`bnl-consent-2026-11-v1`**, **approved by the owner on 2026-11-15** (`CONSENT_STATUS = "approved"`,
  no DRAFT banner). Legal review is still recommended.
- Any wording change needs a new `CONSENT_VERSION`. Parents whose grant is for an older version see "please review" on
  `/admin/privacy`; their consent keeps working until they withdraw it (a text bump never cuts off a child's TV).

### 3.2 Recording consent

- `/admin/privacy` (portal, owner or guardian) shows the notice and three separate choices. `GET /api/v1/admin/consent`
  returns the state per scope; `POST /api/v1/admin/consent` grants or withdraws (CSRF, audited `consent.granted` /
  `consent.revoked` with scopes and role, never names).
- The original body `{consent_version, decision}` stays valid and covers all three scopes. The optional `scopes` array
  limits the change. A grant is idempotent per scope and version. A withdrawal revokes every active grant of that scope in
  the household, whoever gave it (consent belongs to the household; RLS policy `adult_revoke`, 0009).
- "Verifiable" today means: only a signed-in owner/guardian account can consent, and each row records which account,
  when, scope and version. Whether that meets the DPDP Rules' verification requirement is for the legal reviewer.

### 3.3 Enforcement

| Scope | Endpoints that answer 403 `consent_required` without it |
|---|---|
| `learning_data` | `POST /devices/pair` (approval), `POST /progress/sync`, `POST /progress/legacy-import`, `POST /assessments/start`, `.../answers`, `.../finish`, and telemetry |
| `telemetry` | `POST /telemetry/batch` (needs `learning_data` **and** `telemetry`) |
| `school_uploads` | `POST /admin/imports` (new school document or pasted contents page) |

- The check runs after authentication (unauthenticated callers still get 401, SEC-001), inside the request's own
  transaction and before any idempotency replay, so a withdrawal stops ingestion on the **very next** request and a
  replayed `Idempotency-Key` cannot bypass it. Reads (progress list, due reviews, catalog, analytics) are not gated.
- Device requests use `bnl.household_has_consent(scope)` (SECURITY DEFINER, `bnl_device` only): it answers for the
  household in the verified token context and takes no household id, so it cannot reveal anything about another household.
- **After a withdrawal, data already collected is kept** until the parent asks for deletion (§4). The page says so.
- The error body is `{"error": {"code": "consent_required", "details": {"scopes": [...]}}}`.

**How the TV reacts (`apps/student/src/paired.ts`, read-only review):** nothing blocks the child, no error is shown, local
play continues.
- Progress sync: a 403 drops that attempt's upload (local progress stays). Good.
- Telemetry: anything but a valid ack is retried with backoff (cap 5 min) and the queue is capped at 1500 events. So events
  recorded **on the TV** while consent was off would upload later if consent is given again. **A5 change requested:** in
  `sendBatch`/`ackOrNull`, when `res.status === 403` and `error.code === "consent_required"`, acknowledge (drop) the batch
  instead of retrying, and stop emitting until the next config/consent check.
- Legacy import: a 403 marks the run `failed`; it is re-planned at the next app start (not by the 5 s loop). **A5 change
  requested:** treat 403 `consent_required` like 429/5xx (keep the run pending, same key) so it completes once consent is given.
- Pairing: the parent sees the 403 message in the portal ("give consent on the Privacy page"); the TV keeps polling and the
  code expires after 10 minutes as usual.

### 3.4 Before go-live

The seed `dev_synthetic.sql` grants `learning_data` only. On a real deployment the owner opens `/admin/privacy` and makes
the choices **before** pairing a TV and before switching on `FEATURE_TELEMETRY` / `FEATURE_ASSESSMENTS`.

## 4. Data subject requests: export and deletion (OPS-005)

### 4.1 Export (self-service)

- `GET /api/v1/admin/privacy/export` and the "Download all data" link on `/admin/privacy` (a plain link, works without
  JavaScript). **Owner or guardian**: both are parents of the household and can already read nearly all of it in the portal;
  deletion stays owner-only.
- Response: JSON attachment `breaknlearn-export-<YYYY-MM-DD>.json` (household date), `Cache-Control: no-store`, rate limited
  (10 per hour per adult), audited as `privacy.exported` with table and row counts only.
- Content: `bnl.export_household` (SECURITY DEFINER, `bnl_adult` only, refuses a household the caller is not a member of)
  returns **every** row of every `bnl` table with a `household_id` column (generic, so new tables are included
  automatically) plus the household row. Columns whose name contains `token`, `secret`, `hash` or `password` are removed
  (device refresh hashes, pairing code hashes, poll secrets). Storage object keys are included (they are `<household>/<uuid>`).
  `idempotency_keys` (24 h replay caches) are left out. Adult emails live in Supabase Auth and are not part of the export.

### 4.2 Deletion (self-service)

1. The **owner** chooses a scope on `/admin/privacy` (or `POST /api/v1/admin/privacy/deletion-requests` with CSRF and
   `{"scope", "learner_id"?, "confirmation": "DELETE"}`). A guardian gets 403. A learner of another household gets 404.
   The same scope (and learner) cannot be queued twice while open (409). Audited `privacy.deletion_requested`.
2. `scripts/jobs/process-deletion-requests.mjs` (run **nightly**, `bnl_job`) takes every queued request:
   - household scope: removes the household's `school-syllabi` objects through the storage port first, then
   - calls `bnl.process_deletion_request(id, objects_removed)` (SECURITY DEFINER, `bnl_job` only), which has the same
     semantics as the interim procedure below (pinned by `redteam-deletion.test.ts`) and writes `privacy.deletion_completed`
     with counts, no names. A learner who is no longer in the household closes the request as `rejected` (nothing deleted).
   - The job is idempotent: a crash between the storage step and the database step is completed by the next run;
     missing objects are a no-op. Each run writes a `job_runs` row (`process_deletion_requests`); exit code 1 if any request failed.
3. **Target: the next nightly run, and never later than 7 days** after the request (shown to the parent as "done by").
4. `GET /api/v1/admin/privacy/deletion-requests` (owner or guardian) and the page list requests and their status. After a
   household deletion the household, its memberships and the request itself are gone; the audit row remains without a household id.
5. Still manual: deleting the adult accounts in Supabase Auth if asked; clearing names on the TV (Profiles → edit →
   delete, or clear site data); backups age out on their own schedule (`BACKUP_RESTORE.md`).

| Scope | Deletes |
|---|---|
| `telemetry_only` | raw events and sessions (of one learner, or of the whole household) |
| `learner` | every row about the learner: responses, review schedule, attempts, events, sessions, progress, scores, recommendations, aliases; the household's idempotency caches; then the profile |
| `household` | the household's syllabus objects in Storage, then everything in the household. The household row cascades memberships, devices, profiles, consent, plans and the request itself |

### 4.3 Operator fallback (tested)

If the job cannot run, an operator executes one request by hand, exactly as before:

```sh
psql "$MIGRATION_DB_URL" -X -v ON_ERROR_STOP=1 -1 \
  -c "select set_config('bnl_ops.request_id', '<request id>', false)" \
  -f scripts/ops/sql/process-deletion-request.sql
```

Then remove the Storage objects listed under `object_keys_to_remove` in the audit row. Proof:
`packages/db/test/integration/redteam-deletion.test.ts` (6 tests).

## 5. Safeguards in place (tested)

- RLS enabled and forced on every table, no PUBLIC/anon grants (`redteam-schema.test.ts`).
- Cross-household isolation for 12 attacker types × 24 household tables (`redteam-tenancy.test.ts`) and every `[id]` route (`redteam-routes.test.ts`).
- Staff (content roles) never see child rows (SEC-010).
- Logs and audits carry UUIDs only. TV-facing ids never contain names.
- Private uploads are only reachable through 60 s signed URLs after a household check (SEC-007).
- Admin pages are `no-store`.
- Consent is enforced on every ingesting endpoint and checked before idempotency replays (`apps/admin/test/privacy/consent-gating.test.ts`, `apps/admin/test/integration/privacy-db.test.ts`).
- Export returns only the caller's household and never a secret column; deletion functions are executable by `bnl_job` only (`packages/db/test/integration/privacy-functions.test.ts`).

## 6. Known gaps

- Audit log retention: no purge yet (proposal: add `audit_logs` older than `p_aggregate_days` to `bnl.purge_expired`).
- The two TV client changes in §3.3 (A5).
- Legal review of the consent wording and of the verification mechanism.
