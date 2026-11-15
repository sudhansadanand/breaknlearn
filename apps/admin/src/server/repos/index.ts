import { sqlDeviceRepo } from "./sql-devices";
import { sqlAuditRepo, sqlConsentRepo, sqlMembershipRepo, sqlRateLimitRepo } from "./sql-misc";
import { sqlPairingRepo } from "./sql-pairing";
import { sqlProfileRepo } from "./sql-profiles";
import type { Repos } from "./types";

export type * from "./types";

export const sqlRepos: Repos = {
  pairing: sqlPairingRepo,
  devices: sqlDeviceRepo,
  profiles: sqlProfileRepo,
  memberships: sqlMembershipRepo,
  consent: sqlConsentRepo,
  audit: sqlAuditRepo,
  rateLimits: sqlRateLimitRepo,
};
