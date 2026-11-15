# Security review: P6 (A9)

- Scope: `p6/qa-ops` (P0–P5 integrated). Code reviewed plus automated red-team suites, run on 2026-11-14.
- Method: threat model → attacker matrix → executable tests against the real schema, RLS and roles
  (`scripts/db/test-db.mjs`) and against the real route handlers and the built `next start` server.
- Not covered:
  - Supabase-hosted configuration (Auth settings, Storage bucket policy, network);
  - Vercel configuration;
  - physical TVs.

These are owner/P7 checks (`docs/ops/DEPLOYMENT_RUNBOOK.md`, `P7_OWNER_CHECKLIST.md`).

## 1. Threat model

**Assets:**
- child display names, grades and avatars;
- learning activity, answers and scores (child, pseudonymous);
- private school syllabus uploads;
- guardian accounts;
- device credentials;
- the content pipeline (the integrity of what children see);
- the student bundle bytes on family TVs.

**Actors:**

| Actor | Capability assumed |
|---|---|
| Anonymous internet | any HTTP request to `/`, `/api/v1/*`, `/admin/*`; brute force |
| Outsider adult | valid Supabase account, no household |
| Adult of household Y (owner/guardian) | valid session, CSRF token; tries household X's ids (IDOR) |
| TV of household Y | valid device JWT; forges ids and claims in the body |
| Revoked TV of household X | an old access/refresh token |
| Token forger | crafts JWTs: wrong key, `alg=none`, swapped `hid`, wrong audience/scope, expired, future `ver`, dev-session key |
| Staff (editor/reviewer/publisher/analyst) | content roles; must never see child rows (ADR-0003, SEC-010) |
| SQL-level attacker | can execute SQL as the request login inside a request context (e.g. a future injection); tries role switches, setting rewrites and SECURITY DEFINER functions with foreign ids |
| Operator mistakes | deploying with dev auth, wrong flags, rollback leaving a stale service worker |

**Trust boundaries:**
1. Browser/TV → BFF (`/api/v1`). Authentication is a cookie session + CSRF/Origin, or a device bearer JWT.
2. BFF → Postgres. Requests use the single NOINHERIT login `bnl_app`, then `SET LOCAL ROLE` to a request role, with `bnl.household_id`, `bnl.device_id` and `bnl.actor_id` settings. RLS is enabled and forced on all 42 tables.
3. BFF → Storage (service key, signed URLs with a 60 s TTL).
4. Jobs → Postgres (`bnl_job` via `bnl_app`).
5. Deployment → TV (service worker, kill switch).

## 2. What was tested

| Suite | Tests | Result |
|---|---|---|
| `packages/db/test/integration/redteam-tenancy.test.ts` | 38 | pass. Includes 1 `it.fails` documenting A9-SEC-01 |
| `packages/db/test/integration/redteam-schema.test.ts` | 15 | pass |
| `packages/db/test/integration/redteam-deletion.test.ts` | 6 | pass |
| `apps/admin/test/integration/redteam-routes.test.ts` | 8 | pass |
| `apps/admin/test/redteam/static-guards.test.ts` | 13 | pass. Includes 3 `it.fails` documenting A9-OPS-01 |
| `tests/fullstack/02-admin-a11y.spec.ts` › SEC-009 | 1 | pass: 401×5 then 429 on the real build |

What the suites cover:
- **Tenancy:**
  - 12 attackers × 24 household tables × {filtered select, unfiltered select, update, delete} on household X;
  - forged inserts claiming X;
  - guardian escalation and owner self-lockout;
  - staff and ops tables;
  - every household-relevant SECURITY DEFINER function called with X's ids (`score_answer`, `quiz_questions_for_version`, `revoke_device`, `approve_pairing`, `rotate_device_refresh`, `redeem_pairing`, job and staff functions, actor impersonation).
- **Role switches:**
  - a request context cannot become `bnl_owner`, `postgres`, `anon` or another login;
  - device→adult and adult→staff switches carry no identity;
  - rewriting the device's own settings to another household yields nothing.

  Positive controls prove that the fixtures are real (X's owner and device see their rows), and a sanity run with X's own owner as the "attacker" fails, so the matrix is not vacuous.
- **Schema:**
  - RLS is enabled and forced on all 42 tables, and every table has a policy;
  - no policy targets PUBLIC;
  - PUBLIC/anon/authenticated hold no privilege on the schema, tables, columns, sequences, functions, types or default ACLs;
  - nothing exists outside `bnl`;
  - `bnl_app` holds no direct privilege;
  - every permissive request-role policy on a household table scopes by household, device or actor;
  - snapshots of table privileges and SECURITY DEFINER EXECUTE grants;
  - no TRUNCATE, REFERENCES or TRIGGER;
  - token columns are unreadable by adults.
- **Routes:**
  - every device route attacked with:
    - Y's TV;
    - X's revoked TV;
    - a `hid` swap;
    - a wrong key;
    - `alg=none`;
    - the dev-session key;
    - an expired token;
    - a future `ver`;
    - `scope=adult`;
  - every adult `[id]` route (analytics, recommendations dismiss, device revoke, import job/file/review, local-object signed URL) attacked with Y's owner, an outsider, a device token used as a cookie and a garbage session;
  - listings leak nothing of X, and X's database snapshot is unchanged afterwards;
  - staff routes refuse a household owner;
  - the catalog never serves a draft;
  - pairing brute force burns the code.
- **Static guards:**
  - every `.unsafe()` takes an interpolation-free constant;
  - there are no embedded JWTs, private keys or service keys;
  - `.env.example` holds placeholders only;
  - the student source references no server env names;
  - every documented flag is read by server code.

## 3. Findings

| ID | Severity | Status | Summary |
|---|---|---|---|
| A9-SEC-01 | **Medium** (defence in depth; not reachable through the API) | **Open**: fix in proposal §1, verified | Pairing claim can point at another household's TV at SQL level |
| A9-OPS-01 | **Medium** (rollout safety) | **Open**: fix in proposal §2 | `FEATURE_PAIRING`, `FEATURE_CATALOG_API` and `FEATURE_SCORES` are not enforced |
| A9-PRIV-01 | Medium (compliance) | Open, owner decision | Consent is recorded but never checked; there is no export/delete API (OPS-005 partial) |
| A9-A11Y-01 | Low | Accepted (parity) | TV subjects screen skips a heading level (h1→h3); kept byte-for-byte with the live app |

### A9-SEC-01: pairing code can be bound to another household's device (SQL level)

- `bnl.device_pairing_codes.device_id` references `paired_devices(id)` only.
- The `adult_claim` RLS policy checks `household_id in adult_household_ids()` but not that `device_id` belongs to that household.
- `bnl.redeem_pairing` (executable by `bnl_public`) then installs the refresh-token hash on `c.device_id` without comparing households, and `bnl.rotate_device_refresh` mints credentials for the **foreign** household.

**Reachability today:**
- The approve handler only ever creates a fresh device in the caller's household (`bnl.approve_pairing`).
- The HTTP redeem handler re-checks `device.household_id === code.household_id` and answers 410.

So exploiting it needs SQL execution as `bnl_adult` (see residual R1). It is proven in
`redteam-tenancy.test.ts` (`it.fails` + impact check) and shown blocked at HTTP in `redteam-routes.test.ts`.

**Fix:** composite FK `(device_id, household_id) → paired_devices(id, household_id)`, plus
`and pd.household_id = c.household_id` in `redeem_pairing`. The exact migration `0008` is in
`docs/adr/proposals/A9-qa-ops.md` §1. It was verified on the harness: idempotent, the `it.fails` test passes, and all
other db (102) and admin (78) integration tests stay green.

### A9-OPS-01: three documented kill switches are not wired

`.env.example` and the handoff runbook rely on `FEATURE_PAIRING`, `FEATURE_CATALOG_API` and `FEATURE_SCORES` to roll
features out in order and to switch them off during an incident. No server code reads them, so pairing (when
`FEATURE_STUDENT_PAIRED` is on), the public catalog API and adult analytics are live as soon as the admin is deployed.
`IMPLEMENTATION_STATUS.md` wrongly says the catalog is behind `FEATURE_CATALOG_API`.

**Fix:** `requireFeature()` as the first statement of the affected handlers (diff in the proposal §2). Refresh and revoke stay ungated.

### A9-PRIV-01: consent and data subject requests

- `consent_records` is written by `POST /api/v1/admin/consent`, but no handler checks it.
- No guardian-facing export or delete exists.
- The interim operator procedure (`scripts/ops/sql/process-deletion-request.sql`) is tested.

Design in the proposal §7. Owner decisions are in `docs/ops/PRIVACY.md`.

## 4. Residual risks (accepted for P7 unless the owner decides otherwise)

| ID | Risk | Mitigation in place | Recommendation |
|---|---|---|---|
| R1 | SQL execution as the `bnl_app` login (e.g. an injection) could `SET ROLE bnl_job` (cross-household job role) or forge `bnl.*` settings. The design trusts the BFF to set context | every query is a tagged template or a fixed constant (static guard test); `bnl_app` is NOINHERIT with no privileges of its own; the password lives only in the secret store | keep the static guard in CI; consider a separate job login (`bnl_job_login`) so the request login cannot assume `bnl_job` |
| R2 | Supabase signed URLs for private uploads are bearer URLs for their 60 s TTL | URLs are issued only after the household check; TTL is 60 s; responses are `no-store` | keep the TTL short; do not log URLs |
| R3 | A rollback **without** the kill switch leaves offline TVs on the cached new bundle until they go online | `FEATURE_STUDENT_SW=false` first; emergency self-unregistering `sw.js`; both rehearsed | follow `ROLLBACK.md` order |
| R4 | Device access (15 min) and refresh tokens live in TV localStorage; anyone with the TV can use them | refresh rotation with reuse detection (reuse revokes); guardian revoke is immediate (SEC-004); device scope cannot reach adult routes | guardians revoke lost or sold TVs |
| R5 | Dev auth (`BNL_DEV_AUTH`) in a non-production `NODE_ENV` on a public deployment | refused when `NODE_ENV` or `VERCEL_ENV` is `production`; password ≥ 12 chars; never in production env vars | runbook §6 sets it to `false`; the smoke check in `MONITORING.md` |
| R6 | Login rate limits are per email and per IP in the DB; a distributed attack can still try ~5 passwords per account per 15 min | Supabase Auth's own protections; invite-only accounts | enable Supabase Auth CAPTCHA/leaked-password checks if offered |
| R7 | No automated accessibility engine (axe-core) | focused, self-tested checker (`tests/a11y/checks.ts`) | proposal §5 |

## 5. Positive observations

- FORCE RLS everywhere. Request roles are entered per transaction. SECURITY DEFINER functions are owned by `bnl_owner` with a pinned `search_path`.
- Answer keys never leave the server: `quiz_questions_for_version` returns no keys, and scoring is server-side (TEL-005).
- Adult analytics, recommendation and import routes answer 404 for another household's ids (no existence oracle). Device routes answer 403 and write nothing.
- Admin and API responses carry `no-store`, a nonce CSP, `X-Frame-Options: DENY` and no referrer.
- Logs and audits use UUIDs only. `redact()` is applied to error logs.
- The pairing code is one-time, with a 10-minute TTL and a lock after 5 failed polls. Per-IP limits apply to the unauthenticated bootstrap.
