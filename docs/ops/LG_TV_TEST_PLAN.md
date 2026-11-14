# LG webOS TV test plan (TV-006)

**Status: NOT RUN.** There is no LG TV in the development environment.

Automated headless-Chromium results (`tests/e2e/*`) are **never** a substitute for this checklist (TV-006). Run it:
- on staging before P7;
- again on production after the student bundle cutover;
- after any later student release.

Use **SYNTHETIC** explorer names on a test household, or the owner's own household with the owner present.

## Record first

| Field | Value |
|---|---|
| Date, tester | |
| TV model (Settings → General → About This TV) | |
| webOS version / firmware | |
| Web browser version (browser → Settings → About) | |
| Remote type (Magic Remote / basic IR) | |
| Network (Wi-Fi/Ethernet) | |
| URL and build (`/api/v1/student/config` → build, `build.json`) | |
| Flags at the time (`paired`, `service_worker`) | |

## Checklist

Mark each step pass/fail and attach a photo or video for every fail.

1. **Launch:**
   - open the production URL (or the home-screen shortcut created with the old app; the URL must not change);
   - the profile screen appears in under 5 s on Wi-Fi;
   - the logo and fonts render;
   - nothing is clipped at the screen edges (16:9 safe area).
2. **Legacy progress intact:**
   - on a TV that used the **old** app, every explorer is still listed with name, avatar and grade;
   - the ×1/×3 "continue" banners and per-world progress match what the child had before;
   - no explorer is duplicated or missing (MIG-001/002/003).
3. **Remote navigation:**
   - arrows move a clearly visible focus ring on every screen;
   - OK/Enter selects;
   - no screen needs the pointer (TV-001, TV-005).
4. **Back key (keyCode 461):**
   - in a lesson, Back leaves the lesson to the world list;
   - on the profile screen, Back does not trap the user (webOS may exit the browser);
   - record the exact behaviour.
5. **Autoplay and audio:**
   - slides advance every 7 s in order 1→10, and pause stops the timer (TV-003);
   - music either plays or, if webOS blocks autoplay, the lesson continues silently with no error, and pressing the Music button after a key press starts it (TV-004);
   - muting is remembered per explorer after relaunch.
6. **Power-cycle persistence:**
   - finish a world, then power the TV fully off (unplug for 30 s) and on;
   - relaunch: progress and profiles are still there (localStorage survives).
7. **Service worker and offline launch:**
   - check whether this webOS browser supports service workers (record it);
   - disconnect the network and relaunch: with SW support, the last good bundle opens, a cached lesson and its quiz work, and progress is kept;
   - reconnect: queued progress and telemetry upload once (check the guardian portal, with no duplicate activity) (MIG-005).
8. **Pairing** (only with `paired` on):
   - Family account → code shown in large type;
   - approve it in `/admin/devices` from a phone;
   - the TV moves to "Link explorers" within 10 s;
   - link, then confirm the legacy import receipt;
   - revoke the TV in the portal: the TV keeps playing locally and stops syncing (SEC-004).
9. **Kill switch and rollback** (staging only):
   - set `FEATURE_STUDENT_SW=false` and relaunch the TV online: the worker is removed (record the result of `/?sw=off` too);
   - promote the legacy deployment: the old app loads with all progress intact (`ROLLBACK.md`).
10. **Performance:**
    - no visible stutter during slide transitions;
    - the quiz responds to a key press within 300 ms;
    - note memory warnings or reloads during 20 minutes of continuous play.
11. **Reduced motion / readability:** text is readable from 2.5 m, and the focus ring is visible from the sofa.

## Result

| Step | Pass/Fail | Notes / evidence link |
|---|---|---|
| 1–11 | | |

Sign-off (owner): ______________________ Date: __________
