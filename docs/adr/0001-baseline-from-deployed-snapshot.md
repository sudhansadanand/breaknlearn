# ADR-0001: Baseline the student app from the deployed snapshot and evolve it by wrapping

- Status: Accepted (2026-11-14)
- Deciders: A0 (lead agent); owner informed in project thread

## Context
No git repository existed for BreakNLearn; `breaknlearn.vercel.app` serving three static files was the only copy (see `docs/inventory/EXISTING_APP_INVENTORY.md`). AGENTS.md requires a faithful compatibility port when source is not otherwise retrievable, and forbids replacing the live app with a blank framework app.

## Decision
1. `legacy/live-snapshot-2026-11-14/` holds the exact bytes (hash-checked in CI) and is never edited.
2. `apps/student/public/` starts as an identical copy. Until P3, the student app *is* the live app.
3. P3 changes the student app **incrementally** around the existing render loop: a catalog adapter, a storage/migration adapter, an offline cache and a telemetry emitter, each feature-flagged. It keeps ES5-compatible output for LG webOS.
4. `tests/e2e/legacy-regression.spec.ts` pins live behaviour; every later PR must keep it green (tests may only be loosened via an ADR).

## Consequences
- Rollback target before cutover is simply the current Vercel production deployment; after cutover, redeploying `legacy/live-snapshot-2026-11-14` reproduces today's app exactly.
- The Vercel project's build settings are unknown; the owner must confirm them (or grant read access) before P7.
