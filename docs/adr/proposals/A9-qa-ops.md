# A9 (QA, Ops & Privacy) proposals for the lead — P6

A9 owns no root files, CI, app source or migrations. Each change below is proposed with an exact diff.
They are ordered by priority, and none of them has been applied in `p6/qa-ops`.

| # | Change | Why | Priority |
|---|---|---|---|
| 1 | Migration `0008_pairing_device_household.sql` | Fixes A9-SEC-01 below the BFF | **before P7** |
| 2 | Enforce `FEATURE_PAIRING`, `FEATURE_CATALOG_API`, `FEATURE_SCORES` | A9-OPS-01: three documented kill switches do nothing | **before P7** |
| 3 | CI jobs: full-stack E2E and both rehearsals | Keep the P6 gate green automatically | high |
| 4 | Root scripts | Discoverability | medium |
| 5 | `axe-core` dev dependency | Replace the focused checker with the standard engine | medium |
| 6 | `IMPLEMENTATION_STATUS.md` correction | It claims the catalog is behind `FEATURE_CATALOG_API` | medium |
| 7 | Privacy follow-ups (consent gating, export/delete API, audit retention) | OPS-005 and consent gaps | before external households |

---

## 1. Migration 0008: bind a pairing code's device to its household (A9-SEC-01)

**Verified:**
- Applied twice to the harness DBs: it is idempotent.
- `packages/db` integration run: 102 passed. The single failure was the `it.fails` A9-SEC-01 test, which **now passes**. Remove `.fails` when this lands.
- `apps/admin` integration run: 78/78 (`redteam-routes.test.ts` accepts both states).

New file `supabase/migrations/0008_pairing_device_household.sql`. This is the exact file that was verified; the only
functional change against `0003_functions.sql` is `and pd.household_id = c.household_id` in the device update:

```sql
-- BreakNLearn 0008: bind a pairing code's device to the code's household (A9-SEC-01). Forward-only, idempotent.
-- 1. Composite FK: a claimed code can only point at a device of the SAME household (paired_devices has unique (id, household_id)).
alter table bnl.device_pairing_codes drop constraint if exists device_pairing_codes_device_id_fkey;
alter table bnl.device_pairing_codes drop constraint if exists device_pairing_codes_device_household_fkey;
alter table bnl.device_pairing_codes add constraint device_pairing_codes_device_household_fkey
  foreign key (device_id, household_id) references bnl.paired_devices (id, household_id) on delete cascade;

-- 2. Defence in depth inside the SECURITY DEFINER redeem: never touch a device of another household.
create or replace function bnl.redeem_pairing(p_pairing_id uuid, p_poll_secret_hash text, p_refresh_token_hash text)
returns table (status text, device_id uuid, household_id uuid, token_version integer)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  c bnl.device_pairing_codes;
  v_version integer;
begin
  select * into c from bnl.device_pairing_codes dpc where dpc.pairing_id = p_pairing_id for update;
  if not found or c.redeemed_at is not null or c.failed_attempts >= 5 then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.poll_secret_hash <> p_poll_secret_hash then
    update bnl.device_pairing_codes set failed_attempts = failed_attempts + 1 where id = c.id;
    return query select 'invalid_secret'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  if c.approved_at is null then
    if c.expires_at <= now() then
      return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    else
      return query select 'pending'::text, null::uuid, null::uuid, null::integer;
    end if;
    return;
  end if;
  if c.expires_at <= now() and c.approved_at <= now() - interval '10 minutes' then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.paired_devices pd set refresh_token_hash = p_refresh_token_hash, refresh_rotated_at = now()
    where pd.id = c.device_id and pd.household_id = c.household_id and pd.revoked_at is null
    returning pd.token_version into v_version;
  if v_version is null then
    return query select 'gone'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;
  update bnl.device_pairing_codes set redeemed_at = now() where id = c.id;
  perform bnl._audit('device', c.device_id, c.household_id, 'device.paired', 'paired_device', c.device_id, '{}'::jsonb);
  return query select 'redeemed'::text, c.device_id, c.household_id, v_version;
end
$$;
```

`CREATE OR REPLACE` keeps the owner (`bnl_owner`) and the reviewed EXECUTE grants, so
`redteam-schema.test.ts` › "EXECUTE on every SECURITY DEFINER function matches the reviewed matrix" stays green.

Follow-up in `packages/db/test/integration/redteam-tenancy.test.ts`:

```diff
-  it.fails("A9-SEC-01: an adult cannot claim a pending code for a device of another household", async () => {
+  it("A9-SEC-01: an adult cannot claim a pending code for a device of another household", async () => {
```

## 2. Enforce the remaining feature flags (A9-OPS-01)

`.env.example` documents `FEATURE_PAIRING`, `FEATURE_CATALOG_API` and `FEATURE_SCORES` as "off until their
milestone passes its gate", but no server code reads them. `apps/admin/test/redteam/static-guards.test.ts` holds three
`it.fails` cases that turn green when this lands. Remove the `.fails` then.

New file `apps/admin/src/server/flags.ts`:

```ts
import { HttpError } from "@bnl/auth";

export type FeatureFlag = "FEATURE_PAIRING" | "FEATURE_CATALOG_API" | "FEATURE_SCORES";

/** A flag is on only when exactly "true"; unset or a typo keeps the feature off (same rule as telemetry/assessments). */
export function featureEnabled(flag: FeatureFlag, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[flag] === "true";
}

export function requireFeature(flag: FeatureFlag, what: string): void {
  if (!featureEnabled(flag)) throw new HttpError(503, "feature_disabled", `${what} is not enabled`);
}
```

`apps/admin/src/server/handlers/pairing.ts`:

```diff
+import { requireFeature } from "../flags";
 export async function createPairingCodeHandler(req: Request, c: Ctx): Promise<Response> {
+  requireFeature("FEATURE_PAIRING", "Pairing");
   await enforceRateLimit(c, "pairingCodeByIp", clientIp(req));
 export async function approvePairingHandler(req: Request, c: Ctx): Promise<Response> {
+  requireFeature("FEATURE_PAIRING", "Pairing");
   const adult = await requireAdult(req, c);
 export async function redeemTokenHandler(req: Request, c: Ctx): Promise<Response> {
+  requireFeature("FEATURE_PAIRING", "Pairing");
   await enforceRateLimit(c, "tokenPollByIp", clientIp(req));
```

Do **not** gate `refreshTokenHandler` or device revoke. Turning pairing off must not sign out TVs that are
already paired, and a guardian must always be able to revoke one.

`apps/admin/src/server/content/catalog.ts` (the TV keeps its built-in tables on any non-200, CAT-008):

```diff
+import { requireFeature } from "../flags";
 export async function catalogManifestHandler(req: Request, c: Ctx): Promise<Response> {
+  requireFeature("FEATURE_CATALOG_API", "Catalog API");
   const raw = new URL(req.url).searchParams.get("grade");
 export async function catalogLessonHandler(req: Request, c: Ctx, lessonIdParam: string): Promise<Response> {
+  requireFeature("FEATURE_CATALOG_API", "Catalog API");
   const id = Uuid.safeParse(lessonIdParam);
```

`apps/admin/src/server/analytics/handlers.ts` (`summaryHandler`, `learningScoresHandler`,
`listRecommendationsHandler`, `dismissRecommendationHandler`):

```diff
+import { requireFeature } from "../flags";
 export async function summaryHandler(req: Request, c: Ctx): Promise<Response> {
+  requireFeature("FEATURE_SCORES", "Learning scores");
   const adult = await requireAdult(req, c);
 (same one-line insertion as the first statement of the other three handlers)
```

The `/admin/analytics` page should render "Learning scores are not enabled yet" when `featureEnabled("FEATURE_SCORES")` is false. A5/A8 own the page. The scoring job does not depend on the flag.

The test fallout is mechanical:
- `apps/admin/test/pairing-flow.test.ts`, the catalog tests, `apps/admin/test/analytics/*` and the integration tests that call these handlers need `vi.stubEnv("FEATURE_PAIRING" | "FEATURE_CATALOG_API" | "FEATURE_SCORES", "true")` in `beforeEach`;
- add one test per flag asserting 503 `feature_disabled` when it is unset;
- `tests/fullstack/playwright.config.ts` already sets every flag to `true`.

## 3. CI (`.github/workflows/ci.yml`)

```diff
   integration:
     runs-on: ubuntu-24.04
     steps:
       ...
       - run: pnpm test:integration
+      - run: node scripts/ops/rehearse-backup-restore.mjs
+  fullstack:
+    runs-on: ubuntu-24.04
+    steps:
+      - uses: actions/checkout@v4
+      - uses: pnpm/action-setup@v4
+      - uses: actions/setup-node@v4
+        with: { node-version: 22, cache: pnpm }
+      - run: pnpm install --frozen-lockfile
+      - run: pnpm exec playwright install --with-deps chromium
+      - run: pnpm build
+      - run: node tests/fullstack/run.mjs --trace off
+      - run: node scripts/ops/rehearse-rollback.mjs --skip-build
```

All three commands generate their own throwaway secrets, use only `127.0.0.1` and SYNTHETIC data, and never contact Vercel or Supabase.
The preview-deploy part of OPS-002 remains owner-gated (P7) and is not proposed here.

## 4. Root `package.json` scripts

```diff
     "check:snapshot": "node scripts/check-legacy-snapshot.mjs",
-    "build:student": "pnpm --filter @bnl/student build"
+    "build:student": "pnpm --filter @bnl/student build",
+    "test:fullstack": "node tests/fullstack/run.mjs",
+    "rehearse:rollback": "node scripts/ops/rehearse-rollback.mjs",
+    "rehearse:backup": "node scripts/ops/rehearse-backup-restore.mjs"
```

## 5. `axe-core` for the accessibility suites

axe-core is not installed, so `tests/a11y/checks.ts` implements focused WCAG 2.1 A/AA checks and self-tests them.
Proposed:

```diff
   "devDependencies": {
     "@eslint/js": "9.37.0",
     "@playwright/test": "1.63.0",
+    "axe-core": "4.10.3",
```

Then `tests/fullstack/02-admin-a11y.spec.ts` and `tests/e2e/a11y-tv.spec.ts` can inject `axe-core/axe.min.js` with
`page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })` and assert
`(await page.evaluate(() => axe.run())).violations` is empty. Keep the TV contrast exemption (byte-for-byte live design) as an axe rule override.

## 6. `IMPLEMENTATION_STATUS.md`

```diff
-| P2 | ... | ✅ ready for review (catalog API behind `FEATURE_CATALOG_API`) | `p2/content-pipeline` |
+| P2 | ... | ✅ ready for review (catalog API public; `FEATURE_CATALOG_API` enforced only after A9 proposal §2) | `p2/content-pipeline` |
+| P6 | QA/ops/privacy: red team, full-stack E2E, a11y, runbooks, rollback + restore rehearsals | ✅ ready for review (findings A9-SEC-01, A9-OPS-01 open) | `p6/qa-ops` |
```

## 7. Privacy follow-ups (design, not diffs)

1. **Consent gating:**
   - telemetry ingest, assessment start and upload creation return 403 `consent_required` unless the household has an unrevoked `consent_records` row for the matching scope (`telemetry`, `learning_data`, `school_uploads`);
   - put it in `withAdultHousehold` / the device context lookup as one indexed query.
2. **OPS-005 self-service:**
   - `POST /api/v1/admin/privacy/deletion-requests` (owner only, CSRF, audited);
   - a `process-deletion-requests` job that runs the logic of `scripts/ops/sql/process-deletion-request.sql` as a SECURITY DEFINER function executable by `bnl_job` only, plus Storage object removal;
   - `GET /api/v1/admin/privacy/export` (owner only, `no-store`), returning the household's rows as JSON with no other household's ids;
   - `packages/db/test/integration/redteam-deletion.test.ts` already pins the expected deletion semantics.
3. **Audit log retention:** add `delete from bnl.audit_logs where created_at < now() - make_interval(days => p_aggregate_days)` to `bnl.purge_expired_analytics`, or a separate owner-chosen period.
4. **Storage cleanup:** after a household delete, remove `<household_id>/` objects from `school-syllabi`.
