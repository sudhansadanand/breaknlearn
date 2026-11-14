// Existing handler suites exercise pairing, catalog and analytics behaviour, so they run with those rollout flags
// on. test/feature-flags.test.ts proves each handler returns 503 feature_disabled when its flag is unset.
process.env.FEATURE_PAIRING ??= "true";
process.env.FEATURE_CATALOG_API ??= "true";
process.env.FEATURE_SCORES ??= "true";
