# CLEO Migration Analysis: Bash to TypeScript

**Document Version:** 2026.2.5  
**Status:** Active Migration (Dual System)  
**Last Updated:** 2026-02-19

---

## Executive Summary

CLEO has undergone a major architectural migration from **Bash/JQ** to **TypeScript/Node.js**. This document provides a complete cross-walk analysis for comparing the legacy Bash system to the new TypeScript implementation, identifying what needs preservation for comparison, and planning documentation updates.

### Migration Status
- **Bash Scripts:** 86 scripts (deprecated, retained for comparison)
- **Bash Libraries:** 119 files (deprecated, retained for comparison)
- **TypeScript Commands:** 80+ commands (active, primary)
- **TypeScript Tests:** 128 test files (active)
- **BATS Tests:** 273 test files (legacy, reference)

---

## Part 1: Command Cross-Walk Reference

### 1.1 Core Task Management Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/add.sh` | `src/cli/commands/add.ts` | ✅ Migrated | Full feature parity |
| `scripts/update.sh` | `src/cli/commands/update.ts` | ✅ Migrated | Enhanced validation |
| `scripts/delete.sh` | `src/cli/commands/delete.ts` | ✅ Migrated | Safer deletion with previews |
| `scripts/complete.sh` | `src/cli/commands/complete.ts` | ✅ Migrated | Cascade completion logic |
| `scripts/reopen.sh` | `src/cli/commands/reopen.ts` | ✅ Migrated | Status transitions |
| `scripts/list.sh` | `src/cli/commands/list.ts` | ✅ Migrated | Enhanced filtering |
| `scripts/show.sh` | `src/cli/commands/show.ts` | ✅ Migrated | Rich output formatting |
| `scripts/find.sh` | `src/cli/commands/find.ts` | ✅ Migrated | Multi-field search |
| `scripts/exists.sh` | `src/cli/commands/exists.ts` | ✅ Migrated | Exit codes preserved |

**Bash Dependencies:**
- `lib/core/file-ops.sh` → `src/store/atomic.ts`
- `lib/core/logging.sh` → `src/core/log/logging.ts`
- `lib/core/output-format.sh` → `src/core/output.ts`
- `lib/validation/validation.sh` → `src/core/validation/engine.ts`

### 1.2 Hierarchy & Relationship Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/reparent.sh` | `src/cli/commands/reparent.ts` | ✅ Migrated | Tree restructuring |
| `scripts/relates.sh` | `src/cli/commands/relates.ts` | ✅ Migrated | Bidirectional linking |
| `scripts/reorder.sh` | `src/cli/commands/reorder.ts` | ✅ Migrated | Position management |
| `scripts/promote.sh` | `src/cli/commands/promote.ts` | ✅ Migrated | Type promotion logic |
| `scripts/deps.sh` | `src/cli/commands/deps.ts` | ✅ Migrated | Dependency graph |
| `scripts/blockers.sh` | `src/cli/commands/blockers.ts` | ✅ Migrated | Blocker analysis |

**Bash Dependencies:**
- `lib/tasks/hierarchy.sh` → `src/core/tasks/hierarchy.ts`
- `lib/tasks/graph-*.sh` → `src/core/tasks/graph*.ts`

### 1.3 Session & Context Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/session.sh` | `src/cli/commands/session.ts` | ✅ Migrated | Active session tracking |
| `scripts/context.sh` | `src/cli/commands/context.ts` | ✅ Migrated | Context state management |
| `scripts/checkpoint.sh` | `src/cli/commands/checkpoint.ts` | ✅ Migrated | Git integration |
| `scripts/lifecycle.sh` | `src/cli/commands/lifecycle.ts` | ✅ Migrated | Phase transitions |
| `scripts/phase.sh` | `src/cli/commands/phase.ts` | ✅ Migrated | Phase operations |
| `scripts/phases.sh` | `src/cli/commands/phases.ts` | ✅ Migrated | Phase listing |

**Bash Dependencies:**
- `lib/session/sessions.sh` → `src/core/sessions/sessions.ts`
- `lib/session/context-*.sh` → `src/core/context/context*.ts`
- `lib/data/git-checkpoint.sh` → `src/store/git-checkpoint.ts`

### 1.4 Research & Analysis Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/research.sh` | `src/cli/commands/research.ts` | ✅ Migrated | CAAMP protocol |
| `scripts/analyze.sh` | `src/cli/commands/analyze.ts` | ✅ Migrated | Task analysis |
| `scripts/decomposition.sh` | `src/cli/commands/decomposition.ts` | ✅ Migrated | Epic breakdown |
| `scripts/consensus.sh` | `src/cli/commands/consensus.ts` | ✅ Migrated | Multi-agent consensus |
| `scripts/contribution.sh` | `src/cli/commands/contribution.ts` | ✅ Migrated | Contribution protocol |

**Bash Dependencies:**
- `lib/skills/orchestrator-*.sh` → `src/core/orchestration/*.ts`
- RCSD protocol files → `src/core/research/`

### 1.5 Release & Validation Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/release.sh` | `src/cli/commands/release.ts` | ✅ Migrated | Full release workflow |
| `scripts/validate.sh` | `src/cli/commands/validate.ts` | ✅ Migrated | Validation framework |
| `scripts/validation.sh` | `src/cli/commands/validation.ts` | ✅ Migrated | Batch validation |
| `scripts/verify.sh` | `src/cli/commands/verify.ts` | ✅ Migrated | Verification gates |
| `scripts/upgrade.sh` | `src/cli/commands/upgrade.ts` | ✅ Migrated | System upgrades |
| `scripts/self-update.sh` | `src/cli/commands/self-update.ts` | ✅ Migrated | Auto-updates |
| `scripts/compliance.sh` | `src/cli/commands/compliance.ts` | ✅ Migrated | Compliance checking |
| `scripts/doctor.sh` | `src/cli/commands/doctor.ts` | ✅ Migrated | Diagnostics |

**Bash Dependencies:**
- `lib/release/*.sh` → `src/core/release/*.ts`
- `lib/validation/*.sh` → `src/core/validation/*.ts`

### 1.6 Data Management Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/backup.sh` | `src/cli/commands/backup.ts` | ✅ Migrated | Multiple formats |
| `scripts/restore.sh` | `src/cli/commands/restore.ts` | ✅ Migrated | Selective restore |
| `scripts/export.sh` | `src/cli/commands/export.ts` | ✅ Migrated | Multiple formats |
| `scripts/export-tasks.sh` | `src/cli/commands/export-tasks.ts` | ✅ Migrated | Task-only export |
| `scripts/import-tasks.sh` | `src/cli/commands/import-tasks.ts` | ✅ Migrated | Import with remapping |
| `scripts/migrate.sh` | `src/cli/commands/migrate.ts` | ✅ Migrated | Data migrations |
| `scripts/sync.sh` | `src/cli/commands/sync.ts` | ✅ Migrated | Remote sync |
| `scripts/archive.sh` | `src/cli/commands/archive.ts` | ✅ Migrated | Archival operations |
| `scripts/unarchive.sh` | `src/cli/commands/unarchive.ts` | ✅ Migrated | Restore from archive |
| `scripts/uncancel.sh` | `src/cli/commands/uncancel.ts` | ✅ Migrated | Uncancel tasks |
| `scripts/archive-stats.sh` | `src/cli/commands/archive-stats.ts` | ✅ Migrated | Archive analytics |
| `scripts/stats.sh` | `src/cli/commands/stats.ts` | ✅ Migrated | Statistics |

**Bash Dependencies:**
- `lib/data/backup.sh` → `src/store/backup.ts`
- `lib/data/export.sh` → `src/store/export.ts`
- `lib/data/migrate.sh` → `src/core/migration/*.ts`

### 1.7 Development Tools Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/skills.sh` | `src/cli/commands/skills.ts` | ✅ Migrated | Skills management |
| `scripts/orchestrator.sh` | `src/cli/commands/orchestrate.ts` | ✅ Migrated | Orchestration |
| `scripts/inject.sh` | `src/cli/commands/inject.ts` | ✅ Migrated | Context injection |
| `scripts/mcp-install.sh` | `src/cli/commands/mcp-install.ts` | ✅ Migrated | MCP setup |
| `scripts/claude-migrate.sh` | `src/cli/commands/claude-migrate.ts` | ✅ Migrated | Claude migration |
| `scripts/testing.sh` | `src/cli/commands/testing.ts` | ✅ Migrated | Test utilities |
| `scripts/otel.sh` | `src/cli/commands/otel.ts` | ✅ Migrated | OpenTelemetry |
| `scripts/log.sh` | `src/cli/commands/log.ts` | ✅ Migrated | Task logging |

**Bash Dependencies:**
- `lib/skills/*.sh` → `src/core/skills/*.ts`
- `lib/ui/injection-*.sh` → `src/core/inject/*.ts`

### 1.8 Nexus System Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/nexus.sh` | `src/cli/commands/nexus.ts` | ✅ Migrated | Nexus registry |
| `scripts/nexus-query.sh` | Integrated into `nexus.ts` | ✅ Migrated | Query operations |
| `scripts/nexus-discover.sh` | Integrated into `nexus.ts` | ✅ Migrated | Discovery |
| `scripts/nexus-search.sh` | Integrated into `nexus.ts` | ✅ Migrated | Search |

**Bash Dependencies:**
- `lib/data/nexus-*.sh` → `src/core/nexus/*.ts`

### 1.9 Utility & Configuration Commands

| Bash Script | TypeScript Command | Status | Notes |
|-------------|-------------------|--------|-------|
| `scripts/config.sh` | `src/cli/commands/config.ts` | ✅ Migrated | Configuration |
| `scripts/commands.sh` | `src/cli/commands/commands.ts` | ✅ Migrated | Command listing |
| `scripts/dash.sh` | `src/cli/commands/dash.ts` | ✅ Migrated | Dashboard |
| `scripts/env.sh` | `src/cli/commands/env.ts` | ✅ Migrated | Environment |
| `scripts/extract.sh` | `src/cli/commands/extract.ts` | ✅ Migrated | Data extraction |
| `scripts/focus.sh` | `src/cli/commands/focus.ts` | ✅ Migrated | Focus mode |
| `scripts/generate-changelog.sh` | `src/cli/commands/generate-changelog.ts` | ✅ Migrated | Changelog gen |
| `scripts/history.sh` | `src/cli/commands/history.ts` | ✅ Migrated | Task history |
| `scripts/implementation.sh` | `src/cli/commands/implementation.ts` | ✅ Migrated | Implementation |
| `scripts/init.sh` | `src/cli/commands/init.ts` | ✅ Migrated | Initialization |
| `scripts/issue.sh` | `src/cli/commands/issue.ts` | ✅ Migrated | Issue integration |
| `scripts/labels.sh` | `src/cli/commands/labels.ts` | ✅ Migrated | Label management |
| `scripts/next.sh` | `src/cli/commands/next.ts` | ✅ Migrated | Next task |
| `scripts/roadmap.sh` | `src/cli/commands/roadmap.ts` | ✅ Migrated | Roadmap view |
| `scripts/safestop.sh` | `src/cli/commands/safestop.ts` | ✅ Migrated | Safe stopping |
| `scripts/sequence.sh` | `src/cli/commands/sequence.ts` | ✅ Migrated | Sequence mgmt |
| `scripts/specification.sh` | `src/cli/commands/specification.ts` | ✅ Migrated | Spec creation |
| `scripts/web.sh` | `src/cli/commands/web.ts` | ✅ Migrated | Web interface |

---

## Part 2: Library Cross-Walk

### 2.1 Core Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/core/config.sh` | `src/types/config.ts` | Configuration types |
| `lib/core/exit-codes.sh` | `src/types/exit-codes.ts` | Exit code definitions |
| `lib/core/jq-helpers.sh` | `src/store/*.ts` | Data accessors |
| `lib/core/json-output.sh` | `src/core/output.ts` | Output formatting |
| `lib/core/logging.sh` | `src/core/log/logging.ts` | Logging system |
| `lib/core/output-format.sh` | `src/core/output.ts` | Format handlers |
| `lib/core/paths.sh` | `src/store/provider.ts` | Path resolution |
| `lib/core/platform-compat.sh` | Built-in Node.js | Platform compatibility |
| `lib/core/sequence.sh` | `src/core/sequence/sequence.ts` | Sequence counter |
| `lib/core/version.sh` | `package.json` | Version management |

### 2.2 Data Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/data/atomic-write.sh` | `src/store/atomic.ts` | Atomic file operations |
| `lib/data/backup.sh` | `src/store/backup.ts` | Backup operations |
| `lib/data/cache.sh` | `src/store/cache.ts` | Caching layer |
| `lib/data/export.sh` | `src/store/export.ts` | Export logic |
| `lib/data/file-ops.sh` | `src/store/atomic.ts` | File operations |
| `lib/data/git-checkpoint.sh` | `src/store/git-checkpoint.ts` | Git integration |
| `lib/data/migrate.sh` | `src/core/migration/*.ts` | Migration logic |
| `lib/data/nexus-*.sh` | `src/core/nexus/*.ts` | Nexus system |
| `lib/data/project-*.sh` | `src/store/project-registry.ts` | Project detection |

### 2.3 Task Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/tasks/analysis.sh` | `src/core/tasks/analysis.ts` | Task analysis |
| `lib/tasks/archive-cancel.sh` | `src/core/tasks/archive.ts` | Archival logic |
| `lib/tasks/cancel-ops.sh` | `src/core/tasks/cancel.ts` | Cancel operations |
| `lib/tasks/delete-preview.sh` | `src/core/tasks/delete.ts` | Deletion preview |
| `lib/tasks/deletion-strategy.sh` | `src/core/tasks/delete.ts` | Safe deletion |
| `lib/tasks/graph-*.sh` | `src/core/tasks/graph*.ts` | Graph operations |
| `lib/tasks/hierarchy.sh` | `src/core/tasks/hierarchy.ts` | Hierarchy mgmt |
| `lib/tasks/lifecycle.sh` | `src/core/lifecycle/lifecycle.ts` | Lifecycle logic |
| `lib/tasks/phase-tracking.sh` | `src/core/phases/phase-tracking.ts` | Phase tracking |
| `lib/tasks/task-mutate.sh` | `src/core/tasks/mutate.ts` | Task mutations |

### 2.4 Session Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/session/sessions.sh` | `src/core/sessions/sessions.ts` | Session mgmt |
| `lib/session/context-alert.sh` | `src/core/context/alert.ts` | Context alerts |
| `lib/session/context-monitor.sh` | `src/core/context/monitor.ts` | Monitoring |
| `lib/session/hitl-warnings.sh` | `src/core/context/hitl.ts` | HITL warnings |
| `lib/session/lock-detection.sh` | `src/store/lock.ts` | Lock management |
| `lib/session/session-enforcement.sh` | `src/core/sessions/enforcement.ts` | Enforcement |
| `lib/session/session-migration.sh` | `src/core/migration/session.ts` | Session migration |

### 2.5 Skills Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/skills/agent-*.sh` | `src/core/skills/agents/*.ts` | Agent management |
| `lib/skills/manifest-*.sh` | `src/core/skills/manifests/*.ts` | Manifest handling |
| `lib/skills/orchestrator-*.sh` | `src/core/skills/orchestrator/*.ts` | Orchestration |
| `lib/skills/skill-*.sh` | `src/core/skills/*.ts` | Skills system |
| `lib/skills/subagent-inject.sh` | `src/core/skills/injection/*.ts` | Injection |

### 2.6 Validation Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/validation/compliance-check.sh` | `src/core/validation/compliance.ts` | Compliance |
| `lib/validation/doctor-*.sh` | `src/core/validation/doctor/*.ts` | Diagnostics |
| `lib/validation/docs-sync.sh` | `src/core/validation/docs-sync.ts` | Doc validation |
| `lib/validation/gap-check.sh` | `src/core/validation/gap.ts` | Gap analysis |
| `lib/validation/manifest-validation.sh` | `src/core/validation/manifest.ts` | Manifest validation |
| `lib/validation/protocol-validation*.sh` | `src/core/validation/protocols/*.ts` | Protocol validation |
| `lib/validation/validation.sh` | `src/core/validation/engine.ts` | Validation engine |
| `lib/validation/verification.sh` | `src/core/validation/verification.ts` | Verification |

### 2.7 Release Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/release/release.sh` | `src/core/release/release.ts` | Release logic |
| `lib/release/release-artifacts.sh` | `src/core/release/artifacts.ts` | Artifacts |
| `lib/release/release-ci.sh` | `src/core/release/ci.ts` | CI integration |
| `lib/release/release-config.sh` | `src/core/release/config.ts` | Release config |
| `lib/release/release-guards.sh` | `src/core/release/guards.ts` | Release guards |
| `lib/release/release-provenance.sh` | `src/core/release/provenance.ts` | Provenance |
| `lib/release/version-bump.sh` | `src/core/release/version.ts` | Version bumping |

### 2.8 UI Libraries

| Bash Library | TypeScript Module | Purpose |
|--------------|-------------------|---------|
| `lib/ui/changelog.sh` | `src/core/ui/changelog.ts` | Changelog UI |
| `lib/ui/claude-aliases.sh` | `src/core/ui/aliases.ts` | Aliases |
| `lib/ui/command-registry.sh` | `src/cli/index.ts` | Command registry |
| `lib/ui/flags.sh` | `src/cli/*.ts` | Flag handling |
| `lib/ui/injection-*.sh` | `src/core/inject/*.ts` | Injection system |
| `lib/ui/mcp-config.sh` | `src/core/mcp/*.ts` | MCP configuration |
| `lib/ui/version-check.sh` | `src/core/ui/version.ts` | Version checking |

---

## Part 3: Git Tree Cleanup Plan

### 3.1 Files to Remove from Git Tree (Keep Locally)

These files should be removed from active git tracking but preserved locally for comparison purposes:

#### Scripts Directory (86 files)
```
scripts/*.sh
```
**Action:** Remove from `.gitignore` after moving to archive

#### Library Directory (119 files)
```
lib/**/*.sh
```
**Action:** Archive to `archive/bash-libs/` before removal

#### BATS Tests (273 files)
```
tests/unit/*.bats
tests/edge-cases/*.bats
tests/functional/*.bats
tests/migration/*.bats
```
**Action:** Keep for regression testing during transition

#### Test Libraries (Git Submodules)
```
tests/libs/bats-assert/
tests/libs/bats-support/
tests/libs/bats-file/
```
**Action:** Keep for running legacy tests

### 3.2 Files to Keep in Git Tree

#### Core Infrastructure
- `install.sh` - Still needed for installation
- `build.mjs` - TypeScript build system
- `package.json` - Node.js dependencies
- `tsconfig.json` - TypeScript config
- `vitest.config.ts` - Test runner config

#### TypeScript Source
- `src/` - All TypeScript source code
- `dist/` - Compiled output (may be gitignored)

#### Documentation
- `docs/` - All documentation (needs updates)
- `README.md` - Main README
- `CLAUDE.md` - Agent documentation
- `AGENTS.md` - Agent-specific guide
- `CHANGELOG.md` - Version history

#### Configuration
- `schemas/` - JSON schemas
- `templates/` - Configuration templates
- `completions/` - Shell completions
- `.github/` - GitHub workflows

### 3.3 Archive Strategy

Create archive structure for deprecated Bash code:

```
archive/
├── bash-legacy/
│   ├── scripts/           # Copy of scripts/*.sh
│   ├── lib/              # Copy of lib/**/*.sh
│   ├── tests/            # Copy of tests/**/*.bats
│   └── README.md         # Migration notes
└── migration-guide/
    ├── cross-walk.md     # This document
    ├── bash-to-ts.md     # Conversion patterns
    └── compatibility.md  # Compatibility notes
```

---

## Part 4: Documentation Update Plan

### 4.1 Critical Documentation Updates Needed

#### Update Priority: HIGH

1. **README.md**
   - Update installation instructions for TypeScript version
   - Remove Bash-specific setup
   - Add Node.js requirement (>=20.0.0)
   - Update quickstart examples

2. **CLAUDE.md**
   - Update command references to TypeScript
   - Remove Bash-specific development tools
   - Update build/test commands
   - Add TypeScript-specific guidelines

3. **AGENTS.md**
   - Update agent documentation for TS system
   - Remove Bash script references
   - Add TypeScript coding standards

#### Update Priority: MEDIUM

4. **docs/getting-started/**
   - `installation.mdx` - Update for npm/Node.js
   - `quickstart.mdx` - TypeScript examples
   - `mcp-server.mdx` - Already TS-focused

5. **docs/commands/**
   - 80+ command files need review
   - Ensure examples use `cleo` (not `./scripts/`)
   - Update output format examples (JSON/TS differences)

6. **docs/guides/**
   - Update development workflow guides
   - Remove Bash-specific scripting guides
   - Add TypeScript development patterns

#### Update Priority: LOW

7. **docs/developer/**
   - Add TypeScript architecture docs
   - Document migration from Bash
   - Add testing guidelines (Vitest)

8. **docs/concepts/**
   - Update architecture diagrams
   - Document data flow (SQLite vs JSON)

### 4.2 Specific Documentation Changes Required

#### Installation Documentation
```markdown
# OLD (Bash)
./install.sh
source ~/.bashrc

# NEW (TypeScript)
npm install -g @cleocode/cleo
# OR
npx @cleocode/cleo
```

#### Command Examples
```markdown
# OLD (Bash)
./scripts/add.sh "New Task"

# NEW (TypeScript)
cleo add "New Task"
```

#### Development Workflow
```markdown
# OLD (Bash)
./tests/run-all-tests.sh

# NEW (TypeScript)
npm test
npm run test:coverage
```

### 4.3 Documentation Structure Updates

Create new documentation sections:

```
docs/
├── migration/
│   ├── bash-to-typescript.mdx    # NEW: Migration guide
│   ├── command-comparison.mdx     # NEW: Side-by-side
│   ├── library-comparison.mdx     # NEW: Library mapping
│   └── breaking-changes.mdx       # NEW: Breaking changes
├── typescript/
│   ├── architecture.mdx           # NEW: TS architecture
│   ├── development.mdx            # NEW: TS dev guide
│   ├── testing.mdx                # NEW: Testing guide
│   └── migration-patterns.mdx     # NEW: Patterns
└── reference/
    ├── bash-legacy.mdx            # NEW: Legacy reference
    └── migration-status.mdx       # NEW: Status tracking
```

---

## Part 5: Testing Migration

### 5.1 Test Strategy

**Phase 1: Parallel Testing**
- Run BATS tests against Bash implementation
- Run Vitest tests against TypeScript implementation
- Compare outputs for consistency

**Phase 2: Transition**
- Port critical BATS tests to Vitest
- Ensure feature parity in test coverage
- Maintain BATS tests as regression suite

**Phase 3: Deprecation**
- Remove BATS tests once TS tests cover all features
- Archive BATS tests for reference

### 5.2 Test Coverage Comparison

| Feature | BATS Tests | Vitest Tests | Status |
|---------|-----------|--------------|--------|
| add | ✅ | ✅ | Parity |
| complete | ✅ | ✅ | Parity |
| delete | ✅ | ✅ | Parity |
| update | ✅ | ✅ | Parity |
| list | ✅ | ✅ | Parity |
| archive | ✅ | ⚠️ | Partial |
| backup | ✅ | ⚠️ | Partial |
| validation | ✅ | ⚠️ | Partial |
| session | ✅ | ⚠️ | Partial |

---

## Part 6: Migration Checklist

### Pre-Migration
- [ ] Archive Bash scripts to `archive/bash-legacy/`
- [ ] Archive Bash libraries to `archive/bash-legacy/lib/`
- [ ] Create comprehensive backup
- [ ] Document current Bash behavior
- [ ] Run full BATS test suite (baseline)

### During Migration
- [ ] Remove `scripts/` from git tracking
- [ ] Remove `lib/` from git tracking
- [ ] Update `.gitignore` to exclude archived files
- [ ] Update `package.json` files array
- [ ] Verify TypeScript build works
- [ ] Run Vitest test suite

### Post-Migration
- [ ] Update README.md
- [ ] Update CLAUDE.md
- [ ] Update AGENTS.md
- [ ] Update installation docs
- [ ] Update command reference docs
- [ ] Update development workflow docs
- [ ] Create migration guide
- [ ] Update CHANGELOG.md

### Verification
- [ ] Clean clone builds successfully
- [ ] All TypeScript tests pass
- [ ] Documentation is accurate
- [ ] Installation works from npm
- [ ] MCP server functions correctly

---

## Part 7: Breaking Changes Reference

### 7.1 Command Interface Changes

| Aspect | Bash | TypeScript | Impact |
|--------|------|------------|--------|
| Binary | `./scripts/<cmd>.sh` | `cleo <cmd>` | Scripts now global CLI |
| Shebang | `#!/bin/bash` | `#!/usr/bin/env node` | Runtime change |
| Data Store | JSON files only | SQLite + JSON | Enhanced performance |
| Output | JQ-based | Native TS | Consistent formatting |
| Config | `.env` + files | `config.json` + env | Unified config |

### 7.2 Behavioral Changes

1. **Atomic Operations**
   - Bash: Manual temp file + mv
   - TypeScript: `write-file-atomic` library
   - Impact: More reliable, less code

2. **Data Validation**
   - Bash: JQ validation + manual checks
   - TypeScript: AJV JSON Schema validation
   - Impact: Stronger validation, better errors

3. **Error Handling**
   - Bash: Exit codes only
   - TypeScript: Rich error objects with context
   - Impact: Better debugging

4. **Logging**
   - Bash: File-based JSONL
   - TypeScript: Structured logging with levels
   - Impact: Better observability

---

## Part 8: Implementation Notes

### 8.1 Git Commands for Cleanup

```bash
# Step 1: Archive current Bash code
git checkout -b archive/bash-legacy
mkdir -p archive/bash-legacy
cp -r scripts lib tests archive/bash-legacy/
git add archive/bash-legacy/
git commit -m "archive: preserve Bash legacy code for reference"

# Step 2: Remove from main branch
git checkout main
git rm -r scripts/ lib/
git commit -m "refactor: remove deprecated Bash code (see archive/bash-legacy branch)"

# Step 3: Update .gitignore
echo "# Legacy Bash code (preserved in archive/bash-legacy branch)" >> .gitignore
echo "scripts/" >> .gitignore
echo "lib/" >> .gitignore
git add .gitignore
git commit -m "chore: add legacy directories to .gitignore"
```

### 8.2 Package.json Updates

```json
{
  "files": [
    "dist",
    "schemas",
    "templates",
    "skills",
    "completions",
    "archive/bash-legacy"
  ],
  "scripts": {
    "test:legacy": "./tests/run-all-tests.sh",
    "test:ts": "vitest run"
  }
}
```

---

## Appendix A: File Inventory

### Bash Scripts (86 files)
See `scripts/` directory listing in repository.

### Bash Libraries (119 files)
See `lib/` directory listing:
- `lib/core/` - 15 files
- `lib/data/` - 15 files
- `lib/issue/` - 1 file
- `lib/metrics/` - 6 files
- `lib/release/` - 7 files
- `lib/session/` - 6 files
- `lib/skills/` - 14 files
- `lib/tasks/` - 14 files
- `lib/ui/` - 9 files
- `lib/validation/` - 13 files

### TypeScript Commands (80+ files)
See `src/cli/commands/` directory listing.

### Documentation Files (524 files)
See `docs/` directory listing.

---

## Appendix B: Exit Code Mapping

| Exit Code | Bash Meaning | TypeScript Meaning |
|-----------|--------------|-------------------|
| 0 | Success | Success |
| 1 | General error | General error |
| 2 | Invalid arguments | Invalid arguments |
| 3 | File not found | Resource not found |
| 4 | Validation failed | Validation failed |
| 5 | Permission denied | Permission denied |
| 60-67 | Protocol violations | Protocol violations |
| 80-84 | Verification gates | Verification gates |
| 85-99 | Nexus codes | Nexus codes |

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-19 | 1.0 | Initial cross-walk document |

---

## References

- TypeScript CLI Entry: `src/cli/index.ts`
- TypeScript Command Directory: `src/cli/commands/`
- Bash Scripts: `scripts/` (deprecated)
- Bash Libraries: `lib/` (deprecated)
- Test Suite: `tests/` (BATS - deprecated), `src/**/__tests__/` (Vitest - active)
