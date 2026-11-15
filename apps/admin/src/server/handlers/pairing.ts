import {
  HttpError,
  MAX_PAIRING_FAILED_ATTEMPTS,
  createPairingCode,
  decideRefresh,
  hashPairingCode,
  issueRefreshToken,
  normalizePairingCode,
  pairingState,
  parseRefreshToken,
  signDeviceAccessToken,
  verifyPollSecret,
  type IssuedRefreshToken,
} from "@bnl/auth";
import {
  ApprovePairingRequest,
  DeviceRefreshRequest,
  DeviceTokenRequest,
  DeviceTokenResponse,
  PairingCodeResponse,
} from "@bnl/contracts";
import { z } from "zod";
import { requireAdult, requireCsrf, withAdultHousehold } from "../authn";
import { clientIp, json, readJson, validationFailed, type Ctx } from "../http";
import { enforceRateLimit } from "../rate-limits";
import type { DeviceRow } from "../repos";
import { requireFeature } from "../flags";
import { requireHouseholdConsent } from "../privacy/gate";

const gone = () => new HttpError(410, "not_found", "Pairing expired, already used, or unknown; start again on the TV");

async function credential(c: Ctx, device: DeviceRow, refresh: IssuedRefreshToken): Promise<DeviceCredential> {
  const access = await signDeviceAccessToken(
    c.deps.keys.deviceToken,
    { deviceId: device.id, householdId: device.householdId, tokenVersion: device.tokenVersion },
    c.deps.now(),
  );
  return DeviceTokenResponse.parse({
    device_id: device.id,
    household_id: device.householdId,
    access_token: access.token,
    access_expires_at: access.expiresAt.toISOString(),
    refresh_token: refresh.token,
  });
}
type DeviceCredential = z.infer<typeof DeviceTokenResponse>;

/**
 * POST /api/v1/devices/pairing-code — public, rate-limited per IP.
 * PRIVILEGED CONTEXT: runs as `{kind:"job"}` because no household exists yet;
 * it only inserts one pairing row holding hashes (code HMAC, poll-secret sha256).
 */
export async function createPairingCodeHandler(req: Request, c: Ctx): Promise<Response> {
  requireFeature("FEATURE_PAIRING", "Pairing");
  await enforceRateLimit(c, "pairingCodeByIp", clientIp(req));
  const now = c.deps.now();
  const p = createPairingCode(c.deps.keys.pairingCode, now, c.deps.uuid);
  await c.deps.db({ kind: "job" }, (sql) =>
    c.deps.repos.pairing.insert(sql, { pairingId: p.pairingId, codeHash: p.codeHash, pollSecretHash: p.pollSecretHash, expiresAt: p.expiresAt }),
  );
  const body = PairingCodeResponse.parse({ pairing_id: p.pairingId, code: p.code, poll_secret: p.pollSecret, expires_at: p.expiresAt.toISOString() });
  return json(c, body, 201);
}

const ApproveBody = z.object({ code: z.string().max(32), device_label: ApprovePairingRequest.shape.device_label });

/** POST /api/v1/devices/pair — owner/guardian approves the TV's code for their own household. */
export async function approvePairingHandler(req: Request, c: Ctx): Promise<Response> {
  const adult = await requireAdult(req, c);
  requireFeature("FEATURE_PAIRING", "Pairing");
  requireCsrf(req, c);
  await enforceRateLimit(c, "approveByUser", adult.userId);
  const body = await readJson(req, ApproveBody);
  const code = normalizePairingCode(body.code);
  if (code === null) throw validationFailed([{ path: ["code"], code: "invalid_string" }], "Pairing code format is invalid");
  const now = c.deps.now();

  // Runs as the adult: RLS must let bnl_adult see/claim *unclaimed* codes (household_id is null)
  // and insert paired_devices only for households where it holds owner/guardian.
  const deviceId = await withAdultHousehold(c, adult, async (sql, m) => {
    // A9-PRIV-01: a TV only syncs a child's data once a parent has consented to learning data.
    await requireHouseholdConsent(sql, m.householdId, ["learning_data"]);
    const row = await c.deps.repos.pairing.findByCodeHash(sql, hashPairingCode(c.deps.keys.pairingCode, code));
    if (!row || pairingState(row, now) !== "pending") {
      throw new HttpError(404, "not_found", "Pairing code not found or expired");
    }
    const device = await c.deps.repos.devices.insert(sql, { householdId: m.householdId, label: body.device_label, at: now });
    await c.deps.repos.pairing.markApproved(sql, { id: row.id, householdId: m.householdId, approvedBy: adult.userId, deviceId: device.id, at: now });
    await c.deps.repos.audit.insert(sql, {
      actorAuthId: adult.userId,
      householdId: m.householdId,
      action: "device.pair_approved",
      targetType: "paired_device",
      targetId: device.id,
      metadata: { pairing_id: row.pairingId, role: m.role },
    });
    return device.id;
  });
  return json(c, { device_id: deviceId });
}

type RedeemOutcome =
  | { kind: "gone" }
  | { kind: "bad_secret" }
  | { kind: "pending" }
  | { kind: "issued"; device: DeviceRow; refresh: IssuedRefreshToken };

/**
 * POST /api/v1/devices/token — TV polls with pairing_id + poll_secret.
 * 202 pending; 200 exactly once after approval; 410 expired/consumed/locked.
 * PRIVILEGED CONTEXT: `{kind:"job"}` because the TV holds no credential yet.
 * It touches only the row addressed by pairing_id (after the poll secret is
 * verified in constant time) and the device that row was approved into.
 */
export async function redeemTokenHandler(req: Request, c: Ctx): Promise<Response> {
  requireFeature("FEATURE_PAIRING", "Pairing");
  await enforceRateLimit(c, "tokenPollByIp", clientIp(req));
  const body = await readJson(req, DeviceTokenRequest);
  const now = c.deps.now();
  const { repos } = c.deps;

  // State changes (failed-attempt counter) must commit, so the transaction
  // returns an outcome and errors are raised after it.
  const outcome = await c.deps.db({ kind: "job" }, async (sql): Promise<RedeemOutcome> => {
    const row = await repos.pairing.findByPairingId(sql, body.pairing_id);
    if (!row) return { kind: "gone" };
    const state = pairingState(row, now);
    if (state === "redeemed" || state === "expired" || state === "locked") return { kind: "gone" };
    if (!verifyPollSecret(body.poll_secret, row.pollSecretHash)) {
      const failures = await repos.pairing.incrementFailedAttempts(sql, row.id);
      return failures >= MAX_PAIRING_FAILED_ATTEMPTS ? { kind: "gone" } : { kind: "bad_secret" };
    }
    if (state === "pending") return { kind: "pending" };
    const device = row.deviceId ? await repos.devices.get(sql, row.deviceId) : null;
    await repos.pairing.markRedeemed(sql, { id: row.id, at: now });
    if (!device || device.revokedAt !== null || device.householdId !== row.householdId) return { kind: "gone" };
    const refresh = issueRefreshToken(c.deps.keys.refreshToken, device.householdId, device.id);
    await repos.devices.setRefreshHash(sql, { id: device.id, hash: refresh.hash, at: now });
    await repos.audit.insert(sql, {
      actorAuthId: null,
      householdId: device.householdId,
      action: "device.token_redeemed",
      targetType: "paired_device",
      targetId: device.id,
      metadata: { pairing_id: row.pairingId },
    });
    return { kind: "issued", device, refresh };
  });

  switch (outcome.kind) {
    case "gone":
      throw gone();
    case "bad_secret":
      throw new HttpError(401, "unauthorized", "Pairing credentials rejected");
    case "pending":
      return json(c, { status: "pending" }, 202, { "Retry-After": "3" });
    case "issued":
      return json(c, await credential(c, outcome.device, outcome.refresh));
  }
}

type RefreshOutcome = { kind: "rejected" } | { kind: "reuse" } | { kind: "rotated"; device: DeviceRow; refresh: IssuedRefreshToken };

/**
 * POST /api/v1/devices/token/refresh — rotates the refresh token.
 * Runs in the device's own context (ids come from the MAC-authenticated
 * envelope). Replaying a superseded token revokes the device (theft signal).
 */
export async function refreshTokenHandler(req: Request, c: Ctx): Promise<Response> {
  await enforceRateLimit(c, "refreshByIp", clientIp(req));
  const body = await readJson(req, DeviceRefreshRequest);
  const parsed = parseRefreshToken(c.deps.keys.refreshToken, body.refresh_token);
  if (!parsed) throw new HttpError(401, "unauthorized", "Refresh token rejected");
  const now = c.deps.now();
  const { repos } = c.deps;

  const outcome = await c.deps.db(
    { kind: "device", householdId: parsed.householdId, deviceId: parsed.deviceId },
    async (sql): Promise<RefreshOutcome> => {
      const device = await repos.devices.get(sql, parsed.deviceId);
      if (!device || device.householdId !== parsed.householdId) return { kind: "rejected" };
      const decision = decideRefresh(parsed.hash, device);
      if (decision === "revoked") return { kind: "rejected" };
      if (decision === "reuse_detected") {
        await repos.devices.revoke(sql, { id: device.id, householdId: device.householdId, at: now });
        await repos.audit.insert(sql, {
          actorAuthId: null,
          householdId: device.householdId,
          action: "device.refresh_reuse_revoked",
          targetType: "paired_device",
          targetId: device.id,
          metadata: {},
        });
        return { kind: "reuse" };
      }
      const refresh = issueRefreshToken(c.deps.keys.refreshToken, device.householdId, device.id);
      await repos.devices.setRefreshHash(sql, { id: device.id, hash: refresh.hash, at: now });
      return { kind: "rotated", device, refresh };
    },
  );

  if (outcome.kind !== "rotated") throw new HttpError(401, "unauthorized", "Refresh token rejected");
  return json(c, await credential(c, outcome.device, outcome.refresh));
}
