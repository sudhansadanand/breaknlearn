import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const PAIRING_CODE_TTL_SECONDS = 600;
/** 8 chars from an unambiguous alphabet (no 0/O/1/I/L). */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PairingCode = z.string().regex(/^[2-9A-HJKMNP-Z]{8}$/);

export const PairingCodeResponse = z.object({
  pairing_id: Uuid,
  code: PairingCode,
  /** Secret only the TV holds; required to redeem the approved pairing. */
  poll_secret: z.string().min(32).max(128),
  expires_at: IsoDateTime,
});

export const ApprovePairingRequest = z.object({
  code: PairingCode,
  device_label: z.string().trim().min(1).max(40),
});

export const DeviceTokenRequest = z.object({ pairing_id: Uuid, poll_secret: z.string().min(32).max(128) });
export const DeviceRefreshRequest = z.object({ refresh_token: z.string().min(32).max(512) });

export const DeviceTokenResponse = z.object({
  device_id: Uuid,
  household_id: Uuid,
  access_token: z.string(),
  access_expires_at: IsoDateTime,
  refresh_token: z.string(),
});

/** Claims inside the short-lived device access token (server-signed, verified on every call). */
export const DeviceTokenClaims = z.object({
  sub: Uuid, // device_id
  hid: Uuid, // household_id
  ver: z.number().int().positive(), // paired_devices.token_version; bump to revoke
  scope: z.literal("device"),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type DeviceTokenClaims = z.infer<typeof DeviceTokenClaims>;

export const Device = z.object({
  id: Uuid,
  label: z.string(),
  paired_at: IsoDateTime,
  last_seen_at: IsoDateTime.nullable(),
  revoked_at: IsoDateTime.nullable(),
});
