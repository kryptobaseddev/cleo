# CLI Dispatch Audit Report

**Date**: 2026-03-02
**Auditor**: Research Agent
**Status**: COMPLETE
**Canonical Source**: `docs/specs/CLEO-OPERATIONS-REFERENCE.md` (v1.2.0)

---

## Executive Summary

### Key Findings
- **Total CLI Commands**: 84 (registered in `src/cli/index.ts`)
- **Commands Properly Using Dispatch**: 45 (53.6%)
- **Commands Bypassing Dispatch**: **39 (46.4%)**
- **Architecture Violation**: ~46% of CLI commands do not route through the dispatch layer

### Architecture Requirement
The documented architecture in `CLAUDE.md` specifies:
```
MCP is PRIMARY entry point → src/dispatch/ → src/core/ (shared-core pattern)
CLI is BACKUP interface   → src/dispatch/ → src/core/
```

Both CLI and MCP MUST delegate to `src/dispatch/` before calling core functions.

### Reality
- **Proper path**: `src/cli/commands/*.ts` → `dispatchFromCli()` → `src/dispatch/` → `src/core/`
- **Violation path**: `src/cli/commands/*.ts` → direct core imports → call core functions directly

---

## Bypassing Commands (39 total)

### Categorized by Reason

#### CATEGORY A: Infrastructure & System Operations (9 commands)
These operations are justified as CLI-only because they don't have meaningful dispatch routes.

**Checkpoint** (1)
- **File**: `src/cli/commands/checkpoint.ts`
- **Core Imports**: 3 (formatError, cliOutput, getCleoDir, gitCheckpoint)
- **Reason**: Git operations (.cleo/.git) not suitable for MCP remote agents
- **Status**: JUSTIFIED - No dispatch needed for local git operations
- **Migration Path**: None required

**Environment/System** (2)
- `env.ts` → `getRuntimeDiagnostics()` — environment diagnostics (no MCP route)
- `otel.ts` → telemetry diagnostics (local-only, not suitable for dispatch)

**Process Management** (2)
- `web.ts` → `detectEnvMode()`, process spawn/PID management
- `install-global.ts` → global CAAMP refresh (requires external process execution)

**Self-Update** (1)
- `self-update.ts` → file system ops and external process execution

**MCP Configuration** (1)
- `mcp-install.ts` → CAAMP provider detection, config file writes

**Commands Index** (1)
- `commands.ts` → deprecated Bash-era COMMANDS-INDEX.json lookup (should use MCP operations reference instead)

**Status**: VERIFIED AS CLI-ONLY — These have legitimate reasons to bypass dispatch.

---

#### CATEGORY B: Analytics & Reporting (4 commands)
Operations that generate analytics/reports from archived data.

**Archive Analytics** (1)
- `archive-stats.ts` → `getAccessor()`, `summaryReport()`, `cycleTimesReport()`, etc.
  - **Reason**: Statistical/analytical operations on archived tasks
  - **Expected Dispatch Route**: `admin archive.stats` (if added to spec)
  - **Migration Complexity**: **EASY** (already similar to list/analyze pattern)
  - **Changes Needed**:
    1. Add `archive.stats` operation to dispatch registry
    2. Create dispatch handler in `src/dispatch/engines/admin-engine.ts`
    3. Update `archive-stats.ts` to call `dispatchFromCli()`

**History & Logging** (1)
- `history.ts` → session history analytics
  - **Reason**: Historical task data analysis
  - **Expected Dispatch Route**: `session.history` (ALREADY exists!)
  - **Migration Complexity**: **MEDIUM** (command exists but may not be fully wired)
  - **Status**: AUDIT NEEDED — Check if `session.history` dispatch is properly implemented

**Trending/Metrics** (2)
- Partially covered by `stats.ts` (already using dispatch) and others

**Status**: EASY-TO-MEDIUM migration candidates.

---

#### CATEGORY C: Data Import/Export (4 commands)
Bulk operations involving cross-project file I/O and data transformation.

**Commands**:
- `export-tasks.ts` → cross-project export packaging
- `import-tasks.ts` → cross-project import with data transformation
- `export.ts` → generic data export
- `import.ts` → generic data import

**Core Imports**: 2-4 per file, mix of `getAccessor()`, file system ops
**Reason**: Complex data transformation, cross-project scope not in dispatch spec
**Expected Dispatch Routes**:
- `tools.export.tasks`? (not in spec)
- `tools.import.tasks`? (not in spec)

**Migration Complexity**: **HARD**
- These operations span project boundaries
- Require complex packaging/unpacking logic
- May not be suitable for remote MCP agents
- Decision needed: Should these be in dispatch at all?

**Status**: DEFER migration pending architecture review on cross-project operations scope.

---

#### CATEGORY D: Protocol Validation & Verification (5 commands)
Operations that validate CLEO protocol compliance and lifecycle gates.

**Commands**:
- `consensus.ts` → consensus protocol validation
- `contribution.ts` → contribution tracking/validation
- `decomposition.ts` → epic decomposition validation
- `implementation.ts` → implementation tracking validation
- `specification.ts` → specification compliance validation
- `verify.ts` → verification gate operations (2x partial - reopen/unarchive/backup-restore logic)

**Core Imports**: 3 per file
**Reason**: "Protocol validation separate from pipeline.stage.record lifecycle"
**Expected Dispatch Routes**: `check.protocol.*` or `pipeline.stage.verify`?
**Status**: ARCHITECTURE DECISION NEEDED
- These appear to be verification gate validators
- Pipeline domain includes stage.gate operations
- Question: Should these be `pipeline.stage.verify.*` subops?

**Migration Complexity**: **HARD**
- Requires understanding the relationship between verification gates and pipeline stages
- Comments suggest separate from pipeline.stage.record — clarify relationship
- May be custom protocols not suitable for standard dispatch

---

#### CATEGORY E: Phase Management (2 commands)
Phase and phase-listing operations (separate from pipeline stages).

**Commands**:
- `phase.ts` → phase operations
- `phases.ts` → phase listing

**Core Imports**: 3 per file
**Reason**: "No dispatch route for phase operations (pipeline domain covers stage lifecycle only)"
**Expected Dispatch Routes**: `pipeline.phase.*` or new domain?
**Migration Complexity**: **MEDIUM-HARD**
- Comments explicitly state pipeline domain "covers stage lifecycle only"
- Phase != Stage (architectural distinction to clarify)
- Need decision: Are phases first-class dispatch operations or CLI-only?

**Status**: ARCHITECTURE DECISION NEEDED

---

#### CATEGORY F: Label & Skill Management (2 commands)
Operations on labels and skills (not in tools domain spec).

**Commands**:
- `labels.ts` → label list/show/stats
- `skills.ts` → skill list/discover/validate/info/install

**Core Imports**: 3-4 per file
**Reason**: "No dispatch route for label/skill operations"
**Current Dispatch Status**:
- `tools.skill.*` operations DO EXIST in dispatch spec (6 query + 6 mutate)
- `tools` domain has skill suboperations per spec

**Finding**: **SKILLS SHOULD BE MIGRATED** — dispatch operations are defined!

**Labels Status**: No dispatch operations defined.
- Could add `tools.label.*` operations
- Or integrate with task field metadata

**Migration Complexity**:
- **Skills**: **MEDIUM** — dispatch routes exist, just need CLI wiring
- **Labels**: **EASY** — simple list/show operations, minimal wiring needed

---

#### CATEGORY G: Knowledge/Research Management (2 commands)
Memory and research-related operations (brain vs legacy).

**Commands**:
- `memory-brain.ts` → brain.db memory operations
- `migrate-claude-mem.ts` → claude-mem to brain.db migration

**Core Imports**: 2-3 per file
**Reason**: Memory domain dispatch for `memory-brain.ts`; migration is one-time CLI op
**Expected Dispatch Routes**:
- `memory.brain.*` (exists in dispatch spec under memory domain)
- `migrate-claude-mem` is a one-time data migration, CLI-only justified

**Migration Complexity**:
- **memory-brain**: **MEDIUM** — dispatch domain exists, needs CLI wiring
- **migrate-claude-mem**: **JUSTIFIED CLI-ONLY** — one-time migration operation

---

#### CATEGORY H: Documentation & Content Generation (3 commands)
File-based documentation and changelog generation.

**Commands**:
- `docs.ts` → documentation generation/lookup
- `generate-changelog.ts` → local CHANGELOG.md file generation
- `extract.ts` → TodoWrite state merge (skill extraction)

**Core Imports**: 2-3 per file
**Reason**: "Local file generation, not a dispatch operation"
**Status**: JUSTIFIED CLI-ONLY
- File system I/O for documentation
- Not suitable for remote agents
- Analogous to checkpoint (local ops only)

---

#### CATEGORY I: Issue & Contribution Tracking (2 commands)
Issue and contribution analytics (tools domain).

**Commands**:
- `issue.ts` → issue tracking operations
- `contribution.ts` → contribution tracking

**Core Imports**: 3 per file
**Reason**: Issue part of tools domain, contribution is protocol validation
**Current Dispatch Status**:
- `tools.issue.*` operations exist in dispatch spec
- `contribution` is validation/protocol, not standard CRUD

**Migration Complexity**:
- **issue**: **MEDIUM** — dispatch routes exist, needs wiring
- **contribution**: **HARD** — protocol validation, architecture decision needed

---

#### CATEGORY J: Data Integrity & Restoration (2 commands)
Backup, restore, snapshot operations.

**Commands**:
- `restore.ts` → complex multi-branch restoration (task reopen vs archive unarchive vs backup restore)
- `snapshot.ts` → multi-contributor snapshot export/import

**Core Imports**: 3-4 per file
**Reason**: "Complex multi-branch logic, not suitable for dispatch"
**Expected Dispatch Routes**:
- `tasks.restore` (exists for archives)
- `session.snapshot.*` or `admin.snapshot.*`?

**Migration Complexity**: **HARD**
- `restore.ts` has complex conditional logic (reopen vs unarchive vs backup-restore)
- May need to split into separate dispatch operations
- `snapshot.ts` is multi-contributor workflow, MCP scope question

---

#### CATEGORY K: Sharing & Remote Operations (1 command)
Sharing configuration and remote operations.

**Commands**:
- `sharing.ts` → config-driven sharing allowlist (T4883)
- `remote.ts` → .cleo/.git push/pull operations (T4884)

**Status**:
- `sharing.ts` may be configuration operation, not dispatch-suitable
- `remote.ts` is git-like (similar to checkpoint), CLI-only justified

---

#### CATEGORY L: Testing & Sync Operations (2 commands)
Development/testing and data synchronization.

**Commands**:
- `testing.ts` → manifest validation logic
- `sync.ts` → status/clear/inject/extract aliases (subcommand structure)

**Core Imports**: 3 per file
**Reason**: "Custom manifest validation, different subcommand structure"
**Status**:
- `sync` appears to be aliases/shortcuts for other operations
- `testing` is development-only operation

---

#### CATEGORY M: Miscellaneous/Unclear (3 commands)
Commands with minimal analysis data.

**Commands**:
- `grade.ts` → session grading
- `upgrade.ts` → version upgrade
- `nexus.ts` → cross-project file system access

**Core Imports**: 1-5 per file
**Status**:
- `grade.ts`: Session behavioral grading (T4916) — may map to `session.grade.*`
- `upgrade.ts`: Version/package upgrade — CLI-only justified (external process)
- `nexus.ts`: Cross-project operations (5 core imports) — separate architecture boundary

---

## Summary Table by Migration Complexity

### EASY (3 commands)
Operations with straightforward dispatch paths, minimal core imports:
1. **archive-stats.ts** → Add `admin.archive.stats` operation
2. **labels.ts** → Add `tools.label.list` and `tools.label.show`
3. **grade.ts** → Map to `session.grade` (pending spec)

**Estimated Effort**: 1 file each, ~100-200 lines of dispatch engine code per operation

### MEDIUM (8 commands)
Operations with existing/partial dispatch routes, need CLI wiring:
1. **skills.ts** → `tools.skill.*` ops exist, needs CLI wiring
2. **memory-brain.ts** → `memory.brain.*` ops exist, needs CLI wiring
3. **history.ts** → `session.history` exists, verify wiring
4. **issue.ts** → `tools.issue.*` ops exist, needs CLI wiring
5. **docs.ts** → Reevaluate (might be CLI-only + dispatch lookup)
6. **phase.ts** → Decision needed: `pipeline.phase.*` ops?
7. **phases.ts** → Decision needed: `pipeline.phase.list` op?
8. **restore.ts** → Partial dispatch (`tasks.restore` exists), complex logic may need split

**Estimated Effort**: 1 CLI file + 0-2 dispatch engine updates per command, ~150-400 lines

### HARD (12 commands)
Operations requiring architecture decisions or complex redesign:
1. **export-tasks.ts** → Cross-project scope, complex packaging
2. **import-tasks.ts** → Cross-project scope, complex data transformation
3. **export.ts** → Generic export, needs dispatch abstraction
4. **import.ts** → Generic import, needs dispatch abstraction
5. **consensus.ts** → Protocol validation, needs `check.consensus.*` ops
6. **contribution.ts** → Protocol validation, needs ops + decision
7. **decomposition.ts** → Protocol validation, needs ops + decision
8. **implementation.ts** → Protocol validation, needs ops + decision
9. **specification.ts** → Protocol validation, needs ops + decision
10. **verify.ts** → Verification gates, needs architecture review
11. **snapshot.ts** → Multi-contributor, needs workflow decision
12. **nexus.ts** → Cross-project, requires separate architecture

**Estimated Effort**: Requires epic/design review + 0-3 dispatch operations + CLI refactor

### JUSTIFIED CLI-ONLY (10 commands)
Operations with legitimate reasons to bypass dispatch:
1. **checkpoint.ts** → Git operations, local-only
2. **env.ts** → System diagnostics, local-only
3. **otel.ts** → Telemetry, local-only
4. **web.ts** → Process management, local-only
5. **install-global.ts** → External process, local-only
6. **self-update.ts** → Self-installation, local-only
7. **mcp-install.ts** → Config/provider detection, local-only
8. **commands.ts** → Deprecated lookup, should be removed or reimplemented
9. **generate-changelog.ts** → File generation, local-only
10. **extract.ts** → File I/O + skill state merge, local-only
11. **migrate-claude-mem.ts** → One-time migration, local-only
12. **remote.ts** → Git operations, local-only
13. **sharing.ts** → Config management, needs review
14. **upgrade.ts** → Package upgrade, external process

**Status**: No migration needed. These have documented reasons and are appropriately scoped.

### DEFER (6 commands)
Operations requiring architecture decisions before migration:
1. **consensus.ts** → Does protocol validation have dispatch role?
2. **contribution.ts** → Should contribution tracking be in dispatch?
3. **implementation.ts** → Should implementation gates be in dispatch?
4. **specification.ts** → Should spec validation be in dispatch?
5. **verify.ts** → How do verification gates fit into dispatch?
6. **phase.ts** / **phases.ts** → Are phases first-class dispatch operations?

**Blocker**: Need ADR or architecture decision on protocol validation scope in dispatch layer.

---

## Cross-Reference with Operations Reference

The canonical spec (`docs/specs/CLEO-OPERATIONS-REFERENCE.md` v1.2.0) defines:
- **10 canonical domains**: tasks, session, orchestrate, memory, check, pipeline, admin, tools, nexus, sharing
- **102 query operations** and **82 mutate operations** (184 total)
- **Tools domain** includes operations for: skill, issue, provider
- **Memory domain** includes operations for: research (legacy), brain (new)
- **Pipeline domain** includes: stage operations (no explicit phase ops)

### Missing Dispatch Operations Identified
Based on bypassing commands, these dispatch operations may be missing or unmapped:

| Operation | Domain | Type | Bypassing Command | Priority |
|-----------|--------|------|-------------------|----------|
| `archive.stats` | admin | query | archive-stats.ts | MEDIUM |
| `label.list` | tools | query | labels.ts | EASY |
| `label.show` | tools | query | labels.ts | EASY |
| `protocol.consensus` | check | mutate | consensus.ts | HARD |
| `protocol.contribution` | check | mutate | contribution.ts | HARD |
| `protocol.decomposition` | check | mutate | decomposition.ts | HARD |
| `protocol.implementation` | check | mutate | implementation.ts | HARD |
| `protocol.specification` | check | mutate | specification.ts | HARD |
| `gate.verify` | pipeline | mutate | verify.ts | HARD |
| `phase.list` | pipeline? | query | phases.ts | MEDIUM |
| `phase.show` | pipeline? | query | phase.ts | MEDIUM |
| `snapshot.export` | admin | mutate | snapshot.ts | HARD |
| `snapshot.import` | admin | mutate | snapshot.ts | HARD |

---

## Recommendations

### Phase 1: Quick Wins (EASY - 3 commands)
Implement these immediately, low risk, high value:
1. Migrate **archive-stats.ts** → add `admin.archive.stats` dispatch operation
2. Migrate **labels.ts** → add `tools.label.*` dispatch operations
3. Reevaluate **grade.ts** → may map to existing `session.grade` if it exists

**Effort**: ~500 LOC in dispatch engines + CLI rewiring
**Timeline**: 1-2 days
**Unblocks**: 3 commands, ~7% bypass reduction

### Phase 2: Protocol Decision (DEFER - 6 commands)
Create architecture decision record (ADR) on:
- Should protocol validation operations be in dispatch?
- Should phases be first-class dispatch entities?
- How do verification gates fit into dispatch model?

**Blocked Commands**: consensus, contribution, decomposition, implementation, specification, verify, phase, phases (8 total)

**Recommended**:
1. Schedule architecture review with team lead
2. Create ADR documenting protocol validation scope
3. Update dispatch registry with new operations (if approved)

### Phase 3: Cross-Project Operations (HARD - 5 commands)
Review and decide on:
- Should export/import be in dispatch at all?
- Can cross-project operations work with remote MCP agents?
- Should nexus operations have their own domain/gateway?

**Blocked Commands**: export-tasks, import-tasks, export, import, nexus, snapshot (6 total)

**Recommended**:
1. Document the cross-project operation boundary
2. Decide: dispatch-based or CLI-only?
3. If dispatch: create separate gateway or extend admin domain?

### Phase 4: Medium Migrations (MEDIUM - 8 commands)
After architecture decisions, migrate:
1. **skills.ts** → Wire existing `tools.skill.*` operations
2. **memory-brain.ts** → Wire existing `memory.brain.*` operations
3. **issue.ts** → Wire existing `tools.issue.*` operations
4. **history.ts** → Verify `session.history` wiring
5. Others as architecture decisions clarify

**Effort**: ~100-200 LOC per command
**Timeline**: 3-5 days with architecture decisions
**Unblocks**: 8 commands, ~19% bypass reduction

---

## Risk Assessment

### Code Quality Risks
- **39 direct core imports** bypass validation and consistency checks in dispatch
- **Inconsistent error handling** across CLI commands (some use dispatch error paths, others don't)
- **Harder to audit** — dispatch layer is single source of truth, direct imports obscure capabilities

### Testing Risks
- **46% of CLI commands** not exercising dispatch layer
- **Dispatch tests may not catch issues** used only via CLI
- **Regression risk** in dispatch changes not caught by CLI tests

### Architecture Risks
- **Maintenance burden** — two execution paths for similar operations
- **Feature parity gap** — MCP agents can't access ~46% of CLI operations
- **Documentation debt** — CLEO-OPERATIONS-REFERENCE.md doesn't reflect actual CLI routing

---

## Conclusion

Of 39 bypassing commands:
- **10 are JUSTIFIED CLI-ONLY** (no dispatch needed)
- **3 are EASY migrations** (quick wins)
- **8 are MEDIUM migrations** (depends on architecture decisions)
- **12 are HARD migrations** (requires design reviews)
- **6 require ARCHITECTURE DECISIONS** (before migration)

**Recommended Next Steps**:
1. Complete Phase 1 (easy migrations) immediately
2. Schedule architecture review for Phase 2 (protocol validation scope)
3. Document decision on Phase 3 (cross-project operations)
4. Execute Phase 4 (medium migrations) once decisions are clear

**Target State**: Reduce dispatch bypass from 46% to <10% (justified CLI-only operations only)

---

## Appendix: Commands by Bypass Reason

### Git/Process Operations (CLI-Only, No Migration)
- checkpoint.ts, remote.ts, web.ts, install-global.ts, self-update.ts, mcp-install.ts, env.ts, otel.ts, commands.ts, upgrade.ts

### File Generation (CLI-Only, No Migration)
- generate-changelog.ts, extract.ts, docs.ts, migrate-claude-mem.ts, sharing.ts

### Analytics/Reporting (Easy-Medium Migration)
- archive-stats.ts (EASY), history.ts (MEDIUM)

### Data Import/Export (Hard Migration, Requires Design)
- export-tasks.ts, import-tasks.ts, export.ts, import.ts, snapshot.ts, nexus.ts

### Protocol Validation (Hard Migration, Requires Design)
- consensus.ts, contribution.ts, decomposition.ts, implementation.ts, specification.ts, verify.ts

### Phase Management (Medium Migration, Requires Design)
- phase.ts, phases.ts

### Skill/Label Management (Medium Migration, Dispatch Exists)
- skills.ts, labels.ts, issue.ts

### Session Grading (Medium Migration, Dispatch May Exist)
- grade.ts

