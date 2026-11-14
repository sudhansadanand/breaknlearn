# ADR-0004: One lesson per multiplication table; worlds are rendering themes

- Status: Accepted (2026-11-14)

## Decision
- 10 lessons `grade2.math.multiplication.table-1..10`, template `picture_groups_v1`, config `{factor, count_from:1, count_to:10, themes:[puppy,candy,unicorn,school,treat,farm], seconds_per_slide:7, quiz_question_count:3}`.
- Fixed ids (UUIDv5, namespace `6f1d2a0e-6b1e-4a35-9a4e-2f6c3b8d9e10`, name = stable key) in `@bnl/contracts` so the seed, the student fallback catalog and legacy migration agree offline.
- Progress, telemetry and attempts carry `theme_key` so "6 worlds complete" per table remains computable exactly as today.
- Slide ids stay `step-1..step-10` (live format) so legacy resume positions map 1:1.

## Consequences
The per-world progress UI ("N of 6 worlds complete", resume banner) is preserved. Editing a table's content creates one new version covering all six worlds, which is what an editor expects.
