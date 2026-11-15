/** Household consent state as the portal and GET /api/v1/admin/consent show it (A9-PRIV-01). */
import type { ActiveConsentRow } from "../repos";
import { CONSENT_SCOPES, CONSENT_STATUS, CONSENT_VERSION, type ConsentScope } from "./consent-text";

export interface ScopeState {
  readonly scope: ConsentScope;
  readonly granted: boolean;
  /** Version of the newest active grant, or null. */
  readonly consent_version: string | null;
  readonly granted_at: string | null;
  /** True when the active grant is for the current notice version. */
  readonly current: boolean;
}

export interface ConsentState {
  readonly current_version: string;
  readonly text_status: "draft" | "approved";
  readonly scopes: readonly ScopeState[];
  /** Some scope is granted only under an older notice version: ask the parent to review the new text. */
  readonly needs_review: boolean;
}

export function consentState(active: readonly ActiveConsentRow[]): ConsentState {
  const scopes = CONSENT_SCOPES.map((scope): ScopeState => {
    const rows = active.filter((r) => r.scope === scope).sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime());
    const current = rows.find((r) => r.consentVersion === CONSENT_VERSION);
    const newest = current ?? rows[0];
    return {
      scope,
      granted: newest !== undefined,
      consent_version: newest?.consentVersion ?? null,
      granted_at: newest ? newest.grantedAt.toISOString() : null,
      current: current !== undefined,
    };
  });
  return { current_version: CONSENT_VERSION, text_status: CONSENT_STATUS, scopes, needs_review: scopes.some((s) => s.granted && !s.current) };
}
