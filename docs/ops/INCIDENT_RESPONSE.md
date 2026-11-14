# Incident response

Roles:
- **Owner**: the household/project owner. Decides on data restores, notifications and every deployment.
- **Operator**: whoever holds the Vercel/Supabase access the owner granted.

Keep a timeline from the first minute in a private incident note, never in a public issue. Use request ids and
UUIDs only, never child names.

## Severity

| Sev | Examples | Response |
|---|---|---|
| SEV-1 | one household can read or change another's data; admin data without a session; credential or service key leaked; draft or private upload publicly readable | immediately, any hour |
| SEV-2 | TVs cannot play lessons; progress lost or regressed; pairing broken; jobs writing wrong scores | same day |
| SEV-3 | analytics stale, single job failure, cosmetic admin bugs | next working day |

## First 30 minutes (any severity)

1. **Contain** with the least destructive lever:

   | Problem | Lever |
   |---|---|
   | Student app broken | `FEATURE_STUDENT_SW=false`, then roll the bytes back (`ROLLBACK.md` §2–3) |
   | API/data problem | turn the relevant `FEATURE_*` off (`ROLLBACK.md` §4) |
   | Admin portal exposure | promote the previous deployment |
   | Leaked `bnl_app` password | rotate it: `alter role bnl_app with password '<new>'`, then update `BNL_APP_DB_URL`/`BNL_JOB_DB_URL` and redeploy |
   | Leaked `DEVICE_TOKEN_SIGNING_SECRET` | rotate it; all TVs must re-pair |
   | Leaked service-role key | rotate it in Supabase, update Vercel |
   | Compromised device | revoke it in `/admin/devices`; it is refused on its next request (SEC-004) |
   | Compromised adult account | revoke the membership or staff role row and reset the password in Supabase Auth |

2. **Preserve evidence:**
   - export the Vercel logs for the window;
   - `select * from bnl.audit_logs where created_at > '<start>'`;
   - `job_runs`.

   Do not delete rows that show the problem.
3. **Assess scope** with UUIDs: which households, learners and devices. Use the audit log and `learning_events.device_id`.
4. **Tell the owner.** For SEV-1 involving child data, the owner decides on notifying guardians and any legal
   reporting duty. That obligation is not decided in this repo and must be confirmed by the owner (`PRIVACY.md`).

## Playbooks

- **Cross-household access (SEV-1):**
  - turn off the feature that exposes it;
  - add a failing test that reproduces it (`packages/db/test/integration/redteam-*.test.ts` or `apps/admin/test/integration/redteam-routes.test.ts`);
  - fix it with a forward migration or code change;
  - re-run the full red-team suites before turning the flag back on.
- **Bad publish:**
  - pin the previous manifest revision (OPS-003);
  - TVs keep the last valid cached catalog (CAT-008).
- **Telemetry flood or garbage:**
  - `FEATURE_TELEMETRY=false`. TVs queue locally with bounded storage (TEL-003);
  - later ingestion is idempotent by `event_id` (TEL-001).
- **Wrong scores:**
  - pause `score-learners`;
  - fix it, then re-run for the affected as-of days. Snapshots are replaced per (learner, lesson, day, weights version) and historical versions are not mutated (ELS-008).
- **Data corruption:** `BACKUP_RESTORE.md`. Restore into a new database first and agree the data-loss window with the owner.
- **Lost TV progress after a rollback:** the device keeps `breaknlearn.legacy-backup.v1` (written on the first launch of the new app). Restore it from the device's localStorage with owner guidance. Never overwrite newer progress (MIG-004).

## Afterwards

- Write a blameless post-incident note: timeline, root cause, affected UUID counts, the fix, and which test now covers it.
- If the fix touched access control, add or extend a red-team test and update `docs/security/SECURITY_REVIEW.md`.
