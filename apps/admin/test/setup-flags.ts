import { allowAllConsentGate, setConsentGateForTesting } from "../src/server/privacy/gate";

// Existing handler suites exercise pairing, catalog and analytics behaviour, so they run with those rollout flags
// on. test/feature-flags.test.ts proves each handler returns 503 feature_disabled when its flag is unset.
process.env.FEATURE_PAIRING ??= "true";
process.env.FEATURE_CATALOG_API ??= "true";
process.env.FEATURE_SCORES ??= "true";

// Consent gating (A9-PRIV-01) is proven in test/privacy/** and test/integration/privacy-*.test.ts, which install the
// real gate or a store-backed one. Suites about other behaviour run as if the household had consented to every scope.
setConsentGateForTesting(allowAllConsentGate);
