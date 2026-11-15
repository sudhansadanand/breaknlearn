# Monitoring

There is no metrics backend in the repo yet. The signals below come from three sources:
- Vercel function logs: one JSON line per unexpected error, already redacted (`apps/admin/src/server/http.ts`, `deps.ts`);
- HTTP status codes;
- the `bnl` tables `job_runs` and `audit_logs`, and the job stdout JSON lines.

Choosing and wiring an alerting tool (Vercel log drains, Supabase alerts, GitHub Actions failure e-mails) is an
owner decision (`P7_OWNER_CHECKLIST.md`).

**Never log or alert with:**
- child names;
- answer text;
- tokens;
- emails.

Use only UUIDs, counts and request ids. Every API response carries `X-Request-Id`.

## Health and synthetic checks (every 5 min)

| Check | Expect | Severity on failure |
|---|---|---|
| `GET /api/v1/health` | 200 `{"status":"ok"}`. It checks configuration only, not the DB | high |
| `GET /` | 200, bytes equal to the approved student build (or the snapshot) | high |
| `GET /api/v1/student/config` | 200 with the expected flags (`paired`, `service_worker`) | high (a wrong `service_worker` value can strand TVs) |
| `GET /admin` with no cookie | 302/307 to login, `no-store` | **critical** if it is 200 |
| `GET /api/v1/admin/devices` with no cookie | 401 | **critical** if it is 2xx |

## Request path (from Vercel logs, per 15 min)

| Signal | Threshold (initial, tune after a week) |
|---|---|
| 5xx rate per route family (`/api/v1/telemetry`, `/progress`, `/assessments`, `/admin/*`, `/devices`) | > 1 % or > 5 in 15 min |
| p95 latency per route family | > 1.5 s |
| 401/403/404 on device routes from a single device | > 50/h (a revoked or misbehaving TV, or probing) |
| 429 on `/api/v1/auth/login` | any burst > 20/h → possible brute force (SEC-009) |
| 410 / 429 on the pairing poll | > 30/h → possible pairing brute force |
| 413/422 on `/telemetry/batch` | > 2 % of batches → client bug |

## Database and jobs (daily, after the jobs)

```sql
-- last run and status per job (missing row = the job did not run)
select job_name, max(finished_at) filter (where status = 'succeeded') as last_ok,
       count(*) filter (where status in ('failed','dead_letter') and started_at > now() - interval '1 day') as failures_24h
from bnl.job_runs group by 1;
```

| Signal | Source | Alert |
|---|---|---|
| aggregation/scoring did not succeed for yesterday | `job_runs`, job exit code | high |
| `max_ingest_lag_ms` in the aggregate job output | job JSON line | > 6 h p95 |
| `events_excluded` / `sessions_considered` | job JSON line | ratio > 5 % |
| retention purge last success | `job_runs` / exit code | > 48 h old |
| unprocessed data deletion requests | `select count(*) from bnl.data_deletion_requests where status in ('requested','processing') and requested_at < now() - interval '7 days'` | > 0 (`PRIVACY.md` SLA) |
| DB size, connection count | Supabase dashboard | > 80 % of plan |
| backup age | Supabase dashboard | > 26 h |

## Security signals (audit log, daily review; immediate when automated)

- Many `device.revoke` events or `pairing.*` failures for one household in a short time.
- Any new `staff_roles` row. It must match a written request.
- Logins to `/admin` from new countries, if the auth provider exposes this.
- Any 2xx on an admin route without a session, or any cross-household denial
  pattern from one session (many 404s on `[id]` routes): treat as a **SEV-1** (`INCIDENT_RESPONSE.md`).

## Student TVs

Field telemetry for the bundle itself does not exist (by design: no third-party analytics on child devices).
Use these instead:
- `student/config` request counts per day, which show TVs launching;
- telemetry batch volume per household;
- owner reports.
