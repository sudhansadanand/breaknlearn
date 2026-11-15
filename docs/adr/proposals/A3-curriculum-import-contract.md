# A3 proposal: curriculum explorer and school import contract (P2)

- Status: Proposed by A3 (Curriculum & School Import), 2026-11-14. No contract file was changed. Everything here is additive, or it clarifies an OpenAPI operation that has no body or response schema yet.
- Implemented on branch `p2/curriculum`:
  - `packages/curriculum`
  - `packages/storage`
  - `apps/admin/src/server/curriculum/**`
  - the routes under `/api/v1/admin/{curriculum,school-plans,imports}`
  - `supabase/migrations/0004_curriculum_imports.sql`

## 1. New endpoints (not in OpenAPI)
| Endpoint | Who | Notes |
|---|---|---|
| `GET /admin/school-plans` | owner/guardian | Returns `{ school_plans: SchoolPlan[] }` for the caller's household. |
| `GET /admin/imports` | owner/guardian | Returns `{ jobs: [{ id, status, school_plan_id, job_type, created_at, chapters, errors }] }` for the latest 100 jobs. |
| `GET /admin/imports/{jobId}/file` | owner/guardian of the job's household | SEC-007. Returns `302` with `Location` set to a signed URL that expires after `IMPORT_SIGNED_URL_TTL_SECONDS` (default 60). Any other household gets `404`, and an adult with no household gets `403`. Each access writes the audit entry `import.file_accessed`. |
| `GET /admin/imports/local-object?b&k&e&s` | owner/guardian | Development and tests only. It serves `LocalFsStorage` signed URLs and needs both the session and a valid HMAC signature that has not expired. The object key must also start with the caller's household id. It returns `404` when storage is Supabase. |

## 2. Request and response shapes
- **`GET /admin/curriculum`** returns `{ nodes, next_cursor, viewer: { staff_roles, can_review, can_submit } }`.
  - Each node is the contract `CurriculumNode` plus these fields:
    - `subject_key`, `authority_label`, `source_document_id`, `reviewed_at`
    - `provenance: { origin, subject_authority, editorial_unverified }`
  - `cursor` is opaque base64url keyset data. `limit` is at most 100.
  - `q` matches titles case-insensitively, with `%` and `_` escaped.
  - Access: any staff role reads in the `staff` DB context. Otherwise the caller must be an owner or guardian, who reads in the `adult` context. Anyone else gets `403`.
- **`POST /admin/curriculum/{nodeId}/review`** uses the contract body and returns `{ node }`. The workflow:
  - `submit`: `draft` → `in_review`. Needs the editor or reviewer role.
  - `verify`: `in_review` → `verified`. Needs the reviewer role.
    - The reviewer must not be the last submitter (taken from the latest `curriculum.node_submitted` audit row) or the node's `created_by`. Otherwise `403`.
    - `source_document_id` must exist. Otherwise `422`.
    - `cisce_verified` is refused for `local_enrichment` subjects with `422`.
    - Calling it on a draft gives `409`.
  - `archive`: needs the reviewer role. The free-text reason is stored in `curriculum_nodes.provenance.archive_reason` and never in audit metadata. Audit records only `reason_chars`.
  - Audit actions: `curriculum.node_submitted`, `curriculum.node_verified`, `curriculum.node_archived`. Every entry has `household_id = null`.
- **`POST /admin/school-plans`** takes a strict body `{ grade, subject_key, academic_year, school_label?, textbook_title?, edition? }`.
  - `edition` maps to the `textbook_edition` column.
  - The subject must belong to the grade.
  - Text fields are refused if they contain markup or control characters (`422`).
  - Returns `201 { school_plan }`.
- **`POST /admin/imports`**:
  - Accepts either:
    - `multipart/form-data` with fields `file` and `school_plan_id`
    - JSON `{ school_plan_id, toc_text (≤200 000 chars), format: "lines" | "csv" }`, where `format` defaults to `lines`.
  - Returns `202 { job_id, duplicate_of, status: "review" | "failed", chapters, suggestions, published: false }`.
  - A duplicate checksum also returns `202`, with `duplicate_of = job_id` of the existing job and `chapters: 0`.
  - `Idempotency-Key`:
    - Missing or malformed: `400 validation_failed`.
    - Reused with a different request: `409 idempotency_conflict`.
    - Replayed with the same request: the stored response is returned. Keys are kept for 24 h in `idempotency_keys`, scope `admin.imports`.
  - Size and type checks:
    - Too large: `413`. This is checked against the declared `Content-Length`, the streamed body (cap is `IMPORT_MAX_MB` plus 64 KB of multipart framing) and the size of the file part.
    - Wrong type: `415`. The magic bytes, the declared part type and the file extension must all agree:
      - `.pdf` with `%PDF-`
      - `.docx` with a ZIP that contains `word/document.xml`
      - `.csv` or `.txt` with valid UTF-8 and no NUL bytes
  - Rate limit: 20 per hour per adult, then `429` with `Retry-After`.
- **`GET /admin/imports/{jobId}`** returns `ImportJob` plus these fields:
  - `job_type`, `created_at`, `finished_at`, `size_bytes`, `mime_type`, `plan`, `published: false`
  - Each error also carries `severity: "error" | "warning"`. Warnings are rows that were kept, for example `formula_escaped` and `page_out_of_order`.
  - Each chapter also carries `source_row`.
  - Each suggestion also carries `stable_key`, `node_title`, `node_authority`, `suggested` (false for a manual override), `reviewer_auth_id` and `reviewed_at`.
- **`POST /admin/imports/{jobId}/review`** uses the contract body, accepts up to 500 decisions and returns `{ job_id, decisions: [{ chapter_id, curriculum_node_id, state, reviewer_auth_id, reviewed_at, changed }], published: false }`. Rules:
  - Approved mappings are immutable. Re-approving one is a no-op (`changed: false`). Rejecting one returns `409`.
  - A rejected suggestion can be approved later.
  - Approving a topic that was not suggested inserts an explicit override row (`confidence: null`). The topic must be a topic or subtopic node of the plan's grade that is not archived. Otherwise `422`.
  - All decisions apply atomically. A chapter outside the job, or a duplicate pair, returns `422` and nothing changes.
  - Each request writes one audit row, `import.mappings_reviewed`, listing the changed (chapter, node, state) triples. Together these rows are the decision history.
  - Proposal: if a per-decision version table is wanted later, add `chapter_mapping_decisions` as a new migration. The `unique (chapter_id, curriculum_node_id)` constraint in 0001 means one current row per pair.

## 3. Migration 0004 (additive, re-runnable)
1. Adds `unique (school_plan_id, sha256)` on `syllabus_uploads`. This enforces CAT-010 even when duplicate imports run concurrently.
2. Adds trigger `mapping_decision_guard`. For the request roles (adult, staff, device, public):
   - an approved mapping cannot be updated or deleted (`55000`)
   - the chapter, node and household of a mapping cannot change
   - a decided row's `reviewer_auth_id` must equal `bnl.current_actor_id()` (`42501`)
   - owner, job and ops sessions are not restricted, so household-deletion cascades still work
3. Adds trigger `curriculum_authority_guard`:
   - only a reviewer may change `authority` (`42501`)
   - `cisce_verified` requires `review_status ∈ (verified, archived)` (`22023`)

No grants or policies were widened, and no RLS change was needed for these flows.

## 4. Storage (ADR-0005 §13)
- Bucket `school-syllabi` must be created **private** in each Supabase project:
  - `public = false`
  - no `storage.objects` policies for `anon` or `authenticated`
- Only the server touches it, with `SUPABASE_SERVICE_ROLE_KEY`. Browsers only ever receive short-lived signed URLs.
- Object keys are `<household_id>/<uuid>`. The uploader's filename is never part of a key or URL. A sanitised basename is kept only in the private column `syllabus_uploads.original_filename`.
- `SupabaseStorage` follows the Storage REST API (`/storage/v1/object…`, `x-upsert: false`, `/object/sign`). It has **not been verified against a live project**; only fetch-double unit tests exist.
- Local storage (`LocalFsStorage`) is refused when `VERCEL_ENV` is production or preview. It is also refused when `NODE_ENV=production`, unless `BNL_ALLOW_LOCAL_STORAGE=true` is set for a local `next start`.

## 5. Extraction scope
- **CSV.** Header `chapter_no,title,page_start,grade,subject` in any order, with no extra columns. Parsing follows RFC 4180: BOM and CRLF are accepted.
  - Limits: at most 500 rows, titles at most 200 characters.
  - Grade and subject must match the plan. The subject may be given as a key, a label or an alias.
  - Errors are reported per row, by record number (the header is row 1).
  - Markup is rejected.
  - Values starting with `= + - @` are stored with a leading `'` and flagged with the warning `formula_escaped`.
- **Text, pasted or extracted from DOCX/PDF.** A line extractor recognises numbered and `Chapter/Unit/Lesson N` prefixes, Roman numerals, dot leaders, tabs and dash separators. Each line gets an `extraction_confidence` between 0 and 1.
- **DOCX.** Streams `word/document.xml` with `fflate@0.8.2`, capped at 16 MB inflated as a zip-bomb guard. Paragraphs, runs, tabs and entities are handled.
- **PDF.** A pure-TypeScript extractor, with no extra dependency beyond fflate. It handles:
  - classic objects and compressed object streams
  - FlateDecode streams
  - page-tree order and inherited resources
  - WinAnsi simple fonts
  - ToUnicode CMaps (bfchar and bfrange)

  Encrypted PDFs, scanned PDFs with no text layer, and unsupported filters produce a `failed` job with `needs_manual_toc`, which asks for a pasted TOC. **OCR is not implemented and nothing is queued for it.**
- **Inline extraction.** Extraction runs inside the request, which is fine for files up to 20 MB of TOC. The production path for heavy files is a queue worker that processes `import_jobs` with status `queued`.
- **Suggestions.** Deterministic: normalised tokens (stopwords removed, light stemming, a small domain thesaurus), scored as mean(Dice, node coverage) × 0.5 when the subject differs. Only same-grade topic and subtopic nodes are candidates. Each chapter gets its top 3 above `IMPORT_SUGGEST_THRESHOLD` (default 0.2). No model or network calls are made (spec §9).

## 6. Environment variables (new)
| Name | Default | Purpose |
|---|---|---|
| `IMPORT_MAX_MB` | `20` | Upload cap, 1..20. The 0001 check caps `size_bytes` at 20 MB. |
| `IMPORT_SIGNED_URL_TTL_SECONDS` | `60` | Signed download URL lifetime, 10..900 seconds. |
| `IMPORT_SUGGEST_THRESHOLD` | `0.2` | Minimum suggestion confidence. |
| `BNL_STORAGE_DRIVER` | `supabase` if `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise `local` | `local` or `supabase`. |
| `BNL_LOCAL_STORAGE_DIR` | `<os tmpdir>/bnl-local-storage` | Absolute path for local development storage. |
| `BNL_ALLOW_LOCAL_STORAGE` | unset | Allows local storage under a local `NODE_ENV=production` `next start`. |

The local signed-URL key is derived from `DEVICE_TOKEN_SIGNING_SECRET` with the label `bnl/v1/local-storage-url`.

## 7. Needs a lead change outside A3 ownership
- `apps/admin/test/sec-001.test.ts` asserts the **exact** list of route files under `api/v1/admin`, so it fails as soon as the new routes exist. Please extend its expected list (and `ADULT_ROUTES`) with:
  - `api/v1/admin/curriculum/route.ts`
  - `api/v1/admin/curriculum/[nodeId]/review/route.ts`
  - `api/v1/admin/school-plans/route.ts`
  - `api/v1/admin/imports/route.ts`
  - `api/v1/admin/imports/[jobId]/route.ts`
  - `api/v1/admin/imports/[jobId]/review/route.ts`
  - `api/v1/admin/imports/[jobId]/file/route.ts`
  - `api/v1/admin/imports/local-object/route.ts`

  `apps/admin/test/curriculum/routes.test.ts` already proves that every one of these returns 401 without a session.
- The same file's "every portal page … verify the session" test asserts the exact list of portal pages. Please add `admin/(portal)/curriculum/page.tsx`, `admin/(portal)/imports/page.tsx` and `admin/(portal)/imports/[jobId]/page.tsx` to it. `test/curriculum/routes.test.ts` already checks that each of them awaits `requireAdultPage()` before loading any data.
- Nav links: `/admin/curriculum` "Curriculum" and `/admin/imports` "School imports". Both can replace the matching "Coming soon" placeholders.
