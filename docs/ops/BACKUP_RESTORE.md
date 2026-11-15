# Backup and restore (OPS-002)

## Production (owner, P7)

- **Supabase:** enable daily backups, and Point-in-Time Recovery if the plan allows it. Record the retention in
  `P7_OWNER_CHECKLIST.md`.
- **Additional logical backup** (weekly, and before every migration), taken with the migration login over the
  direct connection:
  ```sh
  pg_dump -Fc --no-password -d "$MIGRATION_DB_URL" -n bnl -f bnl-$(date -u +%F).dump
  ```
  - The dump contains child data. Store it encrypted, in owner-controlled storage only. Never put it in the repo,
    CI artifacts or chat.
  - Keep it no longer than the retention policy (`PRIVACY.md`). A restore must not resurrect telemetry that has
    already been purged; re-run `score-retention-purge.mjs` after any restore.
- **Storage bucket `school-syllabi`:** Supabase backups do not include Storage objects. Copy the bucket
  separately (e.g. `supabase storage cp -r`) if uploads must survive project loss.

## Restore procedure

1. Decide the data-loss window. A restore discards child progress written after the backup. Prefer leaving
   the data in place with flags off (`ROLLBACK.md` §4) unless the data is corrupted.
2. Restore into a **new** database or project first, never over the live one.
3. On a fresh cluster, create the cluster roles first. `0001_core.sql` does this idempotently, or use
   `pg_dumpall --roles-only` without passwords. Then run
   `pg_restore --exit-on-error -d <target> bnl.dump`.
4. Set a new `bnl_app` password, because dumps carry no role passwords.
5. Verify with the same checks as the rehearsal (below):
   - row counts;
   - RLS enabled+forced;
   - policies, ACLs and function owners identical;
   - a device context of household A sees only household A.
6. Switch `BNL_APP_DB_URL` / `BNL_JOB_DB_URL` to the restored database. Re-run the jobs for the affected days.

## Rehearsal (local, 2026-11-14)

`node scripts/ops/rehearse-backup-restore.mjs` runs inside the throwaway cluster of `scripts/db/test-db.mjs`
(migrated and seeded with SYNTHETIC data). It:
- dumps with `pg_dump -Fc` and checks that the archive's table of contents contains schema `bnl`, the policies and the ACLs;
- restores into the new database `bnl_restore_rehearsal`;
- compares a fingerprint of row counts per table, RLS flags, policies, table and column ACLs, function owners/ACLs/`search_path` and the schema ACL;
- checks RLS through the `bnl_app` login: household A's device sees only household A, and `bnl_app` without a request role is denied.

Evidence:

```
{"rehearsal":"backup_restore","ok":true,"source":"bnl_test","target":"bnl_restore_rehearsal","dump_bytes":373209,"tables":42,"rows":333,"policies":183,"functions":54,"dump_ms":102,"restore_ms":207}
```

Not rehearsed: Supabase PITR and restoring into a brand-new cluster without pre-existing roles (step 3 covers that path).
