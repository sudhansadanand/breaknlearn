# Existing application inventory (P0A)

**Captured:** 2026-11-14 09:05 UTC from `https://breaknlearn.vercel.app` (read-only HTTP GET).
**Source of truth:** `legacy/live-snapshot-2026-11-14/` (byte-identical, hashes in `SNAPSHOT.md`, verified by `pnpm check:snapshot`).
**Regression suite:** `tests/e2e/legacy-regression.spec.ts` (9 Playwright tests, all passing against the snapshot).

## 1. What is deployed

| Item | Finding |
|---|---|
| Hosting | Vercel static file serving (`server: Vercel`, `x-vercel-cache: HIT`, `cache-control: public, max-age=0, must-revalidate`). |
| Files | Exactly three: `/` (index.html, 24,515 B, inline CSS + one inline IIFE script), `/logo.webp` (110×110), `/music.wav` (16 kHz mono PCM, 409,644 B). No favicon, manifest, robots, service worker, build tooling or API routes. |
| Git | No repository existed. The deployed bytes are the only source. This repo's `main` starts from them. |
| Vercel project | `prj_JtDSfO23dh2PuyOBkLFFIfvaXIUb` per handoff. **Not accessed** (no Vercel credentials in this environment); deployment id, root directory and build settings are unverified. Owner should record the current production deployment id before any cutover so rollback can target it. |
| Dependencies | None. ES5-style JS (`var`, no modules, no arrow functions) — friendly to older LG webOS engines. Keep this property for the student bundle. |
| Third parties | None: no analytics, fonts, CDNs or trackers. `Nunito`/`Fredoka` are named in CSS but never loaded, so TVs render Arial/system fallback. |

## 2. Screens and behaviour

Screens (`screen` variable): `profiles` → `edit` → `subjects` → `stub` | `topics` → `tables` → `themes` → `lesson` → `quiz` → `complete`. Screenshots at 1920×1080 in `screens/`.

- **Profiles:** two fixed slots ("Add Explorer 1/2"). A profile is name (≤30 chars, trimmed), grade 2 or 6, avatar from 12 emoji. No password, no account.
- **Subjects:** grade arrays below; only Grade 2 → Math is live ("Multiplication Tables available"), every other tile shows "Coming soon" and opens a stub. Grade 6 has no playable content.
- **Tables:** ×1…×10, each card shows "N of 6 worlds complete".
- **Worlds:** Puppy Park 🐶, Candy Land 🍬, Unicorn Sky 🦄, School Box ✏️, Treat Time 🍦, Animal Farm 🐴. A "Pick up where you left off" banner shows the most recent incomplete world for the table.
- **Lesson:** 10 slides `F × n = F·n`, `n` groups of `F` emoji, "Count in sevens!" etc. 7 s per slide via a 300 ms ticker (delta capped at 1.3 s per tick, so a frozen tab never skips ahead). Controls overlay (Pause/Resume, Previous, Next, Themes, Restart, Music, Quiz) hidden after 5.2 s, revealed by arrow/Enter keys. Hiding the tab auto-pauses.
- **Quiz:** 3 questions; numbers drawn with `Math.random` from 1..10; 4 unique positive options built from ±F, ±2F, ±3F, ±1; feedback "⭐ Amazing!" / "🌟 Good try!". Score shown on completion screen ("n / 3 quiz stars") but **never persisted**.
- **Music:** `/music.wav` looped at volume 0.35 after a user gesture; autoplay rejection swallowed; per-profile `musicEnabled`.
- **Remote keys:** arrows = spatial focus navigation (custom nearest-neighbour), Enter = activate, Back = `Escape`/`Backspace`/keyCode 461 (webOS)/10009 (Tizen), Play/Pause = Space/`MediaPlayPause`/179.
- **Error path:** render failure shows "Let's try again!" with Retry.

Grade 2: English, Math, Tamil, Hindi, Science, Aadritha, Music.
Grade 6: English, Math, Tamil, Hindi, Physics, Chemistry, Biology, History & Civics, Geography, Western Violin, Carnatic Violin, Aadritha.
(Encoded with stable keys in `packages/contracts/src/catalog.ts`; a test asserts equality with the snapshot's arrays.)

## 3. localStorage — the only persisted state

Only one key is read or written by the live code: **`breaknlearn.profiles.v1`**.

```jsonc
{
  "profiles": [
    {
      "id": "child-1",            // fixed per slot: "child-1" | "child-2" — not a UUID
      "name": "Asha",             // ≤30 chars
      "grade": 2,                 // 2 | 6
      "avatar": "🦊",             // emoji, not an id
      "lessons": {
        "times-3:candy": {        // key = "times-<table>:<worldId>"
          "topicId": "multiplication-3",
          "table": 3,
          "slideId": "step-4",    // "step-N"
          "position": 3.2,        // seconds into slide, clamped 0..7
          "complete": false,
          "updatedAt": 1762990000000 // device clock, epoch ms
        },
        "farm": { "slideId": "three-6", "…": "…" } // OLD ×3-only format: bare world key, "three-N"
      },
      "lastWorld": "candy",
      "lastTable": 3,
      "musicEnabled": true
    }
  ],
  "activeId": "child-1"
}
```

- Bare world keys (`"puppy"`, `"farm"`, …) are read **only for table 3** (`entry()` fallback) and are never rewritten by the live code unless that world is replayed (which then writes a new `times-3:<world>` key; the bare key stays).
- **Historical keys `breaknlearn.progress.v1` and `learnbreak-x3-v4-progress` are not referenced anywhere in the deployed code.** Their shape on real devices is unknown. The migration adapter must back them up verbatim and treat any recognisable world-keyed entries as ×3 only (MIG-003); see ADR-0002 §L2.
- Fixtures: `tests/fixtures/legacy/profiles-v1-two-children.json` (live shape) and `historical-x3-keys.json` (assumed shape, labelled as such).

## 4. Findings that affect the build

| # | Finding | Consequence |
|---|---|---|
| F1 | On load, profiles failing `id && name && grade∈{2,6}` are filtered out and capped at 2; the next `persist()` **overwrites storage without them**. | P3 adapter must copy every legacy key to `breaknlearn.legacy-backup.v1` *before* any new code writes, and must never write a filtered list. |
| F2 | Launching a completed world calls `save(false)`, flipping `complete:true` back to `false` for that `times-F:world` key. Completion is not monotonic in the live app. | Server progress must keep completion history separately (`completed_at` monotonic per attempt; replay = new attempt). Legacy import cannot infer past completions that were overwritten — do not invent them. |
| F3 | Quiz scores, answers and timings are never stored. | No historical accuracy exists to migrate (spec §10.3, MIG-010). ELS starts from first instrumented quiz. |
| F4 | Profile ids are slot-based strings, avatars are emoji. | Contracts use `slot` + `avatar_id`; server learner UUIDs are linked to `(device, local_profile_id)` via a migration alias (ADR-0002 §L1). |
| F5 | `updatedAt` comes from the device clock. | Never used for conflict resolution server-side; server revisions decide (M09). |
| F6 | No offline caching beyond the HTTP cache; `must-revalidate` means a TV offline at launch may fail to load at all. | P3 adds a service worker / app-cache strategy that degrades to the last good bundle (to be verified on a real LG TV). |
| F7 | Fonts named but not loaded. | Keep visual parity by default; adding web fonts later is a deliberate design change, not part of migration. |
| F8 | All interactive targets ≥64 px tall at 1080p (verified by test TV-005). | Keep as a regression gate. |

## 5. Not verified (needs owner or hardware)

- Physical LG webOS model/browser version, real remote Back key behaviour, audio autoplay policy on the TV, and persistence after TV power cycle (TV-006). Headless Chromium results are **not** a substitute.
- Real children's localStorage contents (only synthetic fixtures were used).
- Vercel project settings, domains and the current production deployment id.
