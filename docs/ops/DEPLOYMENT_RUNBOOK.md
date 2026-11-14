# Deployment runbook (P7, owner-gated)

This runbook has **not** been executed. In P6 nothing was deployed, and no Vercel or Supabase API was called.
Every step below needs the owner's written approval (`P7_OWNER_CHECKLIST.md`). It is based on
`docs/handoff/operations/DEPLOYMENT_AND_MAINTENANCE.md`, ADR-0005 (database access) and ADR-0006 (one origin).

Topology (ADR-0006): one Next.js app, `apps/admin`. It serves:
- `/`: the student TV bundle, copied into `public/` at build time;
- `/admin/**`: the adult portal;
- `/api/v1/**`: the BFF.

It is backed by one Supabase project (Postgres schema `bnl`, Auth, one private Storage bucket).

## 0. Preconditions

- [ ] P6 gate green on the release commit:
  - `pnpm lint`, `typecheck`, `test`, `test:integration`, `build`, `--filter @bnl/admin test:served`, `test:e2e`;
  - `node tests/fullstack/run.mjs`;
  - both rehearsals (`scripts/ops/`).
- [ ] The current production deployment id of the existing student project has been **recorded** (the rollback target, `ROLLBACK.md` §1), and `legacy/live-snapshot-2026-11-14` matches it (`pnpm check:snapshot`).
- [ ] A staging Supabase project and a separate Vercel preview environment exist. They hold no real child data.
- [ ] LG TV checklist (`LG_TV_TEST_PLAN.md`) has passed against **staging**.

## 1. Supabase project

1. Create the project in the agreed region. Enable Point-in-Time Recovery or daily backups (`BACKUP_RESTORE.md`).
2. Auth:
   - turn email sign-in on;
   - turn public sign-ups **off** (invite only);
   - set the site URL to the production origin and the redirect URL to `<origin>/admin/**`.
3. API settings:
   - do **not** add `bnl` to the exposed schemas;
   - `anon` and `authenticated` get no grants on `bnl` (the migrations revoke them and `redteam-schema.test.ts` proves it).
4. Record the following in the secret store only, never in the repo, chat or tickets:
   - project URL;
   - anon key;
   - service-role key;
   - JWT secret (or rely on JWKS);
   - the direct (session-mode) database URL for migrations.

## 2. Migrations, in order, with the migration login

Run them with the project's `postgres` login over the **direct** connection, not the transaction pooler. All of
them must succeed. They are idempotent at cluster level and **forward-only**: there is no down migration (ADR-0005).

```sh
export MIGRATION_DB_URL='<direct postgres URL from the secret store>'
for f in supabase/migrations/000{1,2,3,4,5,6,7}_*.sql; do
  psql "$MIGRATION_DB_URL" -X -v ON_ERROR_STOP=1 -1 -f "$f" || break
done
```

| # | File | What it adds |
|---|---|---|
| 1 | `0001_core.sql` | roles (`bnl_public/device/adult/staff/job/owner`, login `bnl_app` NOINHERIT), schema, tables, constraints |
| 2 | `0002_rls.sql` | grants, access helpers, RLS ENABLE + FORCE on every table, policies |
| 3 | `0003_functions.sql` | workflow, publish/manifest, scoring, pairing, rate limit, retention functions (SECURITY DEFINER, owner `bnl_owner`) |
| 4 | `0004_curriculum_imports.sql` | import/mapping guards |
| 5 | `0005_content_item_bank.sql` | item-bank generation |
| 6 | `0006_assessments.sql` | assessment guards |
| 7 | `0007_analytics.sql` | analytics purge and scoring support |

Then load the **core** seeds only:
- `supabase/seed/0001_curriculum.sql`;
- `supabase/seed/0002_multiplication_lessons.sql` (the ten live ×1–×10 lessons and their manifests).

**Never** load `dev_synthetic.sql` into staging or production.

Verify:
- run `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'bnl' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`. It must return 0;
- run the queries of `packages/db/test/integration/redteam-schema.test.ts` (PUBLIC/anon ACL sweep). Each must return no rows.

## 3. Database logins

| Login | Used by | Setup |
|---|---|---|
| `postgres` (Supabase) | migrations and the operator procedures in `scripts/ops/sql/` only | never configured in Vercel |
| `bnl_app` | request path (`BNL_APP_DB_URL`) **and** jobs (`BNL_JOB_DB_URL`) | `alter role bnl_app with password '<generated, ≥32 random bytes>'`. It holds no privileges of its own and must `SET LOCAL ROLE` (`@bnl/db withDbContext`) |

- Use the **transaction pooler** URL for `bnl_app` from Vercel functions, and set `BNL_DB_PREPARE=false`.
- Keep `BNL_DB_POOL_MAX` small (5).
- Residual risk R1 (`SECURITY_REVIEW.md`): anyone holding the `bnl_app` password can `SET ROLE bnl_job`. Keep it in the Vercel secret store only, and rotate it after any suspected leak.

## 4. Storage

- Create **one private** bucket, `school-syllabi`:
  - no public access;
  - file size limit = `IMPORT_MAX_MB` (20 MB);
  - allowed MIME types: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/csv`, `text/plain` (the BFF also sniffs the content).
- Add no Storage RLS policies for `anon`/`authenticated`. Only the BFF touches it, with the service-role key, and it hands out 60-second signed URLs after its own household check.
- Object keys are `<household_id>/<uuid>`. The DB enforces this with a check constraint.
- Manual check after creation: an unauthenticated `GET <SUPABASE_URL>/storage/v1/object/public/school-syllabi/<any>` returns 400/404, and a signed URL expires after 60 s (SEC-007).

## 5. First owner and household

1. Invite the owner's admin email through Supabase Auth, with no default password. The email comes from the owner checklist.
2. After the owner's first sign-in, create the household and the owner membership as one audited operation, using the migration login:
   ```sql
   begin;
   set local role bnl_owner;
   select set_config('bnl.actor_id', '<auth user id of the owner>', true);
   select bnl.create_household('<household label, no child names>', 'Asia/Kolkata');
   commit;
   ```
3. The owner records consent in the portal (`POST /api/v1/admin/consent`), then creates child profiles (`/admin/children`).
4. Staff roles (editor/reviewer/publisher/analyst) are rows in `bnl.staff_roles`. Grant them only on written request, and never to the household owner by default (ADR-0003).

## 6. Vercel environment (per `.env.example`)

Set the variables separately for each environment (Preview = staging Supabase, Production = production Supabase).
Server-only values must never be `NEXT_PUBLIC_`.

| Variable | Production value |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | from §1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from §1. Server only (Storage) |
| `SUPABASE_JWT_SECRET` | optional. Empty means JWKS |
| `APP_ORIGIN`, `ADMIN_ORIGIN` | the production origin (same value, ADR-0006). The Origin/CSRF check depends on it |
| `DEVICE_TOKEN_SIGNING_SECRET` | ≥32 random bytes, base64, unique per environment. Rotating it signs every TV out (they re-pair) |
| `BNL_APP_DB_URL`, `BNL_JOB_DB_URL` | `bnl_app` pooler URL from §3 |
| `BNL_DB_PREPARE`, `BNL_DB_POOL_MAX` | `false`, `5` |
| `BNL_STORAGE_DRIVER` | `supabase` |
| `BNL_LOCAL_STORAGE_DIR`, `BNL_ALLOW_LOCAL_STORAGE` | unset / `false` |
| `BNL_DEV_AUTH`, `BNL_DEV_AUTH_PASSWORD` | `false` / unset. Dev auth is refused when `NODE_ENV` or `VERCEL_ENV` is `production` anyway |
| `IMPORT_MAX_MB`, `IMPORT_SIGNED_URL_TTL_SECONDS`, `IMPORT_SUGGEST_THRESHOLD`, `TELEMETRY_BATCH_MAX` | `20`, `60`, `0.2`, `100` |
| `RETENTION_RAW_TELEMETRY_DAYS`, `RETENTION_AGGREGATE_DAYS` | `90`, `395` **pending owner confirmation** (`PRIVACY.md`) |
| `HOUSEHOLD_DEFAULT_TZ` | `Asia/Kolkata` |
| `FEATURE_*` | all `false` at first deploy, except `FEATURE_STUDENT_SW=true`; see §8 |

## 7. Jobs

The jobs are one-shot Node CLIs that print one JSON line, exit 1 on failure and run as `bnl_job` through `bnl_app`.
Schedule them on a runner that has the repo checked out and `pnpm install` done, with `BNL_JOB_DB_URL` set. Use
GitHub Actions `schedule` or another scheduler the owner approves. Vercel Cron cannot run them as they are, because they are scripts, not routes.

| When (UTC) | Command | Notes |
|---|---|---|
| nightly 00:30 | `node scripts/jobs/aggregate-sessions.mjs` (defaults to yesterday) | must finish before scoring |
| nightly 01:30, after aggregation succeeds | `node scripts/jobs/score-learners.mjs` (defaults to yesterday) | idempotent per (learner, lesson, as-of, weights) |
| daily 02:30 | `node scripts/jobs/score-retention-purge.mjs` | raw telemetry > 90 d, aggregates > 395 d |

- Re-running any job for the same day is safe (OPS-004).
- Alert when a job exits non-zero or misses a run (`MONITORING.md`).

## 8. Feature-flag rollout order

Change one flag at a time. Redeploy (flags are read from the environment) and watch `MONITORING.md` for at least
24 h before the next step. To roll back, set the flag to `false` again.

1. **Deploy with all flags off.** The admin portal is behind auth. The student bundle at `/` must be byte-identical to the live app (`pnpm --filter @bnl/admin test:served`), and `/api/v1/student/config` reports `paired: false`, so every TV behaves exactly as today.
2. `FEATURE_PAIRING=true`. Note: today this flag is **not enforced** (A9-OPS-01); pairing is reachable whenever `FEATURE_STUDENT_PAIRED` is on. Apply the proposal fix first, or treat steps 2 and 3 as one step.
3. `FEATURE_STUDENT_PAIRED=true`. TVs show "Family account". Pair **one** owner TV, link explorers, and confirm the legacy import (no lost ×3 records, MIG-002).
4. `FEATURE_TELEMETRY=true`. Watch the ingest rejection and duplicate ratios. Enable the nightly aggregation.
5. `FEATURE_ASSESSMENTS=true`. Watch the server-scored quiz flow.
6. `FEATURE_SCORES=true` plus the scoring job. Same caveat as step 2: the flag is not enforced today, so the analytics page is visible to adults as soon as it is deployed. Scores stay empty until the job runs.
7. `FEATURE_CATALOG_API=true` (content publishing to TVs). Not enforced today (A9-OPS-01).
8. `FEATURE_STUDENT_SW` stays `true`. Set it to `false` only as the kill switch (`ROLLBACK.md` §2).

## 9. Post-deploy smoke (each step)

- `/` bytes are unchanged against the snapshot (until a new student release is approved).
- `/admin` without a session redirects to login. `/api/v1/admin/*` returns 401.
- `Cache-Control: no-store` on `/admin/**` and `/api/**`.
- Run one paired-TV lesson, then check that the event appears for that household only.
