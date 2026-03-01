# T4879: IVTR Protocol Validation Decomposition

**Task:** T4879 -- Decompose IVTR protocol validation for execution stages
**Parent:** T4855 -- RCSD Schema Review & RCASD Rename Analysis
**Date:** 2026-02-25
**Status:** Complete
**Depends:** T4860 (ADR-014)

---

## Executive Summary

This document decomposes the IVTR (Implementation, Validation, Testing, Release) execution-stage protocol outputs. For each of the 4 execution stages, it defines: (1) what structured output is produced, (2) whether a Zod validation schema is needed, (3) the mapping between protocol instructions and runtime artifacts, and (4) concrete implementation tasks.

**Key decision (from ADR-014):** Use hybrid approach -- validate critical metadata fields only (confidence, verdict, provenance links), not full archived schema structures. Validation triggers at `ct complete` as a gate.

---

## 1. Current State Analysis

### Existing Protocol Validators (`src/core/validation/protocols/`)

| File | Protocol | Validation Level | What It Checks |
|------|----------|-----------------|----------------|
| `consensus.ts` | Consensus | Manifest entry | `agent_type === 'analysis'`, optional voting matrix |
| `specification.ts` | Specification | Manifest entry + file | `agent_type === 'specification'`, RFC 2119 keywords, version |
| `decomposition.ts` | Decomposition | Manifest entry | `agent_type === 'specification'` |
| `implementation.ts` | Implementation | Manifest entry | `agent_type === 'implementation'` |
| `contribution.ts` | Contribution | Manifest entry | `agent_type === 'implementation'` |

**Missing validators:** Research (no `research.ts`), Validation, Testing, Release.

### Common Validator Pattern

All existing validators follow an identical structure:
1. `findManifestEntry()` -- scan MANIFEST.jsonl for task ID
2. Parse manifest entry JSON
3. Check `agent_type` field against expected value
4. Return `ValidationResult` with violations array and score
5. Optionally check additional files (spec content, voting matrix)

### Protocol-to-Stage Mapping

| Protocol File | Stage (`stages.ts`) | Exit Code | Existing Validator |
|---------------|--------------------|-----------|--------------------|
| `protocols/implementation.md` (IMPL) | `implement` | 64 | `implementation.ts` |
| `protocols/validation.md` (VALID) | `verify` | -- (not assigned) | None |
| `protocols/testing.md` (TEST) | `test` | -- (not assigned) | None |
| `protocols/release.md` (REL) | `release` | 66 | None |

**Note:** The protocol IDs (IMPL, VALID, TEST, REL) use different naming than `stages.ts` stage identifiers (`implement`, `verify`, `test`, `release`). The protocol files use long-form names; `stages.ts` uses short canonical names.

---

## 2. Per-Stage Decomposition

### 2.1 Implementation Stage (`implement`)

**Protocol:** `protocols/implementation.md` (IMPL, v1.0.1)
**Existing validator:** `src/core/validation/protocols/implementation.ts`
**Exit code:** 64

#### What the Protocol Requires

| Req ID | Level | Requirement |
|--------|-------|-------------|
| IMPL-001 | MUST | Include tests for new functionality |
| IMPL-002 | MUST | Follow project code style conventions |
| IMPL-003 | MUST | Include JSDoc/docstring provenance tags |
| IMPL-004 | MUST | Verify changes pass existing tests |
| IMPL-005 | MUST | Document breaking changes |
| IMPL-006 | MUST | Write implementation summary to manifest |
| IMPL-007 | MUST | Set `agent_type: "implementation"` in manifest |

#### Current Validation

Only checks IMPL-007 (`agent_type`). Does not validate IMPL-001 through IMPL-006.

#### Recommended Validation Schema

**Level: Manifest-entry-only + lightweight file check**

The implementation stage produces code changes (not a structured document), so deep Zod validation is inappropriate. Instead, extend the existing validator:

```typescript
// Extend src/core/validation/protocols/implementation.ts
const ImplementationOutputMeta = z.object({
  agentType: z.literal('implementation'),
  hasTests: z.boolean(),                    // IMPL-001: test files modified
  hasProvenance: z.boolean(),               // IMPL-003: @task tags present
  testsPass: z.boolean(),                   // IMPL-004: existing tests pass
  breakingChanges: z.boolean(),             // IMPL-005: breaking changes documented
  filesModified: z.number().int().min(1),   // At least one file changed
  status: z.enum(['complete', 'partial', 'blocked']),
});
```

**Validation approach:** Check manifest entry fields. Optionally check git diff for provenance tags (IMPL-003) and test file changes (IMPL-001). Do NOT run tests at validation time (that's the Testing stage's job).

#### Assessment: MINIMAL extension needed

The existing `implementation.ts` validator is adequate for the gate-at-complete trigger. Add optional `hasTests` and `hasProvenance` boolean checks to manifest entry validation. No new file needed.

---

### 2.2 Validation Stage (`verify`)

**Protocol:** `protocols/validation.md` (VALID, v1.0.1)
**Existing validator:** None
**Exit code:** Not assigned (recommend using 67 = generic, or allocating a new code)

#### What the Protocol Requires

| Req ID | Level | Requirement |
|--------|-------|-------------|
| VALID-001 | MUST | Verify implementation matches specification |
| VALID-002 | MUST | Run existing test suite and report results |
| VALID-003 | MUST | Check protocol compliance via validation library |
| VALID-004 | MUST | Document pass/fail status for each validation check |
| VALID-005 | MUST | Write validation summary to manifest |
| VALID-006 | MUST | Set `agent_type: "validation"` in manifest |
| VALID-007 | MUST | Block progression if critical validations fail |

#### Expected Output

A **validation report** markdown file with structured results:
- Status: PASS / FAIL / PARTIAL
- Checks passed: X/Y
- Critical issues count
- Per-check result table (check name, result, notes)

#### Recommended Validation Schema

**Level: Zod schema (new file)**

The validation stage produces a structured report with pass/fail results. This warrants a lightweight Zod schema:

```typescript
// NEW: src/core/validation/protocols/validation-protocol.ts
// (named validation-protocol.ts to avoid confusion with the parent directory name)
export const ValidationOutputMeta = z.object({
  agentType: z.literal('validation'),
  status: z.enum(['PASS', 'FAIL', 'PARTIAL']),
  totalChecks: z.number().int().min(1),
  passedChecks: z.number().int().min(0),
  failedChecks: z.number().int().min(0),
  criticalIssues: z.number().int().min(0),
  testsRun: z.boolean(),                    // VALID-002
  testsPass: z.boolean().optional(),        // Only if tests were run
  specComplianceChecked: z.boolean(),       // VALID-001
  protocolComplianceChecked: z.boolean(),   // VALID-003
});
```

**Gate behavior:** If `status === 'FAIL'` and `criticalIssues > 0`, block progression (VALID-007).

#### Assessment: NEW validator needed

Create `src/core/validation/protocols/validation-protocol.ts`. This is the most structurally important IVTR validator because it gates whether implementation can proceed to testing.

---

### 2.3 Testing Stage (`test`)

**Protocol:** `protocols/testing.md` (TEST, v1.0.1)
**Existing validator:** None
**Exit code:** Not assigned (recommend 67 or new allocation)

#### What the Protocol Requires

| Req ID | Level | Requirement |
|--------|-------|-------------|
| TEST-001 | MUST | Write tests using appropriate framework |
| TEST-002 | MUST | Place unit tests in `tests/unit/` |
| TEST-003 | MUST | Place integration tests in `tests/integration/` |
| TEST-004 | MUST | Achieve 100% pass rate before release |
| TEST-005 | MUST | Test all MUST requirements from specifications |
| TEST-006 | MUST | Write test summary to manifest |
| TEST-007 | MUST | Set `agent_type: "testing"` in manifest |

#### Expected Output

A **test report** markdown file with:
- Total tests, passed, failed, skipped counts
- Pass rate percentage
- Test files created table
- Requirement coverage table

#### Recommended Validation Schema

**Level: Zod schema (new file)**

```typescript
// NEW: src/core/validation/protocols/testing-protocol.ts
export const TestingOutputMeta = z.object({
  agentType: z.literal('testing'),
  totalTests: z.number().int().min(0),
  passedTests: z.number().int().min(0),
  failedTests: z.number().int().min(0),
  skippedTests: z.number().int().min(0),
  passRate: z.number().min(0).max(100),
  testFilesCreated: z.number().int().min(0),
  requirementsCovered: z.number().int().min(0),
  status: z.enum(['PASS', 'FAIL', 'PARTIAL']),
});
```

**Gate behavior:** If `passRate < 100`, block progression to release (TEST-004). Allow advisory mode to proceed with warnings.

#### Assessment: NEW validator needed

Create `src/core/validation/protocols/testing-protocol.ts`. The test report structure is simple but the pass-rate gate is critical for release readiness.

---

### 2.4 Release Stage (`release`)

**Protocol:** `protocols/release.md` (REL, v2.2.0)
**Existing validator:** None (release has its own validation via `cleo release validate`)
**Exit code:** 66

#### What the Protocol Requires

| Req ID | Level | Requirement |
|--------|-------|-------------|
| RLSE-001 | MUST | Follow semantic versioning |
| RLSE-002 | MUST | Update changelog with all changes |
| RLSE-003 | MUST | Pass all validation gates before release |
| RLSE-004 | MUST | Tag release in version control |
| RLSE-005 | MUST | Document breaking changes with migration path |
| RLSE-006 | MUST | Verify version consistency across files |
| RLSE-007 | MUST | Set `agent_type: "documentation"` in manifest |

#### Expected Output

A **release record** with:
- Version (semver)
- Previous version
- Change type (major/minor/patch)
- Validation gate results table
- Breaking changes list

#### Recommended Validation Schema

**Level: Manifest-entry-only (leverage existing release infrastructure)**

The release protocol already has extensive validation via `cleo release ship` with its 6-filter pipeline, release guards, and validation gates. Adding a Zod schema here would duplicate existing infrastructure.

```typescript
// Extend existing release validation OR add minimal metadata check
export const ReleaseOutputMeta = z.object({
  agentType: z.literal('documentation'),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/),  // RLSE-001
  previousVersion: z.string().optional(),
  changeType: z.enum(['major', 'minor', 'patch']).optional(),
  changelogUpdated: z.boolean(),           // RLSE-002
  gitTagCreated: z.boolean(),              // RLSE-004
  versionConsistent: z.boolean(),          // RLSE-006
  breakingChanges: z.boolean(),            // RLSE-005
});
```

**Gate behavior:** Defer to existing `cleo release validate` for most checks. The protocol validator only needs to verify manifest-level metadata.

#### Assessment: MINIMAL validator sufficient

The release protocol already has the most mature validation of any stage (via `cleo release ship`). Add a thin `src/core/validation/protocols/release-protocol.ts` that checks manifest metadata. Do not duplicate the existing release validation infrastructure.

---

## 3. Summary: Validation Level Matrix

| Stage | Protocol | Validator Status | Recommended Level | New File? | Priority |
|-------|----------|-----------------|-------------------|-----------|----------|
| `implement` | IMPL | Exists (basic) | Manifest-entry + extend | No (extend existing) | Low |
| `verify` | VALID | Missing | Zod schema (new) | Yes | High |
| `test` | TEST | Missing | Zod schema (new) | Yes | High |
| `release` | REL | Missing (but `cleo release validate` exists) | Manifest-entry (thin) | Yes | Medium |

### Also Missing (RCASD Planning Stages)

| Stage | Protocol | Status | Note |
|-------|----------|--------|------|
| `research` | RSCH | Missing validator file | Was identified in T4857 as highest priority |
| `adr` | ADR | No protocol validator | New stage, needs new protocol file too |

---

## 4. Implementation Tasks

### Task 1: Create `validation-protocol.ts` validator (HIGH priority)

**File:** `src/core/validation/protocols/validation-protocol.ts`
**Scope:** New Zod schema for validation stage output metadata. Implements `validateValidationTask()` following the pattern of existing validators. Checks `agent_type: "validation"`, status enum, check counts, critical issues count.

### Task 2: Create `testing-protocol.ts` validator (HIGH priority)

**File:** `src/core/validation/protocols/testing-protocol.ts`
**Scope:** New Zod schema for testing stage output metadata. Implements `validateTestingTask()`. Checks `agent_type: "testing"`, test counts, pass rate, requirement coverage.

### Task 3: Create `release-protocol.ts` validator (MEDIUM priority)

**File:** `src/core/validation/protocols/release-protocol.ts`
**Scope:** Thin manifest-entry validator. Implements `validateReleaseTask()`. Checks `agent_type: "documentation"`, semver version, changelog flag, git tag flag.

### Task 4: Extend `implementation.ts` validator (LOW priority)

**File:** `src/core/validation/protocols/implementation.ts` (modify)
**Scope:** Add optional `hasTests` and `hasProvenance` checks to existing validator. No structural change.

### Task 5: Create `research.ts` validator (HIGH priority, RCASD stage)

**File:** `src/core/validation/protocols/research.ts` (new)
**Scope:** Per ADR-014, this is the highest-priority Zod schema. Validates confidence score (0.0-1.0), source count, findings count, status, hasEvidence flag.

### Task 6: Create protocol validator dispatcher/index (MEDIUM priority)

**File:** `src/core/validation/protocols/index.ts` (new)
**Scope:** Registry that maps protocol type string to validator function. Used by `ct complete` gate to route to the correct validator.

### Task 7: Integrate validation gate into `ct complete` (HIGH priority)

**File:** `src/core/tasks/complete.ts` (modify)
**Scope:** Add protocol label check before marking task done. If task has protocol label, run corresponding validator. Return exit code 60-67 on failure.

### Task 8: Add optional columns to `lifecycle_stages` table (MEDIUM priority)

**Files:** `src/store/schema.ts` (modify), new drizzle migration
**Scope:** Per ADR-014 Section 2, add: `output_file`, `confidence`, `verdict`, `validated`, `validated_at`, `validation_score` columns.

---

## 5. Exit Code Allocation

Current allocation from `src/mcp/lib/protocol-enforcement.ts`:

| Code | Protocol | Status |
|------|----------|--------|
| 60 | Research | Allocated |
| 61 | Consensus | Allocated |
| 62 | Specification | Allocated |
| 63 | Decomposition | Allocated |
| 64 | Implementation | Allocated |
| 65 | Contribution | Allocated |
| 66 | Release | Allocated |
| 67 | Generic | Allocated |

**Recommendation:** Use exit code 67 (generic) for Validation and Testing protocol violations. These stages don't have dedicated exit codes and allocating new ones (68, 69) would overlap with existing non-protocol exit codes already in use. Alternatively, the validation gate can use the generic protocol violation code and include the protocol type in the error message.

---

## 6. Relationship to RCASD Rename (T4858)

The IVTR validators should use the canonical short stage names from `stages.ts`:
- `implement` (not `implementation`)
- `verify` (not `validation`)
- `test` (not `testing`)
- `release` (unchanged)

However, the `agent_type` field in manifest entries uses the protocol names (long form): `implementation`, `validation`, `testing`, `documentation`. These are NOT the same as stage names and should NOT be renamed -- they are protocol identifiers, not stage identifiers.

---

## 7. Dependency Graph

```
T4879 (this document)
    |
    v
T4804 (Create missing schemas) -- Tasks 1-5 above
    |
    v
T4800 (Unify lifecycle) -- must complete first so stages.ts is canonical
    |
    v
ct complete integration (Task 7) -- requires unified lifecycle + validators
    |
    v
lifecycle_stages extension (Task 8) -- requires T4801 schema work
    |
    v
T4806 (E2E test) -- validates the whole pipeline works
```
