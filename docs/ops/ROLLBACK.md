# Rollback (P6 gate `rollback_rehearsed`)

Principles:
- Restore the student bytes that TVs had before. Turn off the service worker first.
- Never destroy child data.
- The database is **forward-only**, with flags off.

Rehearsed locally with `scripts/ops/rehearse-rollback.mjs` (evidence in §6). Never against Vercel or the live site.

## 1. What "previous" means

| Layer | Rollback target | Where it is |
|---|---|---|
| Student bundle (`/`, `/index.html`, `/logo.webp`, `/music.wav`) | the live snapshot bytes from 2026-11-14 | `legacy/live-snapshot-2026-11-14/` (checked by `pnpm check:snapshot`) and the Vercel deployment id recorded in `P7_OWNER_CHECKLIST.md` |
| Admin/API | the previous READY Vercel deployment of the same project, or the legacy deployment, which has no `/admin` and no `/api` | Vercel dashboard, owner action |
| Database | **no down migration**. Keep the schema and data, turn the flags off | — |
| Content | pin the last good manifest revision (publish workflow `rollback pin`, OPS-003) | `/admin/lessons` |

## 2. Kill switch first: `FEATURE_STUDENT_SW=false`

The new bundle installs a service worker (`bnl-student-<build>` caches). If you roll back the bytes while that
worker is active, an **offline** TV can keep serving the new bundle from its cache. So:

1. Set `FEATURE_STUDENT_SW=false` in the environment and redeploy the current build.
2. `/api/v1/student/config` now returns `"service_worker": false`. On its next online launch every TV unregisters
   the worker and deletes its `bnl-student-*` caches. localStorage is not touched.
3. Wait for TVs to launch at least once (watch `MONITORING.md` → student config requests), then roll back the bytes.

If the current build cannot be deployed (for example, it is broken), skip to §3 with the **emergency `sw.js`**.

## 3. Roll the student bytes back

- **Preferred (owner):** in Vercel, promote the recorded previous production deployment (the legacy app). This
  restores the exact bytes in `legacy/live-snapshot-2026-11-14/`.
- **Emergency variant:** when the kill switch could not run first, deploy the legacy bytes **plus** the
  self-unregistering `/sw.js` from `apps/student/README.md` ("Emergency"). Browsers re-check the worker script on
  navigation, so the installed worker replaces itself, wipes `bnl-student-*` and unregisters. Keep this file for
  at least one release cycle.

On every TV, localStorage (`breaknlearn.profiles.v1`, legacy progress keys and the
`breaknlearn.legacy-backup.v1` backup) stays exactly as it was. The legacy app reads the same keys, so children
keep their profiles and progress. The new app only adds keys and never rewrites legacy keys (MIG-002/004).

## 4. Server side during a rollback

1. Turn off, in this order:
   - `FEATURE_STUDENT_PAIRED`, so TVs stop calling the API;
   - `FEATURE_TELEMETRY`, `FEATURE_ASSESSMENTS` (503 `feature_disabled`; device queues keep events and retry later, TEL-003);
   - `FEATURE_SCORES`, `FEATURE_CATALOG_API`, `FEATURE_PAIRING`.

   Note A9-OPS-01: the last three are not enforced yet.
2. Pause the jobs if their input is suspect. They are idempotent, so they can simply be re-run later (OPS-004).
3. **Do not** drop tables, run down migrations or restore a backup over live data unless the data itself is
   corrupted. If it is, follow `BACKUP_RESTORE.md` and understand the data-loss window first.
4. Content problem only: pin the previous manifest revision. Do not unpublish lessons that TVs have cached.

## 5. Roll forward

1. Fix the problem.
2. Redeploy the new build with `FEATURE_STUDENT_SW=true`.
3. Turn the flags back on in the `DEPLOYMENT_RUNBOOK.md` §8 order.

TVs pick up the new bundle on their next online launch. Storage written by the legacy app in the meantime is
migrated again, idempotently (MIG-004).

## 6. Rehearsal (local, 2026-11-14)

`node scripts/ops/rehearse-rollback.mjs` builds the app, then drives **one persistent Chromium profile** (like a
TV) on one origin through these phases:
- **CURRENT** (`next start`): bytes == build, the SW installs, a child plays;
- **KILL** (`FEATURE_STUDENT_SW=false`): the SW and its caches are gone, and only the student-config key changed;
- **ROLLBACK** (the snapshot bytes served on the same origin): every file is byte-identical to `legacy/live-snapshot-2026-11-14`, the legacy app runs, profiles Asha/Ravi are shown, and every localStorage key is preserved verbatim;
- **FORWARD**: the new bundle is back and storage is intact.

A second, independent profile rehearses the **emergency** path (legacy bytes + emergency `sw.js`, with no kill switch first).

Evidence: see the final line printed by the script; recorded result below.

```
PASS current: served bytes equal apps/student/dist
PASS current: two profiles render (Asha, Ravi)
PASS current: new bundle is running
PASS current: service worker registered ({"regs":1,"caches":1,"controlled":true})
PASS current: legacy backup taken before any write
PASS kill switch: FEATURE_STUDENT_SW=false unregisters the worker and wipes bnl-student-* caches ({"regs":0,"caches":0,"controlled":false})
PASS kill switch: only the cached server flags changed in storage
PASS rollback: every served file is byte-identical to legacy/live-snapshot-2026-11-14
PASS rollback: legacy app is running (inline script, no app.js)
PASS rollback: both profiles still present with the same names (Asha, Ravi)
PASS rollback: no localStorage key lost
PASS rollback: every non-profile key byte-identical (backup, flags, queues)
PASS rollback: breaknlearn.profiles.v1 content unchanged by the legacy app
PASS forward: served bytes equal the current build again
PASS forward: new bundle is running
PASS forward: profiles intact
PASS forward: legacy backup unchanged (never overwritten)
PASS emergency: current bundle with an active, controlling SW and a populated cache ({"regs":1,"caches":1,"controlled":true})
PASS emergency: legacy files byte-identical (plus only the emergency /sw.js)
PASS emergency: worker removed itself and its caches ({"regs":0,"caches":0,"controlled":true})
PASS emergency: legacy app running
PASS emergency: storage preserved
{"rehearsal":"rollback","ok":true,"port":3290,"steps":22,"failed":[],"duration_ms":28805}
```

Note: in the emergency path `controlled` stays `true` only for the already-open page. The registration count is 0, so the next navigation is uncontrolled.

Not rehearsed: a Vercel deployment promotion and a physical LG TV (owner/P7, `LG_TV_TEST_PLAN.md` step 9).
