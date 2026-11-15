# A4 proposal: CMS/publishing contract additions and interpretations

- Status: Proposed by A4 (CMS Authoring & Publishing), 2026-11-14. No contract file was changed.

1. **Unpublish body.** OpenAPI `unpublishLesson` has no request body. The BFF requires
   `{ reason: string (1..500, trimmed) }`, because `bnl.unpublish_lesson` needs an audited reason.
   Proposal: add a named `UnpublishRequest` schema to `admin.ts` and the OpenAPI path.
   Response: `{ manifest_revision, unpublished_at }`.
2. **Pin body and response.** `pinManifest` accepts an empty body or `{}`.
   Response: `{ manifest_revision, pinned_from_revision }`. Proposal: add a `PinResponse` schema.
3. **Admin read shapes** (OpenAPI only says "Lessons with latest version status"):
   - `GET /admin/lessons`: `{ items: [{ id, stable_key, grade, subject_key, topic_id, title, template_key, sort_order, latest_version: { id, version_no, status, title, validation_error_count, updated_at } | null, live_version: { id, version_no } | null }], next_cursor }`. The cursor is an opaque base64url string, and items are ordered by `stable_key`.
   - `GET /admin/lessons/{id}`: `{ lesson, live_version_id, versions[], publications[], manifests[], viewer: { user_id, roles } }`.
   - `GET .../preview`: `{ validation_errors, renderable, themes: [{ theme_key, name, icon, color, slides: PictureSlide[] }], seconds_per_slide, quiz_question_count, quiz_items, answer_keys_included }`. `correct_option_id` is present only for the `reviewer` role.
   Proposal: add these as named schemas.
4. **Idempotency.**
   - A missing or malformed `Idempotency-Key` returns 422 `validation_failed`.
   - Replaying with the same key and the same canonical request returns the stored status and body, plus the header `Idempotent-Replayed: true`.
   - The same key with a different request returns 409 `idempotency_conflict`.
   - A failed request stores nothing, because the key row and the effect share one transaction, so the same key can be retried.
   - Scopes: `admin.lesson.publish`, `admin.lesson.unpublish`, `admin.manifest.pin`.
5. **Draft save semantics.** `POST /admin/lessons` updates the latest version in place while it is still a `draft`. Otherwise it creates version `max+1`, because versions past draft are immutable (CAT-007).
   - `stable_key`, `grade`, `subject_key` and `template` are fixed per lesson. A mismatch returns 422.
   - A duplicate `stable_key` without `lesson_id` returns 409.
   - The response is always 201.
6. **Content checksum** is computed by the DB trigger as `sha256(content::text)`, the canonical jsonb text. The BFF does not compute its own.
7. **Item-bank key format.** Bank rows use the seed scheme: `<stable_key>.fact-<m>.v<version_no>`, options `a..d`, prompt `n × m = ?`. This is `bankItemsForContent` in lesson-engine, and the same scheme is used by SQL `bnl.generate_picture_groups_items` (migration 0005).
   - The older lesson-engine `multiplicationItem`/`multiplicationItemKey` (`<versionId>:mult-FxN`, `opt-V`) do not match the seeded rows and are not used for bank rows.
   - P4 should read question keys from `bnl.quiz_items` and not regenerate them with `multiplicationItem`.
8. **Catalog 404s** carry `Cache-Control: no-store`. Only 200 and 304 catalog responses are publicly cacheable.

## Required edit outside A4 ownership: `apps/admin/test/sec-001.test.ts`

The guard lists exact files, so it now fails, as it is meant to when routes are added. The lead should apply this change:

- In `covers every route file under /api/v1/admin`, add these to the expected list:
  - `api/v1/admin/lessons/route.ts`
  - `api/v1/admin/lessons/[lessonId]/route.ts`
  - `api/v1/admin/lessons/[lessonId]/publish/route.ts`
  - `api/v1/admin/lessons/[lessonId]/unpublish/route.ts`
  - `api/v1/admin/lessons/[lessonId]/versions/[versionId]/preview/route.ts`
  - `api/v1/admin/lessons/[lessonId]/versions/[versionId]/transition/route.ts`
  - `api/v1/admin/manifests/[revision]/pin/route.ts`
- In `every portal page ... verify the session`, add these to the expected list:
  - `admin/(portal)/lessons/page.tsx`
  - `admin/(portal)/lessons/[id]/page.tsx`
- `ADULT_ROUTES` uses `routes.adminCatchAll` for `/api/v1/admin/lessons`. That still passes, because the catch-all handler is unchanged. The real lessons routes are covered for 401 in `apps/admin/test/content/content-routes.test.ts`.

## Nav (not A4-owned): `apps/admin/src/app/admin/_components/nav.tsx`

Move "Lessons" from `PLACEHOLDERS` to `LINKS` as `{ href: "/admin/lessons", label: "Lessons" }`. Highlighting it for `/admin/lessons/[id]` needs a `startsWith` match.
