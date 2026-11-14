# Proposal A2: additive identity/pairing contract clarifications (P1)

- Status: Proposed by A2 (Identity & Security), 2026-11-14. Needs lead/A0 approval as a follow-up ADR. Everything here is **additive** or a clarification of a description; no frozen v1.1 schema changes.
- Implemented in `apps/admin` on branch `p1/identity`; the frozen contracts package is unchanged.

## 1. Adult session endpoints (new, not in OpenAPI)
The OpenAPI `AdultSession` scheme names the cookie `bnl_admin_session` but gives no way to obtain it.
- `POST /api/v1/auth/login` body `{ email, password }` → `200 { user_id }` + `Set-Cookie: bnl_admin_session=…; Path=/; HttpOnly; SameSite=Strict[; Secure]`. `401 unauthorized` with one generic message for every failure. `429 rate_limited` (+`Retry-After`) at 10/15 min per IP and 5/15 min per email (SEC-009). Requires Origin + `X-CSRF-Token` (login CSRF).
- `POST /api/v1/auth/logout` → `204` and clears the cookie. Requires Origin + `X-CSRF-Token`.
- Kept outside `/admin/*` because they cannot require an existing session (ADR-0002 A3 allowlist test only covers `/admin/*`). Suggest adding both to the OpenAPI document and to the credential-free allowlist.
- With Supabase, the server performs the GoTrue password grant and stores the access token in the httpOnly cookie (no token in JS). Session lifetime = Supabase access-token lifetime (default 1 h); refresh-token handling is not implemented in P1.

## 2. CSRF cookie
Double-submit cookie `bnl_csrf` (not httpOnly, `SameSite=Strict`, `Path=/`) is issued by middleware on every `/admin` page response; the browser echoes it in `X-CSRF-Token`. Suggest documenting it next to `AdultSession`.

## 3. `POST /admin/consent` body as a named schema
OpenAPI inlines `{ consent_version: string, decision: grant|revoke }`. Implemented as `ConsentRequest` with `consent_version` restricted to `^[A-Za-z0-9._-]{1,64}$`. Response `200 { consent_version, decision, recorded_at, changed }`. Suggest adding `ConsentRequest`/`ConsentReceipt` to `packages/contracts/src/admin.ts`.

## 4. Pairing response details
- `POST /devices/token` `202` body is `{ "status": "pending" }` with `Retry-After: 3`. Suggest adding it to OpenAPI.
- `410` uses error code `not_found` (the `ErrorCode` enum has no `gone`). Returned for unknown, expired, already-redeemed and locked pairings.
- Wrong `poll_secret` → `401 unauthorized` (not listed in OpenAPI for this operation) and increments `failed_attempts`; the 5th failure locks the pairing (`410`), and a locked code can no longer be approved.
- `POST /devices/pair` invalid code format → `422`; unknown/expired/used/locked code → `404` (no state oracle). Approvals are rate-limited per adult (10 / 10 min) because a *wrong* code matches no row, so a per-code failure counter cannot bound guessing on the approve side. `failed_attempts` therefore counts poll-secret failures. Please confirm this reading of "max 5 failed attempts per code".
- `POST /devices/{id}/revoke` returns `200 { device: Device }`. Unknown ids and other households' ids both return `403` (no existence oracle).

## 5. Refresh-token envelope (opaque to clients)
`<household_id>.<device_id>.<32 random bytes b64url>.<HMAC-SHA256 b64url>` (≈160 chars, within the 32..512 contract bounds). Only `sha256(token)` is stored in `paired_devices.refresh_token_hash`. The MAC lets the server tell a genuine superseded token (reuse ⇒ revoke the device: `revoked_at`, `token_version+1`, hash cleared, audit `device.refresh_reuse_revoked`) from a forgery (plain 401, no state change) **without** a token-history table, and lets refresh run under the device's own RLS context. Alternative if preferred: add `paired_devices.previous_refresh_token_hash`.

## 6. Device access token
Claims are exactly `DeviceTokenClaims` plus standard `iss: "bnl"` and `aud: "bnl:device"` (the Zod object is non-strict, so this is compatible). Verification pins `alg=HS256`, `typ=JWT`, issuer, audience, expiry (no clock tolerance) and checks `ver == paired_devices.token_version` and `revoked_at is null` in the same transaction as the request.

## 7. Profiles
- Third profile or a slot already used by another profile ⇒ `422 validation_failed` with `details.issues[].code` = `profile_limit` / `slot_taken` (OpenAPI lists 403/422 only; 409 would be more idiomatic).
- `household_id` or other unknown body fields are stripped, never trusted.
- A submitted `id` that exists in another household ⇒ `403` (detected as a primary-key unique violation, since RLS hides the row).
- One household per adult in v1: an adult with several active memberships gets `409 conflict`; one with none gets `403`.

## 8. RLS policies the handlers rely on (for A1)
| Step | DbContext | Needs |
|---|---|---|
| create pairing code | `job` | insert `device_pairing_codes` |
| approve | `adult` | select/update `device_pairing_codes` rows with `household_id is null` (unclaimed, unexpired) and set `household_id` to a household where the actor is active owner/guardian; insert `paired_devices` + `audit_logs` for that household |
| redeem | `job` | select/update `device_pairing_codes` by `pairing_id`; select/update `paired_devices` (refresh hash) |
| refresh | `device` | select/update own `paired_devices` row (refresh hash, and on reuse `revoked_at`/`token_version`); insert `audit_logs` |
| every device request | `device` | update own `paired_devices.last_seen_at` (check+touch is one statement) |
| rate limiting | `job` | upsert `rate_limit_buckets` |
