# T781 Gate-Runner TypeScript Import Fix

**Status**: COMPLETE

**Issue**: gate-runner.ts had 5 unresolved import errors from @cleocode/contracts.

**Root Cause**: Acceptance gate types and schemas were defined in acceptance-gate.ts and acceptance-gate-schema.ts but not re-exported from the contracts package index.

**Fix Applied**:
- Added type exports for: AcceptanceGate, AcceptanceGateResult, CommandGate, FileGate, FileAssertion, TestGate, LintGate, HttpGate, ManualGate, GateBase, AcceptanceGateKind
- Added schema exports for: acceptanceGateSchema, acceptanceArraySchema, acceptanceGateResultSchema, acceptanceItemSchema, fileAssertionSchema, fileGateSchema, commandGateSchema, lintGateSchema, httpGateSchema, manualGateSchema, testGateSchema, gateBaseSchema
- Added schema type exports: AcceptanceGateSchemaInput, AcceptanceArrayInput, AcceptanceGateResultInput, AcceptanceItemInput, FileAssertionInput

**Verification**:
- ✓ @cleocode/contracts builds clean (tsc -b)
- ✓ @cleocode/core builds clean (zero gate-runner.ts errors)
- ✓ All 10+ types/schemas now exported from index.ts

**Files Modified**: packages/contracts/src/index.ts (+27 export lines)
