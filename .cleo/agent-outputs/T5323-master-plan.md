# EPIC T5323: CLI-to-Dispatch Migration Master Plan

**Agent**: Alpha (Research & Planning Lead)  
**Status**: COMPLETE - Ready for Agent Beta Handoff  
**Date**: 2026-03-04  
**Token Budget**: 85k / 150k (Safe margin for Agent Beta)  

---

## Executive Summary

This document provides a comprehensive, production-ready plan to migrate **39 CLI commands** from direct core calls to thin dispatch wrappers. This migration aligns with Constitution §9 mandate: **"Both interfaces route through the shared dispatch layer"**.

### Current State
- **Total CLI Commands**: 86
- **Commands Bypassing Dispatch**: 39 (45.3%)
- **Architecture Violation**: Direct core imports bypass validation, error handling, and audit trails

### Target State
- **Dispatch Compliance**: 100% (except 11 justified CLI-only operations)
- **Reduced Bypass Rate**: From 45% to ~13% (11 CLI-only / 86 total)

---

## 1. AUDIT REPORT: The 39 Bypassing Commands

### Category A: Infrastructure & System Operations (11 commands) - CLI-ONLY JUSTIFIED

These operations are legitimately CLI-only due to local filesystem access, external process execution, or one-time migration needs.

| Command | File | Core Imports | Justification | Migration |
|---------|------|--------------|---------------|-----------|
| **checkpoint** | `src/cli/commands/checkpoint.ts` | formatError, cliOutput, getCleoDir, gitCheckpoint | Git operations (.cleo/.git) | NONE - CLI-only |
| **env** | `src/cli/commands/env.ts` | getRuntimeDiagnostics | Environment diagnostics | NONE - CLI-only |
| **otel** | `src/cli/commands/otel.ts` | Telemetry diagnostics | Local telemetry only | NONE - CLI-only |
| **web** | `src/cli/commands/web.ts` | detectEnvMode(), process spawn/PID | Process management | NONE - CLI-only |
| **install-global** | `src/cli/commands/install-global.ts` | Global CAAMP refresh | External process execution | NONE - CLI-only |
| **self-update** | `src/cli/commands/self-update.ts` | File system ops, external process | Self-installation | NONE - CLI-only |
| **mcp-install** | `src/cli/commands/mcp-install.ts` | CAAMP provider detection | Config file writes | NONE - CLI-only |
| **commands** | `src/cli/commands/commands.ts` | COMMANDS-INDEX.json lookup | Deprecated Bash-era | NONE - Remove later |
| **generate-changelog** | `src/cli/commands/generate-changelog.ts` | File I/O | Local file generation | NONE - CLI-only |
| **extract** | `src/cli/commands/extract.ts` | File I/O, skill state merge | Local operations | NONE - CLI-only |
| **migrate-claude-mem** | `src/cli/commands/migrate-claude-mem.ts` | One-time migration | Data migration | NONE - CLI-only |

### Category B: Label Management (1 command) - EASY

| Command | File | Core Imports | Dispatch Operation | Complexity |
|---------|------|--------------|-------------------|------------|
| **labels** | `src/cli/commands/labels.ts` | getAccessor(), label queries | `tasks.label.list`, `tasks.label.show` | EASY |

**Status**: Dispatch operations already exist in registry (lines 186-200 of registry.ts).

### Category C: Skill Management (1 command) - MEDIUM

| Command | File | Core Imports | Dispatch Operation | Complexity |
|---------|------|--------------|-------------------|------------|
| **skills** | `src/cli/commands/skills.ts` | discoverAllSkills, findSkill, validateSkill, installSkill, mpSearchSkills | `tools.skill.*` (6 query + 6 mutate ops exist) | MEDIUM |

**Status**: All `tools.skill.*` operations exist in registry. CLI just needs wiring.

### Category D: Issue Tracking (1 command) - MEDIUM

| Command | File | Core Imports | Dispatch Operation | Complexity |
|---------|------|--------------|-------------------|------------|
| **issue** | `src/cli/commands/issue.ts` | Issue CRUD operations | `tools.issue.*` (3 mutate ops exist) | MEDIUM |

**Status**: `tools.issue.add.bug`, `tools.issue.add.feature`, `tools.issue.add.help` exist.

### Category E: Memory/Brain Operations (1 command) - MEDIUM

| Command | File | Core Imports | Dispatch Operation | Complexity |
|---------|------|--------------|-------------------|------------|
| **memory-brain** | `src/cli/commands/memory-brain.ts` | Brain.db operations | `memory.brain.*` ops exist | MEDIUM |

**Status**: Memory domain has brain suboperations in registry.

### Category F: History & Analytics (2 commands) - MEDIUM

| Command | File | Core Imports | Dispatch Operation | Complexity |
|---------|------|--------------|-------------------|------------|
| **history** | `src/cli/commands/history.ts` | Session history analytics | `session.history` (ALREADY exists) | MEDIUM |
| **archive-stats** | `src/cli/commands/archive-stats.ts` | getAccessor(), summaryReport(), cycleTimesReport() | NEEDS: `admin.archive.stats` | MEDIUM |

### Category G: Protocol Validation (6 commands) - HARD (Architecture Decision Required)

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **consensus** | `src/cli/commands/consensus.ts` | Protocol validation | `check.protocol.consensus` | HARD |
| **contribution** | `src/cli/commands/contribution.ts` | Contribution tracking | `check.protocol.contribution` | HARD |
| **decomposition** | `src/cli/commands/decomposition.ts` | Epic decomposition validation | `check.protocol.decomposition` | HARD |
| **implementation** | `src/cli/commands/implementation.ts` | Implementation tracking | `check.protocol.implementation` | HARD |
| **specification** | `src/cli/commands/specification.ts` | Spec compliance validation | `check.protocol.specification` | HARD |
| **verify** | `src/cli/commands/verify.ts` | Verification gates | `check.gate.verify` or `pipeline.stage.verify` | HARD |

**Blocker**: Need ADR on protocol validation scope in dispatch layer.

### Category H: Phase Management (2 commands) - MEDIUM-HARD

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **phase** | `src/cli/commands/phase.ts` | Phase operations | `pipeline.phase.show` | MEDIUM-HARD |
| **phases** | `src/cli/commands/phases.ts` | Phase listing | `pipeline.phase.list` | MEDIUM-HARD |

**Blocker**: Need decision - are phases first-class dispatch entities?

### Category I: Data Import/Export (5 commands) - HARD

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **export-tasks** | `src/cli/commands/export-tasks.ts` | Cross-project export | `admin.export.tasks`? | HARD |
| **import-tasks** | `src/cli/commands/import-tasks.ts` | Cross-project import | `admin.import.tasks`? | HARD |
| **export** | `src/cli/commands/export.ts` | Generic export | `admin.export`? | HARD |
| **import** | `src/cli/commands/import.ts` | Generic import | `admin.import`? | HARD |
| **snapshot** | `src/cli/commands/snapshot.ts` | Snapshot export/import | `admin.snapshot.export`, `admin.snapshot.import` | HARD |

**Blocker**: Need decision on cross-project operation scope for dispatch.

### Category J: Remote & Sharing (2 commands) - CLI-ONLY or HARD

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **remote** | `src/cli/commands/remote.ts` | Git operations | CLI-only justified (git-like) | NONE |
| **sharing** | `src/cli/commands/sharing.ts` | Config-driven allowlist | `admin.sharing.*`? or CLI-only | TBD |

### Category K: Testing & Sync (2 commands) - MEDIUM

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **testing** | `src/cli/commands/testing.ts` | Manifest validation | `check.manifest`? | MEDIUM |
| **sync** | `src/cli/commands/sync.ts` | Aliases/shortcuts | Convert to dispatch calls | MEDIUM |

### Category L: Nexus & Cross-Project (1 command) - HARD

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **nexus** | `src/cli/commands/nexus.ts` | Cross-project file system | Separate architecture needed | HARD |

**Blocker**: Requires separate nexus domain or stays CLI-only.

### Category M: Miscellaneous (3 commands) - MIXED

| Command | File | Core Imports | Proposed Dispatch Operation | Complexity |
|---------|------|--------------|---------------------------|------------|
| **grade** | `src/cli/commands/grade.ts` | Session grading | `session.grade`? or stays core | EASY |
| **upgrade** | `src/cli/commands/upgrade.ts` | Version upgrade | CLI-only (external process) | NONE |
| **restore** | `src/cli/commands/restore.ts` | Complex multi-branch restoration | Split: `tasks.restore`, `admin.backup.restore` | HARD |

---

## 2. DECOMPOSITION STRATEGY: 7 Migration Phases

### Phase 1: Quick Wins (EASY) - 3 commands
**Goal**: Immediate value, low risk, builds momentum

**Commands**:
1. `labels.ts` → Wire existing `tasks.label.*` operations
2. `grade.ts` → Add `session.grade` operation or wire existing
3. `archive-stats.ts` → Add `admin.archive.stats` operation

**Dependencies**: None  
**Token Estimate**: 15k  
**Agent Assignment**: Agent Gamma (Junior)  

### Phase 2: Existing Operations Wiring (MEDIUM) - 5 commands
**Goal**: Connect CLI to existing dispatch operations

**Commands**:
1. `skills.ts` → Wire `tools.skill.*` (6 query + 6 mutate)
2. `issue.ts` → Wire `tools.issue.*` (3 mutate)
3. `memory-brain.ts` → Wire `memory.brain.*`
4. `history.ts` → Verify/fix `session.history` wiring
5. `testing.ts` → Wire to `check.manifest`

**Dependencies**: Phase 1 (for pattern establishment)  
**Token Estimate**: 35k  
**Agent Assignment**: Agent Delta (Mid-level)  

### Phase 3: New Dispatch Operations (MEDIUM-HARD) - 3 commands
**Goal**: Add missing dispatch operations and wire CLI

**Commands**:
1. `phase.ts` → Add `pipeline.phase.show`
2. `phases.ts` → Add `pipeline.phase.list`
3. `sync.ts` → Convert aliases to dispatch calls

**Dependencies**: Phase 2  
**Token Estimate**: 25k  
**Agent Assignment**: Agent Epsilon (Senior)  

### Phase 4: Protocol Validation Architecture (HARD) - 6 commands
**Goal**: Resolve architecture decisions and implement

**Commands**:
1. `consensus.ts` → `check.protocol.consensus`
2. `contribution.ts` → `check.protocol.contribution`
3. `decomposition.ts` → `check.protocol.decomposition`
4. `implementation.ts` → `check.protocol.implementation`
5. `specification.ts` → `check.protocol.specification`
6. `verify.ts` → `check.gate.verify`

**Blockers**: Requires ADR on protocol validation scope  
**Dependencies**: All previous phases  
**Token Estimate**: 40k  
**Agent Assignment**: Agent Zeta (Architect)  

### Phase 5: Data Portability (HARD) - 5 commands
**Goal**: Cross-project operations in dispatch

**Commands**:
1. `export-tasks.ts` → `admin.export.tasks`
2. `import-tasks.ts` → `admin.import.tasks`
3. `export.ts` → `admin.export`
4. `import.ts` → `admin.import`
5. `snapshot.ts` → `admin.snapshot.export/import`

**Blockers**: Need decision on cross-project scope  
**Dependencies**: Phase 4  
**Token Estimate**: 45k  
**Agent Assignment**: Agent Eta (Senior)  

### Phase 6: Complex Restoration (HARD) - 1 command
**Goal**: Split complex restore logic into dispatch operations

**Commands**:
1. `restore.ts` → Split into `tasks.restore`, `admin.backup.restore`

**Dependencies**: Phase 5  
**Token Estimate**: 20k  
**Agent Assignment**: Agent Theta (Senior)  

### Phase 7: Nexus Architecture (HARD/SPECIAL) - 1 command
**Goal**: Decide nexus future and implement

**Commands**:
1. `nexus.ts` → New `nexus` domain OR document CLI-only justification

**Blockers**: Requires architecture decision  
**Dependencies**: Phase 6  
**Token Estimate**: 25k  
**Agent Assignment**: Agent Iota (Architect)  

---

## 3. IMPLEMENTATION SPECIFICATIONS

### Phase 1: Quick Wins (3 commands)

#### 3.1.1 labels.ts Migration
**Current Pattern**:
```typescript
import { getAccessor } from '../../store/data-accessor.js';
// Direct calls to core
```

**Target Pattern**:
```typescript
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

const response = await dispatchRaw('query', 'tasks', 'label.list', {});
if (!response.success) handleRawError(response, { command: 'labels' });
```

**Dispatch Operations** (already exist):
- `tasks.label.list` - Line 187-196 in registry.ts
- `tasks.label.show` - Line 197-200 in registry.ts

**Files to Modify**:
1. `src/cli/commands/labels.ts` - Replace direct core calls with dispatch

**Testing**:
- Unit tests in `src/cli/commands/__tests__/labels.test.ts`
- Verify output matches pre-migration

**Token Budget**: 5k

#### 3.1.2 grade.ts Migration
**Current Pattern**: Direct core import for session grading

**Target Pattern**: Wire to dispatch or document as CLI-only

**Options**:
1. Add `session.grade` operation to registry
2. Keep CLI-only if grading is local-only heuristic

**Decision Needed**: Is session grading a dispatchable operation?

**Token Budget**: 3k

#### 3.1.3 archive-stats.ts Migration
**Current Pattern**:
```typescript
import { getAccessor } from '../../store/data-accessor.js';
import { summaryReport, cycleTimesReport } from '../../core/analytics.js';
```

**Target Pattern**:
```typescript
// Add to registry:
{
  gateway: 'query',
  domain: 'admin',
  operation: 'archive.stats',
  description: 'Analytics on archived tasks',
  tier: 1,
  idempotent: true,
  sessionRequired: false,
  requiredParams: [],
}
```

**Files to Modify**:
1. `src/dispatch/registry.ts` - Add operation definition
2. `src/dispatch/engines/admin-engine.ts` - Add handler
3. `src/cli/commands/archive-stats.ts` - Replace with dispatch call

**Token Budget**: 7k

### Phase 2: Existing Operations Wiring (5 commands)

#### 3.2.1 skills.ts Migration
**Dispatch Operations Available**:
- `tools.skill.list` (query)
- `tools.skill.show` (query)
- `tools.skill.find` (query)
- `tools.skill.dispatch` (query)
- `tools.skill.verify` (query)
- `tools.skill.dependencies` (query)
- `tools.skill.install` (mutate)
- `tools.skill.uninstall` (mutate)
- `tools.skill.enable` (mutate)
- `tools.skill.disable` (mutate)
- `tools.skill.configure` (mutate)
- `tools.skill.refresh` (mutate)

**Implementation**:
Map each subcommand to corresponding dispatch operation:
- `skills list` → `tools.skill.list`
- `skills search` → `tools.skill.find`
- `skills info` → `tools.skill.show`
- `skills validate` → `tools.skill.verify`
- `skills install` → `tools.skill.install`

**Files to Modify**:
1. `src/cli/commands/skills.ts` - Full refactor to dispatch pattern

**Token Budget**: 10k

#### 3.2.2 issue.ts Migration
**Dispatch Operations Available**:
- `tools.issue.add.bug` (mutate)
- `tools.issue.add.feature` (mutate)
- `tools.issue.add.help` (mutate)
- `tools.issue.diagnostics` (query)

**Implementation**: Map subcommands to operations

**Token Budget**: 5k

#### 3.2.3 memory-brain.ts Migration
**Dispatch Operations Available**:
- Memory domain has brain suboperations

**Implementation**: Research exact operations in registry and wire

**Token Budget**: 8k

#### 3.2.4 history.ts Migration
**Dispatch Operation Available**:
- `session.history` (already exists)

**Implementation**: Verify existing wiring or fix if broken

**Token Budget**: 5k

#### 3.2.5 testing.ts Migration
**Dispatch Operation**:
- Likely `check.manifest` or `check.test.*`

**Implementation**: Map manifest validation to appropriate check operation

**Token Budget**: 7k

### Phase 3: New Dispatch Operations (3 commands)

#### 3.3.1 phase.ts / phases.ts Migration
**New Operations Needed**:
```typescript
// In registry.ts:
{
  gateway: 'query',
  domain: 'pipeline',
  operation: 'phase.list',
  description: 'List all phases',
  tier: 1,
  idempotent: true,
  sessionRequired: false,
  requiredParams: [],
},
{
  gateway: 'query',
  domain: 'pipeline',
  operation: 'phase.show',
  description: 'Show phase details',
  tier: 1,
  idempotent: true,
  sessionRequired: false,
  requiredParams: ['phaseId'],
}
```

**Files to Modify**:
1. `src/dispatch/registry.ts` - Add operations
2. `src/dispatch/engines/pipeline-engine.ts` - Add handlers
3. `src/cli/commands/phase.ts` - Migrate to dispatch
4. `src/cli/commands/phases.ts` - Migrate to dispatch

**Token Budget**: 15k

#### 3.3.2 sync.ts Migration
**Analysis**: This appears to be aliases/shortcuts

**Implementation**: Convert each subcommand to corresponding dispatch call:
- `sync status` → dispatch to appropriate operation
- `sync clear` → dispatch to appropriate operation
- etc.

**Token Budget**: 10k

### Phase 4: Protocol Validation (6 commands)

**Architecture Decision Required**:
Create ADR answering:
1. Should protocol validation be dispatchable?
2. If yes, under which domain? `check` or `pipeline`?
3. How do verification gates relate to pipeline stages?

**Proposed Operations** (pending ADR approval):
```typescript
// check.protocol.* operations
{
  gateway: 'mutate',
  domain: 'check',
  operation: 'protocol.consensus',
  description: 'Validate consensus protocol compliance',
  tier: 2,
  idempotent: true,
  sessionRequired: true,
  requiredParams: ['taskId'],
},
// Similar for contribution, decomposition, implementation, specification

// OR pipeline.stage.verify.*
{
  gateway: 'mutate',
  domain: 'pipeline',
  operation: 'stage.verify',
  description: 'Run verification gate',
  tier: 2,
  idempotent: true,
  sessionRequired: true,
  requiredParams: ['stage', 'taskId'],
}
```

**Files to Modify**:
1. Create ADR document
2. `src/dispatch/registry.ts` - Add approved operations
3. `src/dispatch/engines/check-engine.ts` or `pipeline-engine.ts` - Add handlers
4. `src/cli/commands/consensus.ts` - Migrate
5. `src/cli/commands/contribution.ts` - Migrate
6. `src/cli/commands/decomposition.ts` - Migrate
7. `src/cli/commands/implementation.ts` - Migrate
8. `src/cli/commands/specification.ts` - Migrate
9. `src/cli/commands/verify.ts` - Migrate

**Token Budget**: 40k

### Phase 5: Data Portability (5 commands)

**Architecture Decision Required**:
1. Should cross-project operations be in dispatch?
2. Can remote MCP agents safely perform cross-project I/O?

**Proposed Operations**:
```typescript
// admin.export.* and admin.import.*
{
  gateway: 'mutate',
  domain: 'admin',
  operation: 'export.tasks',
  description: 'Export tasks to portable format',
  tier: 2,
  idempotent: true,
  sessionRequired: false,
  requiredParams: ['targetProject'],
},
{
  gateway: 'mutate',
  domain: 'admin',
  operation: 'snapshot.export',
  description: 'Export task snapshot',
  tier: 1,
  idempotent: true,
  sessionRequired: false,
  requiredParams: [],
},
// etc.
```

**Files to Modify**:
1. Create ADR document
2. `src/dispatch/registry.ts` - Add operations
3. `src/dispatch/engines/admin-engine.ts` - Add handlers
4. `src/cli/commands/export-tasks.ts` - Migrate
5. `src/cli/commands/import-tasks.ts` - Migrate
6. `src/cli/commands/export.ts` - Migrate
7. `src/cli/commands/import.ts` - Migrate
8. `src/cli/commands/snapshot.ts` - Migrate

**Token Budget**: 45k

### Phase 6: Complex Restoration (1 command)

#### 3.6.1 restore.ts Migration
**Current Complexity**: Multi-branch logic:
- Task reopen (from done)
- Archive unarchive
- Backup restore

**Strategy**: Split into separate operations
```typescript
// Operation 1: tasks.restore (already exists for archives)
// Operation 2: admin.backup.restore (new)
// Operation 3: tasks.reopen (if different from restore)
```

**Files to Modify**:
1. `src/dispatch/registry.ts` - Add `admin.backup.restore`
2. `src/dispatch/engines/admin-engine.ts` - Add handler
3. `src/cli/commands/restore.ts` - Refactor to dispatch calls

**Token Budget**: 20k

### Phase 7: Nexus Architecture (1 command)

#### 3.7.1 nexus.ts Decision & Migration
**Options**:
1. **New Domain**: Create `nexus` domain with operations
2. **CLI-Only**: Document justification and keep as-is
3. **Admin Domain**: Add `admin.nexus.*` operations

**Recommendation**: Option 1 - New domain for cross-project operations

**Proposed Operations**:
```typescript
{
  gateway: 'query',
  domain: 'nexus',
  operation: 'list',
  description: 'List registered projects',
  tier: 2,
  idempotent: true,
  sessionRequired: false,
  requiredParams: [],
},
{
  gateway: 'mutate',
  domain: 'nexus',
  operation: 'register',
  description: 'Register project in nexus',
  tier: 2,
  idempotent: false,
  sessionRequired: false,
  requiredParams: ['path'],
},
// etc.
```

**Files to Modify**:
1. Create ADR for nexus architecture
2. `src/dispatch/types.ts` - Add 'nexus' to CanonicalDomain
3. `src/dispatch/registry.ts` - Add nexus operations
4. `src/dispatch/engines/nexus-engine.ts` - Create new engine
5. `src/cli/commands/nexus.ts` - Migrate to dispatch

**Token Budget**: 25k

---

## 4. TOKEN BUDGET SUMMARY

| Phase | Commands | Token Budget | Cumulative |
|-------|----------|--------------|------------|
| Phase 1: Quick Wins | 3 | 15k | 15k |
| Phase 2: Existing Ops | 5 | 35k | 50k |
| Phase 3: New Operations | 3 | 25k | 75k |
| Phase 4: Protocol Validation | 6 | 40k | 115k |
| Phase 5: Data Portability | 5 | 45k | 160k |
| Phase 6: Restoration | 1 | 20k | 180k |
| Phase 7: Nexus | 1 | 25k | 205k |
| **TOTAL** | **24** | **205k** | - |

**Agent Token Cap**: 185k (hard limit)  
**Recommendation**: Split Phase 5-7 across multiple agents or defer Phase 7.

---

## 5. AGENT ASSIGNMENT PLAN

### Primary Team

| Agent | Phase | Commands | Expertise | Token Budget |
|-------|-------|----------|-----------|--------------|
| **Gamma** | 1 | labels, grade, archive-stats | Junior | 15k |
| **Delta** | 2 | skills, issue, memory-brain, history, testing | Mid | 35k |
| **Epsilon** | 3 | phase, phases, sync | Senior | 25k |
| **Zeta** | 4 | consensus, contribution, decomposition, implementation, specification, verify | Architect | 40k |

### Secondary Team (Parallel or Sequential)

| Agent | Phase | Commands | Expertise | Token Budget |
|-------|-------|----------|-----------|--------------|
| **Eta** | 5 | export-tasks, import-tasks, export, import, snapshot | Senior | 45k |
| **Theta** | 6 | restore | Senior | 20k |
| **Iota** | 7 | nexus | Architect | 25k |

**Parallel Execution Groups**:
- **Group A**: Phases 1-3 (can run sequentially or with overlap)
- **Group B**: Phase 4 (blocked on ADR)
- **Group C**: Phase 5 (can run after Group A)
- **Group D**: Phases 6-7 (can run after Group C)

---

## 6. COMPLIANT PATTERN REFERENCE

### 6.1 Standard Dispatch Pattern

```typescript
// CORRECT: Using dispatchRaw
import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

export function registerExampleCommand(program: Command): void {
  program
    .command('example <arg>')
    .option('--flag', 'Description')
    .action(async (arg: string, opts: Record<string, unknown>) => {
      const params = { arg };
      if (opts['flag']) params['flag'] = true;
      
      // Call dispatch
      const response = await dispatchRaw('query', 'domain', 'operation', params);
      
      // Handle errors
      if (!response.success) {
        handleRawError(response, { command: 'example', operation: 'domain.operation' });
      }
      
      // Output result
      cliOutput(response.data, { command: 'example', operation: 'domain.operation' });
    });
}
```

### 6.2 Incorrect Pattern (To Be Migrated)

```typescript
// WRONG: Direct core imports
import { Command } from 'commander';
import { someCoreFunction } from '../../core/some-module.js';  // DON'T DO THIS
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

export function registerBadCommand(program: Command): void {
  program
    .command('bad')
    .action(async () => {
      try {
        const result = await someCoreFunction();  // Direct core call
        console.log(result);
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
```

### 6.3 Key Differences

| Aspect | Compliant | Non-Compliant |
|--------|-----------|---------------|
| Core imports | None (only dispatch) | Direct from `../../core/...` |
| Error handling | `handleRawError()` | Manual try-catch with `CleoError` |
| Output | `cliOutput()` renderer | Manual console.log |
| Validation | Dispatch layer handles | Manual or missing |
| Audit trail | Automatic via dispatch | None |

---

## 7. TESTING REQUIREMENTS

### 7.1 Unit Tests
Each migrated command requires:
- `src/cli/commands/__tests__/{command}.test.ts`
- Mock dispatch responses
- Verify parameter mapping
- Verify error handling

### 7.2 Integration Tests
- `tests/integration/cli-dispatch-parity.test.ts`
- Compare CLI output vs direct dispatch call
- Ensure identical behavior

### 7.3 Regression Tests
- Run full CLI test suite: `npm test -- src/cli`
- Verify no breaking changes to command interfaces
- Test edge cases (missing params, invalid inputs)

---

## 8. RISK MITIGATION

### 8.1 High-Risk Areas
1. **Protocol validation commands** - May affect CI/CD pipelines
2. **Import/export commands** - Risk of data corruption
3. **Restore command** - Complex multi-branch logic

### 8.2 Mitigation Strategies
1. **Feature flags**: Add `--use-dispatch` flag for gradual rollout
2. **A/B testing**: Compare old vs new implementation outputs
3. **Rollback plan**: Keep old implementation behind flag for 1 sprint
4. **Comprehensive testing**: 100% test coverage for migrated commands

---

## 9. SUCCESS CRITERIA

### 9.1 Technical Metrics
- [ ] 0 direct core imports in migrated commands
- [ ] 100% dispatch compliance for non-CLI-only commands
- [ ] All tests passing
- [ ] No regression in command behavior

### 9.2 Architecture Metrics
- [ ] All new operations in registry.ts
- [ ] All engines using canonical patterns
- [ ] Consistent error handling across all commands
- [ ] Updated documentation

---

## 10. NEXT STEPS

### Immediate (Agent Beta)
1. Review this plan
2. Create child tasks in CLEO for each phase
3. Begin Phase 1 implementation
4. Schedule ADR reviews for Phases 4-7

### Short Term (This Week)
1. Complete Phase 1 (Quick Wins)
2. Draft ADR for protocol validation scope
3. Draft ADR for cross-project operations

### Medium Term (Next 2 Weeks)
1. Complete Phases 2-3
2. Finalize ADRs
3. Begin Phase 4 implementation

### Long Term (Next Month)
1. Complete Phases 4-7
2. Full regression testing
3. Documentation updates
4. Team knowledge sharing session

---

## 11. APPENDICES

### Appendix A: Full Command Inventory

See `.cleo/agent-outputs/cli-dispatch-audit-report.md` for complete analysis.

### Appendix B: Dispatch Registry Reference

See `src/dispatch/registry.ts` for canonical operation definitions.

### Appendix C: CLI Adapter Documentation

See `src/dispatch/adapters/cli.ts` for:
- `dispatchFromCli()` - Formatted output mode
- `dispatchRaw()` - Raw response mode
- `handleRawError()` - Standardized error handling

### Appendix D: Constitution Reference

**§9 Dispatch-First Architecture**:
> "Both interfaces route through the shared dispatch layer. MCP is PRIMARY; CLI is BACKUP. Both CLI and MCP delegate to `src/dispatch/` before calling core functions."

---

**End of Master Plan**

**Status**: COMPLETE  
**Token Usage**: 85k / 150k  
**Ready for**: Agent Beta Handoff  
