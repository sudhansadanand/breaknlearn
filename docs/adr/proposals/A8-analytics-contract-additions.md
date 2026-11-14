# Proposal A8: ELS scoring job, parent analytics, recommendations, retention (P5)

- Status: proposed by A8 (Intelligence & Analytics) on 2026-11-14. Needs lead approval as a follow-up ADR.
- No frozen contract file changed (`packages/contracts`, OpenAPI, 0001–0006 untouched). Additive API fields and
  one additive migration (`0007_analytics.sql`) are described below.
- Code:
  - `packages/intelligence`: unchanged ELS formula; added `evidence.ts` (flags, badges), `recommendForLesson`
    + `RECOMMENDATION_TEXT`, `retention.ts`, `activity.ts`.
  - `apps/admin/src/server/analytics/**`: scoring planner + job, retention job, adult repo, dashboard builder, handlers.
  - `apps/admin/src/app/admin/(portal)/analytics/**`: server-rendered parent dashboard.
  - Routes: `api/v1/admin/analytics/summary`, `api/v1/admin/analytics/learning-scores`,
    `api/v1/admin/recommendations`, `api/v1/admin/recommendations/[id]/dismiss`.
  - Jobs: `scripts/jobs/score-learners.mjs`, `scripts/jobs/score-retention-purge.mjs`.

## 1. Lead changes requested (not in A8 ownership)

1. **Dependency.** Add to `apps/admin/package.json` and regenerate the lockfile (no external packages):
   ```diff
        "@bnl/db": "workspace:*",
   +    "@bnl/intelligence": "workspace:*",
   ```
   Then change the single line in `apps/admin/src/server/analytics/intelligence.ts` to
   `export * from "@bnl/intelligence";`. Until then that shim imports the workspace source by relative path
   (typecheck, vitest, `next build` and the job runners all pass with it). Optionally add `@bnl/intelligence`
   and `@bnl/assessment` to `transpilePackages`.
2. **Nav.** In `apps/admin/src/app/admin/_components/nav.tsx` replace the "Analytics" placeholder with a link:
   ```diff
      { href: "/admin/lessons", label: "Lessons" },
   +  { href: "/admin/analytics", label: "Analytics" },
    ] as const;
   -const PLACEHOLDERS = ["Analytics"] as const;
   +const PLACEHOLDERS = [] as const;
   ```
   (and drop "Analytics" from the "arrive in later milestones" line on the Overview page).
3. **Scheduling** (no running loops on serverless, spec §2.5):
   - nightly after 00:30 UTC: `node scripts/jobs/score-learners.mjs` (defaults to yesterday UTC); run it after
     `aggregate-sessions.mjs`;
   - daily: `node scripts/jobs/score-retention-purge.mjs`.
   Both need `BNL_JOB_DB_URL` (the `bnl_app` login, never a superuser). On-demand re-score of some learners:
   `--learners <uuid,...>`; backfill: `--as-of YYYY-MM-DD`.
4. **Env vars** for `.env.example` / ops docs: `RETENTION_RAW_TELEMETRY_DAYS` (default 90; `RETENTION_DAYS`
   from spec §2 is accepted as an alias), `RETENTION_AGGREGATE_DAYS` (default 395 ≈ 13 months). Values are
   validated (fail closed): integers 1..3650, raw ≥ 30, aggregate ≥ raw.
5. **OpenAPI v1.2** (additive, see §3): response schemas for the four operations, 401/404/422 responses,
   `{undo}` body on dismiss, new fields on `Recommendation`.
6. **IMPLEMENTATION_STATUS.md**: P5 row and gate evidence (I did not edit it; root files are lead-owned).

## 2. Migration 0007 (additive, re-runnable)

| Change | Why |
|---|---|
| `mastery_snapshots.lesson_id uuid null → lessons` | ×1–×10 share one topic (`MULTIPLICATION_TOPIC_ID`); per-table status needs per-lesson rows. `lesson_id null` = topic-level row. |
| `mastery_snapshots.evidence jsonb` (object) | `{flags[], stages:{baseline,immediate,retention:{status,reason,questions}}, lesson_ids[]}` — provisional / insufficient_evidence reasons stored with the score. |
| drop `uq_mastery_run_learner_topic`, add `uq_mastery_run_learner_topic_lesson (score_run_id, learner_id, topic_id, lesson_id) nulls not distinct where score_run_id is not null` | old key allowed only one row per topic per run; partial so manual/legacy rows without a run do not collide. |
| `uq_mastery_daily (learner_id, topic_id, lesson_id, score_date, weights_version) nulls not distinct` | job idempotency key; a new version/day adds rows, never rewrites history (ELS-008). |
| `recommendations.lesson_id`, `.detail jsonb`, `.superseded_at`; `uq_recommendation_active (learner, topic, lesson, reason) where superseded_at is null` | explainability (rule version, thresholds, inputs) and stable rows so a guardian's dismissal survives nightly re-runs. |
| `bnl.purge_expired_analytics(days default 395)` SECURITY DEFINER, owner `bnl_owner`, `search_path = pg_catalog, pg_temp`, EXECUTE `bnl_job` only, audited `retention.purge_analytics` | covers what 0003 `purge_expired` does not: `learning_sessions`, `assessment_attempts` (responses + dependent reviews cascade), closed `review_schedule`, unreferenced `score_runs`, `aggregation_runs`, `job_runs`. Refuses windows < 30 days. |

No table added → RLS ENABLE+FORCE and ADR-0005 grants unchanged. Score writes are plain `bnl_job` writes
(existing grants + `job_all` policy); no new definer function was needed for them. Adults keep `UPDATE
(dismissed_at)` only — verified in the real-DB test (other columns → permission denied).

## 3. API (all adult cookie session, `Cache-Control: no-store`, household-scoped)

- 401 without/forged session (before any DB access); 403 for an adult with no household; **404** for a
  `learner_id` or recommendation id outside the caller's household (same as non-existent); 422 for malformed
  `learner_id`/`from`/`to` (values never echoed; range ≤ 400 days).
- `GET /admin/analytics/summary?learner_id&from&to` → the dashboard model: `{generated_at, timezone,
  scores_as_of, notes, children:[{learner_id, display_name, slot, grade, tables[×1..×10], other_lessons[],
  topic_scores: LearningScore[], activity:{sessions, active_days, last_active_date, playback_ms,
  foreground_estimated_ms, interaction_count, from, to, note}, recommendations[], due_reviews[]}]}`.
  Each table row has `mastery` / `retention` badges `{text, value|null, tone, detail}`; `value: null` always
  renders "Not enough evidence yet", never 0. Default activity window: last 14 days; active days deduped in
  the household timezone.
- `GET /admin/analytics/learning-scores?learner_id` → `items: LearningScore[]` (topic-level rows, frozen
  schema) **+ additive** `lessons: [{lesson_id, score_date, score: LearningScore, evidence}]`.
- `GET /admin/recommendations?learner_id` → `items`: frozen `Recommendation` **+ additive** `lesson_id`,
  `action`, `why`, `detail`. Active (not superseded) rows, dismissed ones included so they can be restored.
- `POST /admin/recommendations/{id}/dismiss` (CSRF) body optional `{"undo": true}` (strict) → restores.
  Audited `recommendation.dismissed|restored` with `reason_code` only (no names).
- `GET /admin/analytics/content-quality` is **not** implemented (editor-facing, cohort suppression needs
  more than two children); it still falls to the catch-all (401 / 404).

## 4. Defaults chosen

| Topic | Default |
|---|---|
| As-of | Job scores "as of the end of a UTC day" (default yesterday). Evidence (attempt start, answers, finish, progress) after `YYYY-MM-DDT23:59:59.999Z` is ignored, so a re-run is byte-identical; `computed_at` = that instant. |
| Granularity | One row per learner × lesson and one per learner × topic (all lessons of the topic pooled through A7's `buildElsInputs`). |
| Completion C | From `learner_progress`: a completed attempt (completed_at ≤ as-of) = all slides; otherwise `step-N` ⇒ N−1 slides if the row was last updated ≤ as-of; slides assigned = `count_to − count_from + 1` of the version config; unknown ⇒ null (not 0). Best attempt wins. |
| Progress without quiz | Row with `insufficient_evidence`, score null, C recorded; recommendation `insufficient_evidence_take_quiz`. |
| Recommendations | Existing `recommend()` order (insufficient → retention < 60 → mastery < 60 → review due → ready ≥ 80) per lesson. Suggested lesson: same lesson, except `ready_for_next_topic` → next live lesson of the topic by `sort_order` (×10 → null). Inputs never include time. Refreshed only by the newest as-of run (backfills do not resurrect old nudges). Rows no longer applicable get `superseded_at`. |
| Retention | raw telemetry 90 d; aggregates (sessions, attempts/responses, snapshots, recommendations, run logs) 395 d. `learner_progress` (resume state) is not purged here (household deletion covers it). |
| Dashboard freshness | Reads stored snapshots (nightly); the page states the as-of date. Due reviews and activity are live. |

## 5. Risks / follow-ups
- The scoring job runs all learners in one transaction; fine for a household product, but should move to
  per-household transactions if many households are added.
- `score_runs` are keyed per day/version; a `--learners` subset run marks that day's run succeeded with only
  the subset's row count.
- Recommendation `detail` and snapshot `evidence` jsonb shapes are not yet in the contracts package; please
  add Zod schemas in v1.2 if other agents consume them.
- Active time is stored per session, not per lesson, so the dashboard cannot show time by subject yet (M11
  "time by subject" needs `learning_sessions.lesson_id` or event-level aggregation from A6).
