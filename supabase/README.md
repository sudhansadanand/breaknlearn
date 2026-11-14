# BreakNLearn database (`supabase/`)

Schema `bnl` for PostgreSQL 15+ (tested on 16). It implements spec §5 with the binding changes in
ADR-0005 (access model), ADR-0003 (household vs. staff roles) and ADR-0004 (one lesson per table).
Everything is plain Postgres: there are no foreign keys to `auth.users` and the only extension is `pgcrypto`.
The same files run on stock Postgres in CI and on local or hosted Supabase.

```
supabase/
  migrations/0001_core.sql        roles, schema, tables, constraints, indexes, row triggers
  migrations/0002_rls.sql         grants, access helpers, RLS policies (ENABLE + FORCE on every table)
  migrations/0003_functions.sql   workflow, publish/manifest, scoring, pairing, rate-limit, retention functions
  seed/0001_curriculum.sql        GENERATED (scripts/db/gen-curriculum-seed.mjs): subjects + 80 editorial topics
  seed/0002_multiplication_lessons.sql  the ten live ×1–×10 lessons, item bank, initial manifests
  seed/dev_synthetic.sql          SYNTHETIC households/users/devices/learners. Dev/test only, never production
  blueprint/                      original reference blueprint (read-only, not applied)
```

## Run locally

### Stock Postgres harness (what CI and the tests use)

```sh
pnpm --filter @bnl/db test:integration          # migrations + seeds + Vitest suite on a throwaway cluster
node scripts/db/test-db.mjs                     # only build and verify the databases, then tear down
node scripts/db/test-db.mjs --keep -- bash      # open a shell with BNL_TEST_* exported; keep the data dir
```

`scripts/db/test-db.mjs` uses only Node built-ins. It runs `initdb` and `pg_ctl` from `BNL_PG_BIN`
(default `/usr/lib/postgresql/16/bin`) in a temporary directory, on a free 127.0.0.1 port, with
random passwords and scram auth. When it runs as root, the server binaries run as the `postgres`
OS user. The harness then:

1. creates `bnl_test` and applies the migrations, the core seeds and `dev_synthetic.sql`;
2. creates `bnl_fresh_a` and `bnl_fresh_b` with migrations and core seeds, then re-applies the
   migrations to `bnl_fresh_b`;
3. sets a random password on `bnl_app` and exports `BNL_TEST_DB_URL` (bnl_app),
   `BNL_TEST_ADMIN_URL` (superuser, for test setup only) and `BNL_TEST_FRESH_DB_URLS`;
4. runs the command you gave it, then stops the cluster and deletes the directory.

If you change a migration, keep re-running the harness until it passes.

### Supabase CLI

1. If `supabase/config.toml` is missing, run `supabase init`. It belongs to the integrator.
2. Set the seed order in `config.toml`:
   ```toml
   [db.seed]
   enabled = true
   sql_paths = ["./seed/0001_curriculum.sql", "./seed/0002_multiplication_lessons.sql", "./seed/dev_synthetic.sql"]
   ```
3. Run `supabase start`, then `supabase db reset`. This applies `migrations/*.sql` in order, then the seeds.
4. Give the app login a local-only password:
   `psql "$SUPABASE_DB_URL" -c "alter role bnl_app with password '<local-only>'"`.
   Then point the BFF at `postgresql://bnl_app:<local-only>@127.0.0.1:54322/postgres`.
   On a transaction-mode pooler, create the client with `createDb(url, { prepare: false })`.

The `bnl` schema is **not** added to the Supabase API's exposed schemas, and `anon`/`authenticated`
have no grants on it. Never put `bnl` in `[api].schemas`.

**Production:** apply the migrations once, then the two core seeds (`0001_curriculum.sql` and
`0002_multiplication_lessons.sql`), through an owner-run operations connection. Never apply
`dev_synthetic.sql` to production. It refuses to run on a database that has non-synthetic
households. The `bnl_app` password is set from the secret store and never from a file in this repo.

## Role model (ADR-0005)

| Role | Login | Entered by | Can see / do |
|---|---|---|---|
| `bnl_app` | yes, NOINHERIT | the BFF's pooled URL | nothing by itself; it must `SET ROLE` to one of the roles below |
| `bnl_public` | no | `{kind:'public'}` | `lessons` and `lesson_versions` (catalog columns, live publications only), `published_manifests`, `grade_subjects`; pairing bootstrap functions. Never `quiz_items`, drafts, uploads, pairing codes or child data |
| `bnl_device` | no | `{kind:'device', householdId, deviceId}` | its own household's learners, progress, sessions, events, attempts, responses (read-only), review schedule and migration tables, but only while the device is not revoked and belongs to that household. Reads published content. Scores answers via `bnl.score_answer`. Always reads its own `paired_devices` row (even when revoked, so a stale `token_version` fails closed). Updates `last_seen_at`, and updates `refresh_token_hash`/`refresh_rotated_at`/`revoked_at`/`token_version` while not revoked |
| `bnl_adult` | no | `{kind:'adult', userId}` | households where the user is owner or guardian (`bnl.adult_household_ids()`): children, progress and analytics (read), devices (no token hashes), consents, school plans and uploads. Owners manage memberships. Approve-pairing flow: reads unclaimed, unexpired `device_pairing_codes`; claims one (`household_id`, `approved_by`, `approved_at`, `device_id`) only for an active own household; inserts `paired_devices` and `audit_logs` there |
| `bnl_staff` | no | `{kind:'staff', userId}` | content tables per `staff_roles`. Editors create and edit drafts. Reviewers approve or reject through `bnl.transition_lesson_version`. Publishers use the publish, unpublish, pin and refresh functions. Analysts get metric definitions and run status only. No child-level table is granted |
| `bnl_job` | no | `{kind:'job'}` | aggregation, scoring, recommendation, review and retention tables; reads learning data across households. Also used by pre-auth server endpoints: pairing-code create and redeem (`device_pairing_codes`, first `paired_devices.refresh_token_hash`) and rate limiting (`rate_limit_buckets` INSERT … ON CONFLICT (key, window_start)) |
| `bnl_owner` | no | never by request code | owns every SECURITY DEFINER function (`search_path = pg_catalog, pg_temp`) |
| `anon`, `authenticated`, PUBLIC | n/a | n/a | nothing (SEC-005 test) |

How the context reaches the policies:

- `@bnl/db` opens a transaction and runs `SET LOCAL ROLE`.
- It then sets `bnl.household_id`, `bnl.device_id` and `bnl.actor_id` with `set_config(..., true)`.
- Policies read those settings through `bnl.current_household_id()`, `bnl.current_device_id()` and `bnl.current_actor_id()`.

Request code must go through `withDbContext` and must not touch the database any other way.

Workflow functions take an explicit `actor`:

- The actor must equal `bnl.actor_id` and must hold the required staff role.
- The fixed system actor (`bnl.system_actor_id()`) is accepted only from an operations session, meaning a login that is not a member of the app roles. Seeds use it.

### SQLSTATE contract (map in the BFF)

| Code | Meaning | API error |
|---|---|---|
| `42501` | privilege, RLS or role check failed | `forbidden` |
| `P0002` | target not found or not visible | `not_found` |
| `22023` | invalid input or content, or the manifest build failed | `validation_failed` |
| `55000` | wrong state: immutable version, completion revert, not approved | `conflict` |
| `23505` / `23503` | unique or foreign key | `conflict` / `not_found` |

### Key functions

| Function | Role | Notes |
|---|---|---|
| `transition_lesson_version(version_id, 'submit'\|'approve'\|'reject', actor, comment)` | staff | `submit` needs editor and valid content; `approve`/`reject` need reviewer and an actor who is not the author. `reject` returns the version to draft. Audited |
| `publish_lesson_version(lesson_id, version_id, reason, actor)` | staff (publisher) | One transaction: supersede, publication record, new manifest for the grade, audit |
| `unpublish_lesson(lesson_id, reason, actor)` / `pin_manifest(revision, actor)` / `refresh_manifest(grade, reason, actor)` | staff (publisher) | Pin makes the grade's live set equal the old revision and writes a new manifest with `pinned_from_revision` |
| `score_answer(attempt_id, question_version_key, selected_option_id[, response_ms])` | device | Returns `(correct, correct_option_id, already_answered)` and records the response. The device has no SELECT on `quiz_items` |
| `quiz_questions_for_version(version_id)` | device | Prompts and options without answer keys |
| `create_pairing_code`, `redeem_pairing`, `rotate_device_refresh` | public | `redeem_pairing` returns `pending`, `redeemed` (once), `invalid_secret` or `gone` |
| `approve_pairing(code_hash, household_id, label)`, `revoke_device(id)`, `create_household(label, tz)` | adult | Audited |
| `touch_device()` | device | Returns the current `token_version`, or null if the device is revoked |
| `rate_limit_hit(key, window_s, max)` | public, device, adult, staff | Fixed window. Hash IP and email keys before using them as bucket keys |
| `purge_expired(raw_days = 90, aggregate_days = 395)` | job | Retention, audited |

`audit_logs.actor_type` is set by a trigger from the request role (`bnl_device` → `device`,
`bnl_job` → `job`, adult/staff → `user`). Callers only supply `actor_auth_id`: the auth user id,
the device id, or null.

Manifest checksum: `checksum = sha256_hex((manifest - 'checksum')::text)`, which is the jsonb text
of the manifest without its own checksum field. The ETag is this checksum.

## Adding a table safely (checklist)

1. Create it in a **new** migration file (`000N_name.sql`). Never edit a migration that has
   already been applied anywhere except local dev.
2. Columns: `id uuid primary key default gen_random_uuid()`, `created_at` and `updated_at timestamptz not null default now()`.
   Household or child data also needs `household_id uuid not null references bnl.households(id)`
   plus composite foreign keys `(x_id, household_id)` to parent rows, so a row cannot point into another household.
3. Add `create trigger set_updated_at ... execute function bnl.tg_set_updated_at()`.
4. Run `alter table ... enable row level security; alter table ... force row level security;`.
   Then add `owner_all` (to `bnl_owner`) and, only if needed, `job_all` (to `bnl_job`).
5. GRANT exactly the privileges each request role needs, using column lists for anything sensitive.
   Write one policy per role, keyed on `bnl.current_*()` and the definer helpers. No grant means
   denied, and that is the default.
6. End the migration with the REVOKE sweep:
   `revoke all on all {tables,sequences,functions} in schema bnl from public, anon, authenticated;`.
   Schema-level default privileges cannot remove PUBLIC EXECUTE on functions.
7. SECURITY DEFINER functions need four things:
   - `owner to bnl_owner`
   - `set search_path = pg_catalog, pg_temp`
   - fully-qualified names
   - an explicit role or actor check, explicit `grant execute` to the intended roles, and an audit row for privileged actions
8. Add tests in `packages/db/test/integration`: at least one allowed path and one denied path per role
   that touches the table. SEC-005 already fails if RLS is not enabled and forced.
9. Audit `metadata` never contains names, answers, free text or tokens.

## Retention defaults (pending owner decision)

| Data | Default | Mechanism |
|---|---|---|
| Raw `learning_events` | 90 days (by `received_at`) | `bnl.purge_expired()` run daily as `bnl_job`, audited plus a `job_runs` row |
| Aggregates (`mastery_snapshots`, `recommendations`) | 395 days (13 months) | same |
| `idempotency_keys` | until `expires_at` (24 h default) | same |
| Pairing codes and rate-limit buckets | 1 day after expiry or window | same |

These match `.env.example` (`RETENTION_DAYS=90`, `AGGREGATE_RETENTION_DAYS=395`). The owner has
not confirmed them yet (spec §9).
