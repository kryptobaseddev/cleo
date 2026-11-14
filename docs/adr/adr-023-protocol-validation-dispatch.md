# ADR-023: Protocol Validation Dispatch Architecture

**Date**: 2026-03-04  
**Status**: accepted  
**Accepted**: 2026-03-04  
**Task**: T5327  
**Epic**: T5323  
**Related ADRs**: ADR-008, ADR-014, ADR-017  
**Related Tasks**: T5327, T5323, T4454, T4537  
**Summary**: Establishes the canonical architecture for exposing protocol validation CLI commands through the dispatch layer. Defines the check.protocol.* sub-namespace pattern, validates against alternatives, and provides implementation roadmap for 6 protocol validation operations.

**Keywords**: protocol, validation, dispatch, check, cli-migration, consensus, contribution, decomposition, implementation, specification, verification, gates

**Topics**: check, architecture, cli, migration

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

### 1.1 Problem Statement

Six CLI commands for protocol validation currently bypass the dispatch layer, directly importing from `src/core/validation/protocols/*.ts`:

- `consensus` → `validateConsensusTask`, `checkConsensusManifest`
- `contribution` → `validateContributionTask`, `checkContributionManifest`
- `decomposition` → `validateDecompositionTask`, `checkDecompositionManifest`
- `implementation` → `validateImplementationTask`, `checkImplementationManifest`
- `specification` → `validateSpecificationTask`, `checkSpecificationManifest`
- `verify` → Direct data accessor manipulation for verification gates

This violates Constitution §9 mandate: **"Both interfaces route through the shared dispatch layer."** The bypass means:
- No centralized error handling
- No audit trail via dispatch _meta
- No rate limiting or session validation
- Inconsistent CLI/MCP parity

### 1.2 Existing Check Domain

The `check` domain already has 12 operations defined (registry.ts lines 635-729):

**Query operations**:
- `check.schema` - JSON Schema validation
- `check.protocol` - Generic protocol compliance (takes protocolType param)
- `check.task` - Anti-hallucination validation
- `check.manifest` - Manifest entry validation
- `check.output` - Output file validation
- `check.compliance.summary` - Aggregated metrics
- `check.compliance.violations` - Violation list
- `check.test.status` - Test suite status
- `check.test.coverage` - Coverage metrics
- `check.coherence.check` - Graph consistency

**Mutate operations**:
- `check.compliance.record` - Record check result
- `check.test.run` - Execute test suite

The existing `check.protocol` operation (line 648) accepts a `protocolType` parameter and delegates to `coreValidateProtocol`. However, this generic approach loses protocol-specific options (e.g., `--voting-matrix` for consensus, `--spec-file` for specification).

### 1.3 Protocol Validation Architecture

Protocol validators live in `src/core/validation/protocols/`:

| Protocol | Validates | Key Options |
|----------|-----------|-------------|
| consensus | Multi-agent decision tasks | `votingMatrixFile`, `strict` |
| contribution | Shared codebase work | `strict` |
| decomposition | Epic breakdown tasks | `strict`, `epicId` |
| implementation | Code implementation tasks | `strict` |
| specification | Specification documents | `strict`, `specFile` |
| verify | Verification gates | `gate`, `value`, `agent`, `all`, `reset` |

Each protocol has two validation modes:
1. **Task mode**: `validate{Protocol}Task(taskId, opts)` - Reads manifest for task
2. **Manifest mode**: `check{Protocol}Manifest(manifestFile, opts)` - Validates manifest file directly

---

## 2. Decision

### 2.1 Architecture: Option A — check.protocol.* Sub-Namespace

**Selected**: Create 6 new operations under `check.protocol.*` sub-namespace.

#### Rationale

| Factor | Option A (Selected) | Option B | Option C |
|--------|---------------------|----------|----------|
| **Operation count** | 6 specific ops | 1 generic op | 6 pipeline ops |
| **CLI parity** | Perfect (matches commands) | Requires param mapping | Semantic mismatch |
| **Type safety** | Strong (per-protocol params) | Weak (generic params) | Medium |
| **Documentation** | Clear per-operation | Single doc, param-heavy | Pipeline-centric |
| **Extensibility** | Add new protocols easily | Extend param enum | Add stages |
| **Verb consistency** | `check.protocol.X` | `check.protocol` | `pipeline.protocol.X` |
| **Migration effort** | Medium | Low | High |

#### Key Decision Factors

1. **Protocol-specific options are REQUIRED**: Consensus needs `votingMatrixFile`, Specification needs `specFile`, Decomposition needs `epicId`. A generic `check.protocol` with union params creates type complexity and poor DX.

2. **CLI command alignment**: Each CLI command maps 1:1 to a dispatch operation, making the dispatch registry the canonical API reference.

3. **Future extensibility**: New protocols (testing, research, release) follow the same pattern without enum pollution.

4. **Consistency with existing patterns**: The check domain already has sub-namespaces (`check.compliance.*`, `check.test.*`). Adding `check.protocol.*` follows established convention.

5. **Pipeline separation**: Protocol validation is NOT a pipeline stage—it's compliance verification. Pipeline stages are lifecycle gates (RCSD-IVTR), not protocol validators.

### 2.2 Operation Mapping

| CLI Command | Operation | Mode | Required Params | Optional Params |
|-------------|-----------|------|-----------------|-----------------|
| `consensus validate <taskId>` | `check.protocol.consensus` | task | `taskId` | `strict`, `votingMatrixFile` |
| `consensus check <manifestFile>` | `check.protocol.consensus` | manifest | `manifestFile` | `strict`, `votingMatrixFile` |
| `contribution validate <taskId>` | `check.protocol.contribution` | task | `taskId` | `strict` |
| `contribution check <manifestFile>` | `check.protocol.contribution` | manifest | `manifestFile` | `strict` |
| `decomposition validate <taskId>` | `check.protocol.decomposition` | task | `taskId` | `strict`, `epicId` |
| `decomposition check <manifestFile>` | `check.protocol.decomposition` | manifest | `manifestFile` | `strict`, `epicId` |
| `implementation validate <taskId>` | `check.protocol.implementation` | task | `taskId` | `strict` |
| `implementation check <manifestFile>` | `check.protocol.implementation` | manifest | `manifestFile` | `strict` |
| `specification validate <taskId>` | `check.protocol.specification` | task | `taskId` | `strict`, `specFile` |
| `specification check <manifestFile>` | `check.protocol.specification` | manifest | `manifestFile` | `strict`, `specFile` |
| `verify <task-id>` | `check.gate.verify` | gate | `taskId` | `gate`, `value`, `agent`, `all`, `reset` |

### 2.3 Implementation Pattern

Each operation follows the standard dispatch three-layer architecture:

```
CLI Command (src/cli/commands/{protocol}.ts)
    ↓ (1) Parse args, call dispatch
Dispatch Handler (src/dispatch/domains/check.ts)
    ↓ (2) Route to engine
Validate Engine (src/dispatch/engines/validate-engine.ts)
    ↓ (3) Delegate to core
Core Validation (src/core/validation/protocols/{protocol}.ts)
```

#### Mode Detection

All `check.protocol.*` operations use `mode` parameter to distinguish task vs manifest validation:

```typescript
// Task mode
{ operation: 'check.protocol.consensus', params: { mode: 'task', taskId: 'T1234', strict: true } }

// Manifest mode
{ operation: 'check.protocol.consensus', params: { mode: 'manifest', manifestFile: 'path/to/manifest.json', strict: true } }
```

### 2.4 Gate Operations (verify command)

The `verify` command is distinct from protocol validation—it manages verification gates on tasks. It belongs under `check.gate.*` sub-namespace:

- `check.gate.verify` - View or modify verification gates for a task

This separation maintains semantic clarity: protocols validate compliance patterns; gates track task verification state.

---

## 3. Consequences

### 3.1 Positive

- **Full dispatch compliance**: All 6 commands route through dispatch layer
- **Consistent error handling**: Centralized via dispatch response wrapper
- **Audit trail**: All operations include `_meta` timestamps
- **Type safety**: Protocol-specific parameters are strongly typed
- **MCP parity**: CLI and MCP use identical operations
- **Future-proof**: New protocols add operations without breaking changes
- **Discoverability**: Operations are self-documenting in registry

### 3.2 Negative

- **Registry growth**: +6 operations (manageable; registry has 207 ops)
- **Engine expansion**: validate-engine.ts grows by ~180 lines
- **Handler complexity**: check.ts handler gains 6 switch cases

### 3.3 Neutral

- **Core layer unchanged**: No modifications to `src/core/validation/protocols/*.ts`
- **Existing operations preserved**: `check.protocol` remains for generic use
- **No breaking changes**: New operations are additive only

---

## 4. Implementation Plan

### Phase 1: Registry Updates (T5327.1)

Add 6 operations to `src/dispatch/registry.ts`:

```typescript
// Query operations (6 new)
{ gateway: 'query', domain: 'check', operation: 'protocol.consensus', ... }
{ gateway: 'query', domain: 'check', operation: 'protocol.contribution', ... }
{ gateway: 'query', domain: 'check', operation: 'protocol.decomposition', ... }
{ gateway: 'query', domain: 'check', operation: 'protocol.implementation', ... }
{ gateway: 'query', domain: 'check', operation: 'protocol.specification', ... }
{ gateway: 'query', domain: 'check', operation: 'gate.verify', ... }
```

### Phase 2: Engine Functions (T5327.2)

Add to `src/dispatch/engines/validate-engine.ts`:

```typescript
export async function validateProtocolConsensus(...): Promise<EngineResult>
export async function validateProtocolContribution(...): Promise<EngineResult>
export async function validateProtocolDecomposition(...): Promise<EngineResult>
export async function validateProtocolImplementation(...): Promise<EngineResult>
export async function validateProtocolSpecification(...): Promise<EngineResult>
export async function validateGateVerify(...): Promise<EngineResult>
```

### Phase 3: Handler Updates (T5327.3)

Update `src/dispatch/domains/check.ts`:

- Add cases to `query()` for 5 protocol operations
- Add case to `query()` for gate.verify (or mutate if modifying)
- Update `getSupportedOperations()`

### Phase 4: CLI Migration (T5327.4)

Update 6 CLI commands to use dispatch:

```typescript
// Before (direct core import)
import { validateConsensusTask } from '../../core/validation/protocols/consensus.js';

// After (dispatch)
import { dispatchQuery } from '../../dispatch/index.js';
const result = await dispatchQuery('check', 'protocol.consensus', { taskId, mode: 'task', ... });
```

### Phase 5: Tests (T5327.5)

- Unit tests for each engine function
- Handler tests for switch cases
- Integration tests for CLI→dispatch→core flow

---

## 5. Compliance Criteria

1. **Registry**: 6 new operations appear in `src/dispatch/registry.ts` with correct metadata
2. **Engine**: All 6 functions exported from `src/dispatch/engines/validate-engine.ts`
3. **Handler**: `src/dispatch/domains/check.ts` routes all 6 operations
4. **CLI**: 6 commands use dispatch instead of direct core imports
5. **Type check**: `npx tsc --noEmit` exits 0
6. **Tests**: `npx vitest run` exits 0
7. **Parity**: CLI and MCP produce identical results

---

## 6. References

- **Constitution §9**: Dispatch-first architecture
- **ADR-008**: CLEO canonical architecture
- **ADR-014**: RCASD rename and protocol validation
- **ADR-017**: Verb and naming standards
- **T5323**: CLI-to-Dispatch Migration Epic
- **T4454**: Protocol validation framework
- **T4537**: CLI protocol validation commands

---

**END OF ADR-023**
