---
id: t9845-tier-ssot-regression-lock
tasks: [T9845]
kind: test
summary: Add real-registry tier-filter snapshot test locking cleo ops Tier 0/1/2 surface (T9845 closeout — T10061 already moved OPERATIONS+tier SSoT to contracts)
---

Investigation found T10061 (T9833b · E-CLI-BOUNDARY · SG-ARCH-SOLID) already relocated the OPERATIONS array and the tier field SSoT from packages/cleo/src/dispatch/registry.ts to packages/contracts/src/dispatch/operations-registry.ts. registry.ts is now a thin re-export shim. Closing T9845 with a focused regression-lock snapshot test (packages/core/src/admin/__tests__/help-tier-snapshot.test.ts) that exercises computeHelp against the REAL OPERATIONS registry. Locks per-tier operationCount (43/281/400), domain-grouped operations, verbose-mode cost-hint surface, and tier-guidance strings. Existing coverage (operations-registry.test.ts JSON snapshot + operation-def.test.ts compile-time pins + help.test.ts fixture behavior) is preserved.
