# Deployment, upgrade, monitoring and rollback runbook

## Environments
- `local`: local Supabase/Postgres and API; fake users and synthetic quiz events only.
- `staging`: separate Supabase project, separate Vercel preview; staging data must not contain real child records copied from production.
- `production`: existing student Vercel project, production Supabase; separate admin route with adult authentication; manual owner-gated activation.

## Before deployment
1. Obtain authorized repository access, identify actual Vercel project, export current deployment manifest and snapshot baseline tests.
2. Create dev/stage/prod Supabase projects with correct region, billing and backup settings; select short-lived production session secrets. Ensure app uses runtime environment variables, not baked keys.
3. Run migrations in staging via CI. Verify `bnl` schema grants + RLS, Storage policy tests, hidden admin route, telemetry scope. Create adult owner via invite (NOT hardcoded default password).
4. Import verified curriculum source metadata and editorial seed with `unverified` flag. Publish only multiplication tables 1..10 (under Grade 2 Math) after content verification. Leave all other lesson nodes draft. Validate a manifest diff before release.
5. Run Playwright and SQL tests; run actual LG TV manual checklist with browser/TV version. Run offline restore tests.

## Deploy
1. Deploy API and admin behind auth first, with feature flags off.
2. Activate paired-device endpoints and test with synthetic profiles; verify no anonymous read of child data.
3. Roll out student app in compatibility mode with localStorage migration adapter. Do not immediately purge local state; keep client backup for 30 days after verified mapping.
4. Pair actual household TV only after owner approves; confirm profile mapping and independent progress and no lost ×3 records.
5. Activate telemetry, then scores/reporting, then content publishing. Check data quality after each flag.

## Rollback
- Stop new CMS publishes and pin last known good content manifest.
- Revert student Vercel production alias/deployment to previous READY deployment. Preserve backend event and progress tables; no destructive down-migration during incident.
- Disable telemetry ingest with feature flag if needed; local queue buffers pending records.
- Restore DB only after verifying backup and understanding data-loss window; do not overwrite post-backup child progress casually.
- Record ADR/incident, repro, affected learners and remediation.

## Operational cadence
- Daily: check ingest failures, aggregation latency, sync queue errors, storage quotas and backups.
- Weekly: curriculum/mapping approvals, unpublished drafts, editor audit trail, confidence warnings, rights review.
- Monthly: dependency patch/security scan, review access roles, test offline compatibility, validate metric definitions.
- Quarterly: database restore rehearsal, data-retention purge confirmation, device token rotation rehearsal.
- Annually: revise curriculum source versions, review consent/privacy/child-safety obligations and scoring fairness.

## Dashboards/alerts
- 5xx and p95 latency by route, publish/rollback errors, import worker failures, raw telemetry duplicate/rejection ratios, backend sync age p95, queued event age, ELS coverage, DB growth and backup age.
- Never log child first names or answer text; only pseudonymous UUIDs and aggregated counts, redacted audit.
- High-severity alert: cross-household access, unauthenticated admin, draft leak, suspicious authentication activity.

## Owner-provisioned values
- `SUPABASE_URL`, anon key, server-only service-role key, database migration URL, adult admin email, private storage buckets, configured domains, privacy retention/consent policy, whether project should accept external households.
- Store values in Vercel/Supabase secrets, not in the repository, PDF, issue tracker or chat.

## Source verification
- Official CISCE primary: https://cisce.org/wp-content/uploads/2025/03/PrimaryCurriculum.pdf
- Official CISCE upper-primary: https://cisce.org/wp-content/uploads/2025/03/UpperPrimary.pdf
- Supabase RLS/grants: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase API: https://supabase.com/docs/guides/api/securing-your-api
- Vercel project/alias: retrieve actual IDs via connected Vercel project, do not guess DNS ownership.
