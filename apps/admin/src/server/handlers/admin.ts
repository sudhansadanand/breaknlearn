import { HttpError } from "@bnl/auth";
import { Me } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold } from "../authn";
import { json, readJson, type Ctx } from "../http";

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

/** OpenAPI recordConsent body (not yet a named contracts schema; see docs/adr/proposals/A2-*.md). */
export const ConsentRequest = z.object({
  consent_version: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  decision: z.enum(["grant", "revoke"]),
});

/** POST /api/v1/admin/consent — guardian/owner records consent for their household. */
export async function consentHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const body = await readJson(req, ConsentRequest);
  const now = c.deps.now();
  const changed = await withAdultHousehold(c, adult, async (sql, m) => {
    const args = { householdId: m.householdId, userId: adult.userId, consentVersion: body.consent_version, at: now };
    let n = 1;
    if (body.decision === "grant") await c.deps.repos.consent.grant(sql, args);
    else n = await c.deps.repos.consent.revoke(sql, args);
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: body.decision === "grant" ? "consent.granted" : "consent.revoked",
      targetType: "consent_record",
      targetId: null,
      metadata: { consent_version: body.consent_version, role: m.role, changed: n },
    });
    return n;
  });
  return json(c, { consent_version: body.consent_version, decision: body.decision, recorded_at: now.toISOString(), changed: changed > 0 });
}

/** /api/v1/admin/* not yet implemented: 401 without a session, 404 with one (never a data leak). */
export async function notImplementedAdminHandler(req: Request, c: Ctx): Promise<Response> {
  await requireAdult(req, c);
  throw new HttpError(404, "not_found", "Not found");
}
