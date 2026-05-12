# T1702: Fix task.schema.json emission pipeline

**Date**: 2026-05-02
**Status**: completed
**Commit**: 9dc9c72d8cc3daa4809ba4b2b9748d9d075ccf0d (branch: task/T1702)

## Root Cause

All 6 emitted schemas in `packages/contracts/schemas/` were broken stubs (`"Task": {}`) because:

- The project uses **Zod v4.3.6**
- `emit-schemas.mjs` imported `zod-to-json-schema` v3.25.2 which only works with Zod v3 schemas
- Zod v4 schemas have a different internal structure (`def` key instead of `_def`) that `zodToJsonSchema()` cannot read
- The result was empty `{}` definitions for every schema, silently committed

## Fix

Replaced `zodToJsonSchema()` from `zod-to-json-schema` with Zod v4's native `.toJSONSchema()` method via a thin `toJsonSchema()` helper in `emit-schemas.mjs`. Removed the `zod-to-json-schema` import entirely.

## Files Changed

| File | Change |
|------|--------|
| `packages/contracts/scripts/emit-schemas.mjs` | Replace `zodToJsonSchema` import with native Zod v4 `toJSONSchema()` helper |
| `packages/contracts/schemas/task.schema.json` | Re-emitted — now 17,623 bytes with full Task definition |
| `packages/contracts/schemas/acceptance-gate.schema.json` | Re-emitted — 11,216 bytes with full schema |
| `packages/contracts/schemas/attachment.schema.json` | Re-emitted — 4,596 bytes with full schema |
| `packages/contracts/schemas/gate-result.schema.json` | Re-emitted — 5,571 bytes with full schema |
| `packages/contracts/schemas/gate-result-details.schema.json` | Re-emitted — 3,588 bytes with full schema |
| `packages/contracts/schemas/task-evidence.schema.json` | Re-emitted — 5,688 bytes with full schema |

## Verification

- `pnpm --filter @cleocode/contracts run build` succeeds cleanly (tsc + emit-schemas)
- `pnpm --filter @cleocode/contracts run test`: 5 test files, 148 tests, all passed
- `pnpm biome ci .`: 2071 files checked, no issues
- All schemas upgraded from draft-07 stubs to complete draft/2020-12 schemas
- manifest-v1.json (hand-crafted, not emitted) unchanged

## Key Findings

1. The bug was systemic — ALL 6 emitted schemas were broken, not just task.schema.json
2. Root cause: Zod v4 migration happened but emit-schemas.mjs was not updated to use native toJSONSchema()
3. zod-to-json-schema v3.25.2 silently produces empty stubs (no error thrown) when given Zod v4 schemas
4. Fix requires zero new dependencies — Zod v4 has built-in JSON Schema emission
