import { HttpError } from "@bnl/auth";
import { Device, Uuid } from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold } from "../authn";
import { json, validationFailed, type Ctx } from "../http";
import type { DeviceRow } from "../repos";

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());

export function toDevice(row: DeviceRow): z.infer<typeof Device> {
  return Device.parse({ id: row.id, label: row.label, paired_at: iso(row.createdAt), last_seen_at: iso(row.lastSeenAt), revoked_at: iso(row.revokedAt) });
}

/** GET /api/v1/devices — devices in the caller's household. */
export async function listDevicesHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  const rows = await withAdultHousehold(c, adult, (sql, m) => c.deps.repos.devices.listForHousehold(sql, m.householdId));
  return json(c, { devices: rows.map(toDevice) });
}

/** POST /api/v1/devices/{deviceId}/revoke — bumps token_version, sets revoked_at, clears refresh hash. */
export async function revokeDeviceHandler(req: Request, c: Ctx, deviceIdParam: string): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireCsrf(req, c);
  const id = Uuid.safeParse(deviceIdParam);
  if (!id.success) throw validationFailed([{ path: ["deviceId"], code: "invalid_string" }], "deviceId must be a UUID");
  const now = c.deps.now();
  const row = await withAdultHousehold(c, adult, async (sql, m) => {
    const revoked = await c.deps.repos.devices.revoke(sql, { id: id.data, householdId: m.householdId, at: now });
    // Unknown and other-household ids are indistinguishable (no existence oracle).
    if (!revoked) throw new HttpError(403, "forbidden", "Device is not in your household");
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "device.revoked",
      targetType: "paired_device",
      targetId: revoked.id,
      metadata: { token_version: revoked.tokenVersion },
    });
    return revoked;
  });
  return json(c, { device: toDevice(row) });
}
