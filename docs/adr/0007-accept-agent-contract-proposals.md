# ADR-0007: Accept agent contract proposals A1, A2, A3, A4, A6

- Status: Accepted by lead, 2026-11-14.
- Context: ADR-0002 froze contracts v1.1. Specialist agents could not edit frozen files, so each recorded its
  additions and interpretations in `docs/adr/proposals/`.

## Decision

All five proposals are accepted as written. Each is additive (new endpoints, optional fields, named schemas for
operations that had none, or clarified behaviour). None changes a frozen v1.1 field or event type, so the
learning-event schema and existing OpenAPI operations stay byte-compatible.

| Proposal | Scope | Notes on acceptance |
|---|---|---|
| A1 DB interpretations | quality_flag values, RLS reliance, job role | Basis of migrations 0001–0003. |
| A2 identity additions | adult session endpoints, CSRF cookie, pairing/refresh envelopes | Implemented in P1 (#2). |
| A3 curriculum/import | curriculum, school-plan and import endpoints, migration 0004, storage env | Lead-owned edits done in P2: SEC-001 now auto-discovers routes (no hand list), portal pages and nav added. |
| A4 CMS additions | admin lesson API, catalog, migration 0005 item bank | Same SEC-001/nav edits. |
| A6 learning additions | `historical_learner_id`, receipt `historical` block, idempotency scopes, `Idempotent-Replayed`, telemetry 413/503 | Historical (×3-only) entries are written only after explicit guardian assignment, never guessed (MIG-003). |

## Follow-ups
- Fold the new endpoints and the `Idempotent-Replayed` header / 409 into `openapi.yaml` as contracts v1.2 in P6, with a
  parity test, rather than editing v1.1 piecemeal.
- Quiz item key format: A4's `bnl.quiz_items` keys differ from `multiplicationItemKey` (lesson-engine). P4
  assessments adopt the stored A4 key as canonical and lesson-engine maps to it.
