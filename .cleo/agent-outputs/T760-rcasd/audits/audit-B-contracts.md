# Audit B: Contracts (T779/T780/T795)

Audited by: AUDIT AGENT B
Date: 2026-04-15
Method: Zero-trust — source read + test execution only. Worker self-reports not consulted.

---

## T779 AcceptanceGate

### Variants verified

All 6 variants present as TypeScript interfaces in `packages/contracts/src/acceptance-gate.ts`:
- `test` (TestGate) — run command, assert exit code/test-count
- `file` (FileGate) — assert properties of a file on disk
- `command` (CommandGate) — run any CLI command, assert exit code/stdout
- `lint` (LintGate) — run static-analysis tool, require clean result
- `http` (HttpGate) — hit URL, assert status + optional body
- `manual` (ManualGate) — explicit escape hatch requiring human/agent verdict

Each variant carries `GateBase` fields (`req?`, `description`, `advisory?`, `timeoutMs?`).

### Discriminator

`kind` discriminant confirmed. Union is:
```
export type AcceptanceGate = TestGate | FileGate | CommandGate | LintGate | HttpGate | ManualGate;
```

### Zod schema

`acceptanceGateSchema` in `acceptance-gate-schema.ts` uses `z.discriminatedUnion('kind', [...])` with all 6 variants. Schema verified correct.

### FileAssertion type

`FileAssertion` is a discriminated union on `type` with 8 assertion types:
`exists`, `absent`, `nonEmpty`, `maxBytes`, `minBytes`, `contains`, `matches`, `sha256`

The audit spec said 4 assertion types. Actual implementation has 8. This is an extension, not a deficit — all 4 spec-listed types (exists, nonEmpty, contains, matches) are present plus 4 additional well-formed types.

### GateResult type — NAMING DISCREPANCY

The audit spec refers to `GateResult` with fields `gateIndex, req?, kind, passed, details, ranAt, duration`. This type DOES NOT EXIST as specified.

What actually exists:
- `GateResult` from `./warp-chain.ts` — unrelated WarpChain type (`gateId, passed, forced, message, evaluatedAt`)
- `AcceptanceGateResult` from `./acceptance-gate.ts` — the T779 result type (`index, req?, kind, result, durationMs, evidence, errorMessage, checkedAt, checkedBy`)

The field names in `AcceptanceGateResult` differ from the spec's expected names:
- spec `gateIndex` → actual `index`
- spec `passed` → actual `result` (enum: pass/fail/warn/skipped/error, richer but different shape)
- spec `details` → actual `evidence`
- spec `ranAt` → actual `checkedAt`
- spec `duration` → actual `durationMs`

The type is functionally coherent but the field names do not match the audit specification. This is a minor naming drift from the spec, not a functional defect.

### Exports from index.ts

Confirmed present:
- `AcceptanceGate` — PASS
- `AcceptanceGateResult` — PASS (spec said `GateResult`, actual is `AcceptanceGateResult`)
- `FileAssertion` — PASS
- `acceptanceGateSchema` — PASS
- `acceptanceItemSchema` — PASS (bonus export from T780)
- `acceptanceArraySchema` — PASS (bonus export from T780)
- `GateResult` from warp-chain also exported — unrelated legacy type

Zod schema: PASS
GateResult type shape: PARTIAL — exported as `AcceptanceGateResult`, field names differ from audit spec

### Tests passing

Contracts package: 90/91 pass (1 failure in acceptance-gate.test.ts — see T780 section below).
When running non-verbose: initial report showed 91/91 pass. On verbose run, 3 tests fail.

Actual count: **49/52 pass** in acceptance-gate.test.ts (3 failures — see T780 below).

### Build clean

`pnpm --filter @cleocode/contracts run build` — no errors output (exit 0). Build: **clean**.

**T779 verdict: CONDITIONAL PASS**
- Structure correct, 6 variants, Zod discriminated union working, exports present.
- `AcceptanceGateResult` field names drift from spec (`index` not `gateIndex`, `result` not `passed`, etc.) — the type is internally consistent but deviates from the audit specification.
- 3 test failures exist but are caused by T800 tightening + test message mismatches (see T780).

---

## T780 Task.acceptance widening

### Task.acceptance field type widened

`Task.acceptance` in `packages/contracts/src/task.ts`:
```typescript
acceptance?: AcceptanceItem[];
```
where `AcceptanceItem = string | AcceptanceGate` — CONFIRMED WIDENED.

### TaskCreate.acceptance field — NOT widened

`TaskCreate.acceptance` in `packages/contracts/src/task.ts` line 319:
```typescript
acceptance?: string[];
```

The input type for task creation is still `string[]` only. This is consistent with the CLI input model (gates are added post-creation), but represents an asymmetry. The audit spec did not explicitly require `TaskCreate` widening.

Additionally, `AddTaskEnforcementOptions.acceptance` and `UpdateTaskEnforcementOptions.acceptance` in `packages/core/src/tasks/enforcement.ts` remain `string[]`. These are the internal options types, not the contract type.

### Union schema exists

`acceptanceItemSchema = z.union([z.string(), acceptanceGateSchema])` — CONFIRMED PRESENT (line 205, acceptance-gate-schema.ts).
`acceptanceArraySchema = z.array(acceptanceItemSchema)` — CONFIRMED PRESENT (with `.min(1)` constraint added by T800).

### Old string[] usage check

`grep -rn "acceptance:.*string\[\]" packages/core/src packages/contracts/src` — zero hits in schema definitions. The two string[] occurrences in `enforcement.ts` are for the internal options types (CLI input layer), not the Task/schema layer.

### Test failures in acceptanceArraySchema (3 failures)

Three tests fail due to test message regex mismatches vs actual Zod error messages:

1. **"rejects empty string in array"** — test expects `/string must be non-empty/i` but schema message is `"Acceptance string criterion must be non-empty. Provide a non-blank description..."`. The test regex is wrong.

2. **"rejects whitespace-only string in array"** — same root cause as above. Test regex `/string must be non-empty/i` does not match actual message.

3. **"rejects malformed gate object"** — test expects error matching `/must be either a non-empty string OR a valid AcceptanceGate/i` but Zod produces a generic `"Invalid input"` message. The schema does not emit the expected custom message for union failures on malformed objects.

Root cause: T800 tightened `acceptanceArraySchema` (added `.min(1)`, string `.min(1)`, `.refine()` for REQ-ID uniqueness) but the 3 failing tests expected specific error message strings that do not match the actual Zod messages produced. These are **test expectation bugs** introduced by T800 (or the test writer used incorrect regex patterns).

The schema structure itself is correct. The `.min(1)` constraint is enforced (verified by the passing "rejects an empty array (T800)" test). The union schema parses mixed arrays correctly (verified by passing tests at lines 610+).

### Regressions in existing tests

The 13 failures in `@cleocode/core` run are:
- 7 failures: `anthropic-key-resolver-source.test.ts` — tagged `@task T791` (different task). `resolveAnthropicApiKeySource` not yet exported from the source module. Pre-existing broken test.
- 6 failures: `hebbian-threshold.test.ts` — tagged `@task T790`. `strengthenCoRetrievedEdgesForTest` not exported from `brain-lifecycle.ts`. Pre-existing broken test.

None of the 13 core failures are attributable to T779/T780/T795.

Schema type widened: PASS
Union schema exists: PASS
Regressions in existing tests from T780: 0

**T780 verdict: PARTIAL PASS**
- Schema widening is correct and complete at the `Task` level.
- 3 test failures in acceptance-gate.test.ts due to error message regex mismatches (T800 message drift). Tests need updating to match actual Zod messages.
- `TaskCreate.acceptance` remains `string[]` — may be intentional but creates asymmetry.

---

## T795 Attachment

### Variants verified

5 attachment variants in `packages/contracts/src/attachment.ts`:
- `local-file` (LocalFileAttachment)
- `url` (UrlAttachment)
- `blob` (BlobAttachment)
- `llms-txt` (LlmsTxtAttachment)
- `llmtxt-doc` (LlmtxtDocAttachment)

Discriminated union on `kind`:
```typescript
export type Attachment = LocalFileAttachment | UrlAttachment | BlobAttachment | LlmsTxtAttachment | LlmtxtDocAttachment;
```

### AttachmentMetadata fields

`AttachmentMetadata` in `attachment.ts` — CONFIRMED with expected fields:
- `id: string` — unique attachment ID
- `sha256: string` — content hash
- `attachment: Attachment` — full attachment value
- `createdAt: string` — ISO 8601 creation timestamp
- `refCount: number` — reference count for GC

`mime` is NOT a top-level field on `AttachmentMetadata` (it lives inside the variant-specific `Attachment` value). This is correct design — the mime type is variant-specific.

### AttachmentRef fields

`AttachmentRef` in `attachment.ts` — CONFIRMED with expected fields:
- `attachmentId: string`
- `ownerType: 'task' | 'observation' | 'session' | 'decision' | 'learning' | 'pattern'`
- `ownerId: string`
- `attachedAt: string`
- `attachedBy?: string`

### Zod schemas

`attachment-schema.ts` exports:
- `attachmentSchema` — discriminated union on `kind` with all 5 variants
- `attachmentMetadataSchema` — validates registry row
- `attachmentRefSchema` — validates junction row
- Individual variant schemas: `localFileAttachmentSchema`, `urlAttachmentSchema`, `blobAttachmentSchema`, `llmsTxtAttachmentSchema`, `llmtxtDocAttachmentSchema`

All 5 variant schemas present and individually exported.

### Exports from index.ts

Confirmed present:
- `Attachment`, `AttachmentKind`, `AttachmentMetadata`, `AttachmentRef` — PASS
- `BlobAttachment`, `LlmsTxtAttachment`, `LlmtxtDocAttachment`, `LocalFileAttachment`, `UrlAttachment` — PASS
- `attachmentSchema` and all 5 variant schemas — PASS
- `AttachmentMetadataSchemaInput`, `AttachmentRefSchemaInput`, `AttachmentSchemaInput` — PASS

### Tests passing

`attachment.test.ts` — no output from `grep attachment` in verbose run, meaning the attachment test file passed with no failures. Attachment tests: all pass.

Contracts total: 49/52 pass; 3 failures are in acceptance-gate.test.ts (T780/T800 scope), 0 in attachment.test.ts.

Schemas present: PASS
Tests passing: all attachment tests pass

**T795 verdict: PASS**

---

## Cross-contract issues

1. **GateResult naming drift**: `AcceptanceGateResult` field names differ from the audit specification (`index` vs `gateIndex`, `result` vs `passed`, `durationMs` vs `duration`, `checkedAt` vs `ranAt`, `evidence` vs `details`). The type is internally consistent and well-documented but deviates from what was expected in this audit. A `GateResult` type also exists (from warp-chain.ts) which is unrelated — naming proximity is a hazard.

2. **3 test failures in acceptance-gate.test.ts**: Error message regex mismatches in T800-tagged tests. The schema enforces the constraints correctly (functionally correct) but the test error-message assertions are wrong. These failures are in the contracts package tests and will show as red in CI.

3. **TaskCreate.acceptance remains string[]**: The input type for task creation is not widened. Whether this is intentional (gate objects added only via update, not at creation) is unclear from the code. No documentation in TaskCreate explains this asymmetry.

4. **T791/T790 broken tests in core**: `resolveAnthropicApiKeySource` (T791) and `strengthenCoRetrievedEdgesForTest` (T790) are imported in tests but not yet exported from source modules. These are pre-existing failures unrelated to T779/T780/T795 but they muddy the core test results.

5. **acceptanceArraySchema has .min(1)**: The T780 spec described `acceptanceArraySchema = z.array(acceptanceItemSchema)` (unconstrained). The actual schema has `.min(1)` added by T800 plus a `.refine()` for REQ-ID uniqueness. T780 is functionally satisfied; the extra constraints are additive from T800.

## Recommended re-spawn

**Re-spawn needed**: Fix the 3 failing acceptance-gate.test.ts tests.

The 3 test failures are in `packages/contracts/src/__tests__/acceptance-gate.test.ts` at lines 610, 616, 627. The tests check for specific error message substrings (`/string must be non-empty/i`, `/must be either a non-empty string OR a valid AcceptanceGate/i`) that do not match the actual Zod error messages emitted by `acceptanceArraySchema`. The fix requires either:
- (a) Update the test regexes to match actual Zod messages (e.g. `/acceptance string criterion must be non-empty/i`), OR
- (b) Add `.min(1, 'string must be non-empty')` to the string branch in `acceptanceItemSchema` and add a custom message to the union failure path.

Option (b) preserves the design intent (user-readable errors). Either option is low-risk. This is a contracts-only change.

The T791 and T790 core failures are out of scope for this audit (different tasks) but should be tracked separately.

---

## Summary

| Task | Verdict | Key Issue |
|------|---------|-----------|
| T779 AcceptanceGate | CONDITIONAL PASS | Field names differ from spec; 3 test failures (T800 message drift) |
| T780 Task.acceptance widening | PARTIAL PASS | Schema correct; 3 test message mismatches; TaskCreate not widened |
| T795 Attachment | PASS | All 5 variants, schemas, exports verified; tests pass |

Overall: **2/3 PASS** (T795 clean; T779/T780 have test failures that block CI green)
