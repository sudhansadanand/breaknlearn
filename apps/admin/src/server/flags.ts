import { HttpError } from "@bnl/auth";

export type FeatureFlag = "FEATURE_PAIRING" | "FEATURE_CATALOG_API" | "FEATURE_SCORES";

/** A flag is on only when exactly "true"; unset or a typo keeps the feature off (same rule as telemetry/assessments). */
export function featureEnabled(flag: FeatureFlag, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[flag] === "true";
}

export function requireFeature(flag: FeatureFlag, what: string): void {
  if (!featureEnabled(flag)) throw new HttpError(503, "feature_disabled", `${what} is not enabled`);
}
