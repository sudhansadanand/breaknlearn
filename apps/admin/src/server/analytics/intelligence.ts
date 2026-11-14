/**
 * Single import point for @bnl/intelligence inside the admin app.
 *
 * TEMPORARY: `@bnl/intelligence` is not yet a dependency of `@bnl/admin` (root/package files are lead-owned;
 * requested in docs/adr/proposals/A8-analytics-contract-additions.md §1). Until the lead adds
 * `"@bnl/intelligence": "workspace:*"` to apps/admin/package.json, the workspace source is imported by path.
 * After that change this line becomes `export * from "@bnl/intelligence";` and nothing else changes.
 */
export * from "../../../../../packages/intelligence/src/index";
