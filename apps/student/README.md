# @bnl/student — BreakNLearn TV app

The ES5 port of the deployed app (`legacy/live-snapshot-2026-11-14/index.html`). Without pairing it behaves
**exactly** as the live app: same markup, strings, 7 s slides, quiz, music, remote keys, ≥64 px targets, and
`breaknlearn.profiles.v1` in the same shape. `tests/e2e/student-parity.spec.ts` drives the snapshot and this
bundle side by side and compares `#app` markup, storage and focus after every step.

## Build and run

```sh
pnpm --filter @bnl/student build      # → apps/student/dist/{index.html, app.js, sw.js, logo.webp, music.wav, build.json}
pnpm --filter @bnl/student dev        # build + serve dist on http://127.0.0.1:4173
pnpm --filter @bnl/student test       # vitest: storage/backup/migration, queue, outbox, catalog, paired, build/ES5
pnpm --filter @bnl/student typecheck  # src at lib ES5+DOM (no ES2015 built-ins can slip in), tests at ES2022
```

- `src/*.ts` is transpiled by the workspace TypeScript (`target ES5`, CommonJS) and joined by
  `scripts/build.mjs` into one IIFE with a tiny module loader. No new dependencies.
- `scripts/es5-check.mjs` walks the output AST and fails the build on any non-ES5 syntax (let/const,
  arrows, classes, templates, spread, destructuring, `?.`, `??`, `**`, async/generators, ES2015 regex flags,
  modules). `test/build.test.ts` additionally parses with acorn `ecmaVersion: 5` once acorn is a declared
  dev dependency.
- `index.html` is the live page byte-for-byte except the inline script, which becomes
  `<script src="/app.js?v=<build>">` (test-enforced). `logo.webp` and `music.wav` are the live bytes.
- `public/` still holds the untouched live snapshot (it is what `apps/admin` copies today, see ADR-0006).

## Storage

| Key | Written by | Notes |
|---|---|---|
| `breaknlearn.profiles.v1` | app | Live shape. Profiles that the live filter hides are written back after the visible ones and never dropped (F1). |
| `breaknlearn.legacy-backup.v1` | first launch | `{version:1, created_at, items}` — verbatim copy of all three legacy keys, taken **before** any other write; never overwritten. |
| `breaknlearn.progress.v1`, `learnbreak-x3-v4-progress` | never | Read only, for the guardian-assigned import. |
| `breaknlearn.student-config.v1` | paired | Last server flags (used offline). |
| `breaknlearn.device.v1` | paired | Device credential from `/devices/token`. |
| `breaknlearn.catalog.v1` | paired | Last good **complete** catalog (manifest + all lessons). |
| `breaknlearn.telemetry-queue.v1` | paired | Durable event queue (cap 1500, evidence events never dropped). |
| `breaknlearn.progress-outbox.v1` | paired | Progress sync outbox (frozen in-flight requests). |
| `breaknlearn.profile-links.v1`, `breaknlearn.server-profiles.v1`, `breaknlearn.attempts.v1`, `breaknlearn.legacy-import.v1` | paired | Links, attempt ids, import runs and receipts. |

F2 (a replayed completed world becomes `complete:false`) is kept locally because it is live behaviour. The
server never sees the regression: a replay or restart starts a new `attempt_id`, and completion is monotonic
within an attempt.

## Flags (runtime, from the server)

`GET /api/v1/student/config` → `{"paired_mode": bool, "telemetry": bool, "service_worker": bool}`.
A 404, an error or no network keeps the last known value (default: paired mode off, service worker on).
With `paired_mode` on, a **📺 Family account** button appears under the profiles. That screen holds pairing
(the 8-char code from `/devices/pairing-code`, polling `/devices/token`), linking explorers, and disconnecting.
Once the TV is paired and an explorer is linked:

- the catalog comes from `/catalog/manifest?grade=2` and `/catalog/lessons/{id}` (ETag, last good cache;
  built-in ×1–×10 offline, unpaired, or when any lesson is invalid);
- telemetry is posted to `/telemetry/batch` with `Idempotency-Key: tb-<first event id>-<n>`; `sent_at` is
  frozen at creation, so retries are byte-identical;
- progress is posted to `/progress/sync` with `Idempotency-Key: ps-<attempt>-<client_revision>`;
- legacy import is posted to `/progress/legacy-import` once per newly linked profile, with
  `Idempotency-Key: li-<run id>`. It uses the `legacyFingerprint` semantics, and the snapshot holds only
  linked profiles. The historical ×3 keys are uploaded only when a guardian picks a learner for them.

All network failures degrade silently. The quiz is always the local three-question quiz. Assessment answers
are never queued offline (A7).

## Service worker and kill switch (F6)

`sw.js` serves only `/`, `/index.html`, `/app.js`, `/logo.webp` and `/music.wav`. It is network-first, with a
fallback to the last good cached copy (`bnl-student-<build>`). It never intercepts `/api/**` or `/admin/**`.
Old engines without service-worker support use the plain HTTP cache, as the live app does.

You can turn it off in three ways:
1. **Server flag:** `"service_worker": false` in `/api/v1/student/config`. Every TV unregisters the worker
   and deletes `bnl-student-*` caches on its next online launch.
2. **Per device:** open `/?sw=off`.
3. **Emergency (no app logic needed):** deploy this file as `/sw.js`. Browsers re-check the worker script
   on navigation, so it replaces itself, wipes the caches and unregisters:
   ```js
   self.addEventListener("install", function (e) { self.skipWaiting(); });
   self.addEventListener("activate", function (e) {
     e.waitUntil(caches.keys().then(function (k) {
       return Promise.all(k.filter(function (n) { return n.indexOf("bnl-student-") === 0; }).map(function (n) { return caches.delete(n); }));
     }).then(function () { return self.registration.unregister(); }));
   });
   ```
To remove the worker from the build entirely, drop the `enableServiceWorker` call in `src/main.ts`. Ship the
emergency `sw.js` above for one release so that installed workers go away.

## Not verified here

Physical LG webOS behaviour (TV-006): remote Back key, audio autoplay, service-worker support and
`localStorage` persistence across power cycles. Headless Chromium results are not a substitute.
