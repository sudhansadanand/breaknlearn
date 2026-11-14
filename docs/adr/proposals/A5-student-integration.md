# Proposal A5: student integration (P3): lead changes and interface notes

- Status: Proposed by A5 (Student Integration), 2026-11-14, on branch `p3/student`. Needs lead approval.
- A5 changed only `apps/student/**`, `tests/e2e/student-*.spec.ts`, `tests/fixtures/student/**` and this
  file. Nothing in contracts, root files, CI, `apps/admin`, `legacy/**` or the legacy regression spec was
  touched.

## 1. Lead changes requested

1. **Root scripts** (`package.json`). Add the following:
   ```diff
   +    "build:student": "pnpm --filter @bnl/student build",
   ```
   and make `test:e2e` build the student bundle first:
   `"test:e2e": "pnpm --filter @bnl/student build && playwright test"`.
   `pnpm build` already picks up `@bnl/student` through its new `build` script. Admin copies the student
   output, so admin needs the student build first. pnpm `-r` orders by dependency, and admin does not depend
   on student, so either add `"@bnl/student": "workspace:*"` as an admin devDependency (this needs a lockfile
   update) or run `build:student` before `pnpm -r build` in the root `build` script.
2. **Playwright config: legacy regression against the new bundle.** Change the webServer to
   ```ts
   command: `node scripts/static-server.mjs ${process.env.STUDENT_DIR ?? "apps/student/dist"} 4173`,
   ```
   For the frozen live app, use `STUDENT_DIR=legacy/live-snapshot-2026-11-14`.
   I ran the unchanged `tests/e2e/legacy-regression.spec.ts` against the build by serving `apps/student/dist`
   on 127.0.0.1:4173 (`reuseExistingServer`). All 9 tests pass.
   The `student-*` specs are independent of the webServer. They build into a temp dir per worker (or use
   `STUDENT_DIST=<dir>`) and serve the build and the snapshot on random ports.
3. **`apps/admin` co-hosting (ADR-0006).**
   - `scripts/copy-student.mjs`: change the source from `../../student/public` to `../../student/dist`. The
     output is still flat files: `index.html`, `app.js`, `sw.js`, `logo.webp`, `music.wav` and
     `build.json`. `build.json` is harmless; drop it from the copy if you prefer.
   - `scripts/verify-student-served.mjs` (`test:served`): compare against `apps/student/dist` instead of
     the snapshot, and add `/app.js?v=<build_id>` and `/sw.js`. `build_id` is in `dist/build.json`.
     `/logo.webp` and `/music.wav` stay byte-identical to the snapshot (test-enforced in
     `apps/student/test/build.test.ts`).
   - Serve `/sw.js` with `Cache-Control: no-cache` and `Content-Type: text/javascript`.
     `Service-Worker-Allowed` is not needed, because scope is `/`.
4. **New endpoint for the runtime flag (A2/A6 area):** `GET /api/v1/student/config`. It is public, needs no
   auth, and is sent with `Cache-Control: no-store`. It returns
   `{"paired_mode": boolean, "telemetry": boolean, "service_worker": boolean}`. Suggested env flags:
   `FEATURE_STUDENT_PAIRED`, the existing `FEATURE_TELEMETRY`, and `FEATURE_STUDENT_SW` (default true).
   While the endpoint does not exist (404), the student stays in live-equivalent local mode. That is the
   intended safe default for cutover. The response is also the service-worker kill switch.
5. **Dependency (optional):** add `acorn` (already present transitively as 8.19.0) as a devDependency of
   `@bnl/student`. `test/build.test.ts` then also parses `app.js`/`sw.js` with `ecmaVersion: 5`. The
   TypeScript-AST checker (`scripts/es5-check.mjs`) is the build gate and runs now. I ran an acorn check
   manually through the `.pnpm` path, and both files parse.
6. **CI:** run `pnpm --filter @bnl/student build` and `node apps/student/scripts/es5-check.mjs
   apps/student/dist/app.js apps/student/dist/sw.js` before e2e.

## 2. Interface use and differences

- **Uses the existing endpoints as implemented:**
  - `POST /devices/pairing-code`, which returns 201;
  - `POST /devices/token`, which returns 202, 200 or 410;
  - `POST /devices/token/refresh`, where a 401 is treated as revoked: the device forgets its credential,
    queue and outbox, and local progress is kept (SEC-004);
  - `GET /profiles` with a Bearer token;
  - `GET /catalog/manifest?grade=2`, with `If-None-Match`, and `GET /catalog/lessons/{id}`;
  - `POST /telemetry/batch`, `POST /progress/sync` and `GET /progress?learner_id=`;
  - `POST /progress/legacy-import`, with A6's `historical_learner_id`.
- **Learner mapping:** local `child-N` is matched to the server profile with `slot = N`. A guardian must
  confirm each link on the TV ("Link explorers"). Nothing is linked automatically. The TV never creates
  server profiles.
- **Legacy import:**
  - `raw` contains only the linked profiles (with their full original objects). The full verbatim copy
    stays in `breaknlearn.legacy-backup.v1`.
  - The server requires every profile that has entries to be mapped. Uploading only linked profiles lets a
    guardian link one child without the request failing.
  - The fingerprint is computed in pure JS and parity-tested against `legacyFingerprint` /
    `legacyFingerprintInput` from `@bnl/student-progress`.
  - Retries reuse the run id, body and `Idempotency-Key: li-<run id>`.
  - A newly linked profile triggers one further import that covers only that profile.
- **Progress:**
  - After an import, the TV reads `GET /progress` and adopts the latest incomplete attempt for each
    (lesson, theme). Continued play then merges into the legacy attempt instead of creating a duplicate.
  - A replay of a completed world, or Restart, uses a new UUID v4 `attempt_id`.
- **Telemetry and quiz evidence:**
  - `answer_submitted` sends `question_version_key = <stable_key>.fact-<m>.v<version_no>`, which is the A4
    bank key, only when the published version is known.
  - `selected_option_id` is the bank option id (a..d) when the chosen value is one of the bank's options,
    and `v-<value>` otherwise. The bank always contains the correct product, so server scoring stays exact.
    The live quiz UI itself is unchanged; the options a child sees still come from `Math.random`.
- **Catalog:**
  - Only Grade 2 Math `picture_groups_v1` lessons with `count_from=1`, `count_to=10` and known themes are
    rendered. `seconds_per_slide` and `quiz_question_count` are honoured.
  - A manifest or lesson that fails validation keeps the last good catalog (CAT-008).
  - Grade 6 subjects stay built-in stubs (CAT-002).
- **Deviation from M07: queue storage.** The spec asks for an IndexedDB queue; it uses localStorage, the
  fallback the spec permits. That keeps it ES5 and synchronous, and old webOS IndexedDB is unreliable. To
  fit localStorage, the cap is 1500 events, versus 5000 in `@bnl/telemetry`.
- **Deviation from M07: ported queue logic.** The queue logic is ported from `@bnl/telemetry`
  `TelemetryQueue`, because classes, async and Set cannot ship as ES5. It keeps the same key format,
  backoff, dedupe and preserve list.

## 3. A7 assessments (lead note received during P3)

Not merged into `p3/student`, so the lockfile and admin package changes stay with the lead's integration.
The student app already meets the constraints:
- it never queues assessment answers offline;
- the post-lesson quiz stays the local three-question quiz, reported as telemetry only (`attempt_stage:
  "immediate"`);
- unpaired and offline behaviour is exactly live.

Proposed follow-up (P4/P5 student task): when paired and `FEATURE_ASSESSMENTS` is on, query `GET
/assessments/due?learner_id=` on profile selection. Offer due delayed checks as an optional
"⭐ Bonus check" tile, online only, run through `start` → `answers` → `finish` within one sitting. On any
failure, hide the tile. Do not request baselines after exposure.

## 4. Risks

- The TV-006 physical LG check is still open: service-worker support on the target webOS version, Back
  keyCode 461, and audio autoplay.
- Admin and the student bundle deploy together (ADR-0006). After cutover the service worker is live on
  `breaknlearn.vercel.app`; the kill switch is documented in `apps/student/README.md`.
- Free text: the pairing and linking screens show `display_name` from the server; it is escaped.
