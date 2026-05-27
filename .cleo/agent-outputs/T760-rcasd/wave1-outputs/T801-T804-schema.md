# T801-T804 SCHEMA-02 to SCHEMA-05 — Schema Hardening Batch

**Status**: complete
**Date**: 2026-04-15
**Worker**: single agent

---

## T801 SCHEMA-02 — TaskEvidence interface

**File**: `packages/contracts/src/task-evidence.ts`

Added discriminated union `TaskEvidence` with 5 evidence kinds:
- `file` — file artifact with `sha256`, `timestamp`, `path`, optional `mime`
- `log` — log stream with `sha256`, `timestamp`, `source`
- `screenshot` — visual capture with `sha256`, `timestamp`, optional `mime` (png/jpeg/webp)
- `test-output` — structured test run with `sha256`, `timestamp`, `passed`, `failed`, `skipped`, `exitCode`
- `command-output` — CLI output with `sha256`, `timestamp`, `cmd`, `exitCode`

All variants: SHA-256 attachment ref + ISO 8601 timestamp + optional `description`.

Zod schemas exported: `fileEvidenceSchema`, `logEvidenceSchema`, `screenshotEvidenceSchema`, `testOutputEvidenceSchema`, `commandOutputEvidenceSchema`, `taskEvidenceSchema`.

Index exports: types `TaskEvidence`, `TaskEvidenceKind`, `FileEvidence`, `LogEvidence`, `ScreenshotEvidence`, `TestOutputEvidence`, `CommandOutputEvidence`, `TaskEvidenceInput` + all schemas.

---

## T802 SCHEMA-03 — GateResult typed details

**Files modified**: `packages/contracts/src/acceptance-gate.ts`, `packages/contracts/src/acceptance-gate-schema.ts`

Added `GateResultDetails` discriminated union (6 kind-specific variants):
```ts
type GateResultDetails =
  | { kind: 'test'; exitCode: number; stdout: string; stderr: string; duration: number }
  | { kind: 'file'; path: string; passedAssertions: string[]; failedAssertions: string[] }
  | { kind: 'command'; cmd: string; exitCode: number; stdout: string }
  | { kind: 'lint'; tool: string; warnings: number; errors: number }
  | { kind: 'http'; url: string; status: number; body: string }
  | { kind: 'manual'; prompt: string; accepted: boolean }
```

Updated `AcceptanceGateResult.details?: GateResultDetails` (replaces untyped JSON).
The legacy `evidence?: string` field is retained for backward compatibility.

Zod schema `gateResultDetailsSchema` added and exported from index.
`AcceptanceGateResult` Zod schema updated to include `details: gateResultDetailsSchema.optional()`.

---

## T803 SCHEMA-04 — JSON Schema export for LLM tool-use

**Files**:
- `packages/contracts/scripts/emit-schemas.mjs` (new)
- `packages/contracts/package.json` (updated scripts + files)

Installed `zod-to-json-schema@^3.25.2` as a dependency.

Scripts added:
- `"build": "tsc -b --force && node scripts/emit-schemas.mjs"` (replaces tsc-only build)
- `"build:ts": "tsc -b --force"` (TypeScript-only)
- `"build:schemas": "node scripts/emit-schemas.mjs"` (schemas-only)

Added `"schemas"` to `files` array for npm publish.

Schemas emitted to `packages/contracts/schemas/`:
- `task.schema.json`
- `acceptance-gate.schema.json`
- `attachment.schema.json`
- `gate-result.schema.json`
- `gate-result-details.schema.json`
- `task-evidence.schema.json`

---

## T804 SCHEMA-05 — Contract invariant tests

**File**: `packages/contracts/src/__tests__/invariants.test.ts` (new)

Tests assert 3 rules:

**Rule 1 — No bare string on notes/details/text fields (with whitelist)**
- `GateResultDetails` is a discriminated union, not bare string
- `AcceptanceGateResult.details` wraps a discriminated union (not string)
- `TaskEvidence` is a discriminated union
- Whitelist registry documents 10 acceptable string exceptions with rationale

**Rule 2 — Discriminated unions use `kind` discriminant (not `type`)**
- `acceptanceGateSchema` → `kind`
- `gateResultDetailsSchema` → `kind`
- `taskEvidenceSchema` → `kind`
- `attachmentSchema` → `kind`
- `fileAssertionSchema` → `type` (documented exception, legacy)

**Rule 3 — Major Zod schemas are exported from index**
- `acceptanceGateSchema`, `acceptanceGateResultSchema`, `gateResultDetailsSchema`, `taskEvidenceSchema`, `attachmentSchema` all exported and callable
- Variant counts verified: `acceptanceGate` 6, `gateResultDetails` 6, `taskEvidence` 5
- Round-trip parse tests for all `GateResultDetails` and `TaskEvidence` variants

---

## Proof

```
$ ls packages/contracts/schemas/*.schema.json 2>&1 | wc -l
6

$ pnpm --filter @cleocode/contracts run test 2>&1 | tail -5
 Test Files  5 passed (5)
      Tests  148 passed (148)
   Start at  09:33:48
   Duration  3.30s

$ grep -c "kind: 'test'\|kind: 'file'\|kind: 'command'\|kind: 'lint'\|kind: 'http'\|kind: 'manual'" packages/contracts/src/acceptance-gate.ts
14
```

---

## Files changed

- `packages/contracts/src/task-evidence.ts` (new — T801)
- `packages/contracts/src/acceptance-gate.ts` (updated — T802: GateResultDetails, details field)
- `packages/contracts/src/acceptance-gate-schema.ts` (updated — T802: gateResultDetailsSchema, result schema)
- `packages/contracts/src/index.ts` (updated — all new exports)
- `packages/contracts/scripts/emit-schemas.mjs` (new — T803)
- `packages/contracts/package.json` (updated — T803: scripts + files + dependency)
- `packages/contracts/src/__tests__/invariants.test.ts` (new — T804)
- `packages/contracts/schemas/*.schema.json` (emitted — T803, 6 files)
