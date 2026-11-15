import { HttpError } from "@bnl/auth";
import { Me } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold } from "../authn";
import { json, readJson, type Ctx } from "../http";
import { CONSENT_SCOPES } from "../privacy/consent-text";
import { consentState } from "../privacy/consent";

/** GET /api/v1/admin/me */
export async function meHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const me = await c.deps.db({ kind: "adult", userId: adult.userId }, async (sql) => {
    const [households, staff] = [await c.deps.repos.memberships.activeMemberships(sql, adult.userId), await c.deps.repos.memberships.activeStaffRoles(sql, adult.userId)];
    return Me.parse({
      user_id: adult.userId,
      email: adult.email,
      households: households.map((h) => ({ household_id: h.householdId, role: h.role })),
      staff_roles: staff,
    });
  });
  return json(c, me);
}

/**
 * OpenAPI recordConsent body. `scopes` is additive (A9-PRIV-01): omitted, a grant or a revoke covers all three scopes,
 * so the original `{consent_version, decision}` body stays valid.
 */
export const ConsentRequest = z.object({
  consent_version: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/),
  decision: z.enum(["grant", "revoke"]),
  scopes: z.array(z.enum(CONSENT_SCOPES)).min(1).max(CONSENT_SCOPES.length).optional(),
});

/** GET /api/v1/admin/consent — owner/guardian: the household's consent per scope and the current notice version. */
export async function getConsentHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const state = await withAdultHousehold(c, adult, async (sql, m) => consentState(await c.deps.repos.consent.active(sql, m.householdId)));
  return json(c, state);
}

/**
 * POST /api/v1/admin/consent — owner/guardian grants or withdraws consent for their household, per scope.
 * Grant is idempotent per (scope, version); withdrawal revokes every active grant of the scope in the household
 * (whoever gave it) and takes effect on the next device request. Audited without names.
 */
export async function consentHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const body = await readJson(req, ConsentRequest);
  const scopes = CONSENT_SCOPES.filter((s) => (body.scopes ?? CONSENT_SCOPES).includes(s));
  const now = c.deps.now();
  const { changed, state } = await withAdultHousehold(c, adult, async (sql, m) => {
    const active = await c.deps.repos.consent.active(sql, m.householdId);
    const changedScopes: string[] = [];
    for (const scope of scopes) {
      const args = { householdId: m.householdId, userId: adult.userId, consentVersion: body.consent_version, at: now, scope };
      if (body.decision === "grant") {
        if (active.some((r) => r.scope === scope && r.consentVersion === body.consent_version)) continue;
        await c.deps.repos.consent.grant(sql, args);
        changedScopes.push(scope);
      } else if ((await c.deps.repos.consent.revoke(sql, args)) > 0) {
        changedScopes.push(scope);
      }
    }
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: body.decision === "grant" ? "consent.granted" : "consent.revoked",
      targetType: "consent_record",
      targetId: null,
      metadata: { consent_version: body.consent_version, role: m.role, scopes, changed_scopes: changedScopes, changed: changedScopes.length },
    });
    return { changed: changedScopes, state: consentState(await c.deps.repos.consent.active(sql, m.householdId)) };
  });
  return json(c, {
    consent_version: body.consent_version,
    decision: body.decision,
    scopes,
    changed_scopes: changed,
    recorded_at: now.toISOString(),
    changed: changed.length > 0,
    state,
  });
}

/** /api/v1/admin/* not yet implemented: 401 without a session, 404 with one (never a data leak). */
export async function notImplementedAdminHandler(req: Request, c: Ctx): Promise<Response> {
  await requireAdult(req, c);
  throw new HttpError(404, "not_found", "Not found");
}
