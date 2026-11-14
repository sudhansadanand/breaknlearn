# ADR-0003: Household roles vs. content (staff) roles

- Status: Accepted (2026-11-14)

## Context
The blueprint puts `editor/reviewer/publisher/analyst` in `household_memberships`, which would scope content editing to a household even though curriculum and lessons are global, and would let a content role imply household data access.

## Decision
- `household_memberships.role ∈ {owner, guardian}` — the only roles that can see a household's children, progress, answers and analytics (SEC-010).
- New `staff_roles(auth_user_id, role ∈ {editor, reviewer, publisher, analyst}, granted_by, granted_at, revoked_at)` — global content roles; they grant **no** household data access. `analyst` and content roles see only aggregated, small-cohort-suppressed content metrics.
- `publisher` is distinct from `reviewer`; `owner` may also publish only if also granted `publisher` (explicit capability, spec M12). A reviewer may not approve their own version.
- `system` is not a login role; jobs run with a server-only DB role.
- The initial owner is created by invite for the owner-supplied admin email; no default passwords exist anywhere.

## Consequences
For a single-family deployment the owner will typically hold `owner` + all staff roles; the separation still matters for least privilege and for any future helpers (e.g. an editor who must not see the children's answers).
