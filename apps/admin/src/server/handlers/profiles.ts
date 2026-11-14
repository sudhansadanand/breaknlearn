import { HttpError, type AdultIdentity } from "@bnl/auth";
import { Profile, ProfilePreferences, ProfileUpsert, type DeviceTokenClaims } from "@bnl/contracts";
import type { z } from "zod";
import { hasBearer, requireAdult, requireCsrf, verifyDeviceBearer, withAdultHousehold, withDevice } from "../authn";
import type { Sql } from "../db-port";
import { json, readJson, validationFailed, type Ctx } from "../http";
import type { ProfileRow } from "../repos";

export const MAX_PROFILES_PER_HOUSEHOLD = 2;

export function toProfile(row: ProfileRow): Profile {
  return Profile.parse({
    id: row.id,
    slot: row.slot,
    display_name: row.displayName,
    grade: row.grade,
    avatar_id: row.avatarId,
    preferences: ProfilePreferences.parse(row.preferences ?? {}),
    updated_at: new Date(row.updatedAt).toISOString(),
  });
}

type Caller =
  | { kind: "device"; claims: DeviceTokenClaims }
  | { kind: "adult"; adult: AdultIdentity };

/** Bearer => paired device; otherwise the adult cookie session (mutations also need CSRF). */
async function resolveCaller(req: Request, c: Ctx, mutation: boolean): Promise<Caller> {
  if (hasBearer(req)) return { kind: "device", claims: await verifyDeviceBearer(req, c) };
  const adult = await requireAdult(req, c);
  if (mutation) requireCsrf(req, c);
  return { kind: "adult", adult };
}

/** Household always comes from the verified credential, never from the request. */
function inHousehold<T>(c: Ctx, caller: Caller, fn: (sql: Sql, householdId: string) => Promise<T>): Promise<T> {
  return caller.kind === "device"
    ? withDevice(c, caller.claims, (sql) => fn(sql, caller.claims.hid))
    : withAdultHousehold(c, caller.adult, (sql, m) => fn(sql, m.householdId));
}

/** GET /api/v1/profiles */
export async function listProfilesHandler(req: Request, c: Ctx): Promise<Response> {
  const caller = await resolveCaller(req, c, false);
  const rows = await inHousehold(c, caller, (sql, hid) => c.deps.repos.profiles.listForHousehold(sql, hid));
  return json(c, { profiles: rows.slice(0, MAX_PROFILES_PER_HOUSEHOLD).map(toProfile) });
}

/**
 * POST /api/v1/profiles — upsert by id within the caller's household.
 * - id outside the household => 403 (whether or not it exists elsewhere)
 * - a third profile, or a slot held by another profile => 422
 * - display_name markup/control chars => 422 (contract DisplayName)
 */
export async function upsertProfileHandler(req: Request, c: Ctx): Promise<Response> {
  const caller = await resolveCaller(req, c, true);
  const body: z.infer<typeof ProfileUpsert> = await readJson(req, ProfileUpsert);
  const now = c.deps.now();
  const { profiles, audit } = c.deps.repos;

  const saved = await inHousehold(c, caller, async (sql, householdId) => {
    const write = {
      id: body.id,
      householdId,
      slot: body.slot,
      displayName: body.display_name,
      grade: body.grade,
      avatarId: body.avatar_id,
      preferences: ProfilePreferences.parse(body.preferences ?? {}),
      at: now,
    };
    const existing = await profiles.getInHousehold(sql, body.id, householdId);
    let row: ProfileRow;
    if (existing) {
      const r = await profiles.update(sql, write);
      if (r.kind === "slot_taken") throw validationFailed([{ path: ["slot"], code: "slot_taken" }], "That profile slot is already in use");
      if (r.kind === "missing") throw new HttpError(403, "forbidden", "Profile is not in your household");
      row = r.row;
    } else {
      const current = await profiles.listForHousehold(sql, householdId);
      if (current.length >= MAX_PROFILES_PER_HOUSEHOLD) {
        throw validationFailed([{ path: ["id"], code: "profile_limit" }], "A household can have at most two profiles");
      }
      if (current.some((p) => p.slot === body.slot)) {
        throw validationFailed([{ path: ["slot"], code: "slot_taken" }], "That profile slot is already in use");
      }
      const r = await profiles.insert(sql, write);
      if (r.kind === "id_taken") throw new HttpError(403, "forbidden", "Profile is not in your household");
      if (r.kind === "slot_taken") throw validationFailed([{ path: ["slot"], code: "slot_taken" }], "That profile slot is already in use");
      row = r.row;
    }
    await audit.insert(sql, {
      actorAuthId: caller.kind === "adult" ? caller.adult.userId : null,
      householdId,
      action: existing ? "profile.updated" : "profile.created",
      targetType: "learner_profile",
      targetId: row.id,
      // Never the display name (spec M01: redact names).
      metadata: { slot: row.slot, via: caller.kind, ...(caller.kind === "device" ? { device_id: caller.claims.sub } : {}) },
    });
    return row;
  });
  return json(c, toProfile(saved));
}
