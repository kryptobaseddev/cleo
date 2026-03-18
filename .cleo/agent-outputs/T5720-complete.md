# T5720 — Rewire MCP + remaining imports from src/core/ to @cleocode/core

**Task**: T5720
**Epic**: T5701
**Date**: 2026-03-17
**Status**: complete

---

## Summary

All 7 source files in `src/mcp/` that had `../core/` or `../../core/` imports have been rewired to `@cleocode/core`. Missing exports were added to `src/core/index.ts` to make all referenced symbols available. TypeScript typechecks clean and the build completes successfully.

## Changes Made

### src/core/index.ts — New exports added

Added the following previously-missing flat exports:

**Compliance:**
- `ProtocolType`, `protocolEnforcer` from `./compliance/protocol-enforcement.js`
- `ViolationLogEntry` (type) from `./compliance/protocol-enforcement.js`
- `PROTOCOL_RULES` from `./compliance/protocol-rules.js`
- `ProtocolRule`, `ProtocolValidationResult`, `ProtocolViolation`, `RequirementLevel`, `ViolationSeverity` (types)

**Hooks:**
- `HookRegistry`, `hooks` from `./hooks/registry.js` (direct flat export, complementing the `coreHooks` namespace)

**Sessions:**
- `getCurrentSessionId` from `./sessions/context-alert.js`

**System:**
- `startupHealthCheck`, `StartupHealthResult` from `./system/health.js`

**Tasks:**
- `normalizeTaskId` from `./tasks/id-generator.js`

**Validation:**
- Full set from `./validation/operation-verification-gates.js`: `GateLayer`, `GateStatus`, `GATE_SEQUENCE`, `VerificationGate`, `WorkflowGateName`, `WorkflowGateTracker`, `WORKFLOW_GATE_DEFINITIONS`, `WORKFLOW_GATE_SEQUENCE`, `getWorkflowGateDefinition`, `isValidWorkflowGateName` + all related types
- Full set from `./validation/operation-gate-validators.js`: `GATE_VALIDATION_RULES`, `isFieldRequired`, `VALID_WORKFLOW_AGENTS`, `VALID_WORKFLOW_GATE_STATUSES`, `validateLayer1Schema`, `validateLayer2Semantic`, `validateLayer3Referential`, `validateLayer4Protocol`, `validateWorkflowGateName`, `validateWorkflowGateStatus`, `validateWorkflowGateUpdate`

### Source files rewired (7 files, ~20 import occurrences)

| File | Before | After |
|------|--------|-------|
| `src/mcp/index.ts` | 6 `../core/...` named imports + 3 dynamic imports | All → `@cleocode/core` |
| `src/mcp/lib/gateway-meta.ts` | `../../core/sessions/context-alert.js` | `@cleocode/core` |
| `src/mcp/lib/security.ts` | `../../core/tasks/id-generator.js` | `@cleocode/core` |
| `src/mcp/lib/protocol-rules.ts` | `../../core/compliance/protocol-rules.js` | `@cleocode/core` |
| `src/mcp/lib/protocol-enforcement.ts` | `../../core/compliance/protocol-enforcement.js` | `@cleocode/core` |
| `src/mcp/lib/gate-validators.ts` | `../../core/validation/operation-gate-validators.js` | `@cleocode/core` |
| `src/mcp/lib/verification-gates.ts` | `../../core/validation/operation-verification-gates.js` | `@cleocode/core` |

### Test files rewired (2 files)

| File | Change |
|------|--------|
| `src/mcp/__tests__/strict-mode-review.test.ts` | `../../core/errors.js` + `../../core/output.js` → `@cleocode/core` |
| `src/mcp/__tests__/startup-logging.test.ts` | `../../core/logger.js` → `@cleocode/core` |

### Test files left unchanged (1 file)

- `src/mcp/__tests__/mcp-auto-init.test.ts` — has `vi.mock('../../core/nexus/registry.js', ...)` targeting a specific submodule path; per task instructions, relative imports in vi.mock calls are preserved.

### Special case: side-effect import preserved

`src/mcp/index.ts` line 28: `import '../core/hooks/handlers/index.js'` was intentionally left as a relative path. This is a side-effect-only import (no named exports) that auto-registers hook handlers at module load time. Changing it to `@cleocode/core` would not guarantee the same side-effect registration behavior under tree-shaking.

## Verification

```
npx tsc --noEmit   → 0 errors
npm run build      → Build complete
grep checks        → 0 remaining ../core/ imports in src/mcp/, src/dispatch/, src/cli/ source files
```

## References

- T5718: dispatch imports rewired (pattern established)
- T5716: @cleocode/core standalone package (esbuild bundle)
- T5701: core extraction epic
