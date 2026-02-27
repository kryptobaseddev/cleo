# CLI/MCP Parity Analysis

**Version**: 1.0.0
**Status**: stable
**Date**: 2026-02-20
**Task**: T4793
**Scope**: Full parity analysis between CLI commands and MCP operations with dispositions

---

## 1. Methodology

### Data Sources
- CLI command registrations: `src/cli/index.ts` (77 registered commands)
- MCP query operations: `src/mcp/gateways/query.ts` (75 operations across 10 domains)
- MCP mutate operations: `src/mcp/gateways/mutate.ts` (65 operations across 11 domains)
- MCP domain handlers: `src/mcp/domains/*.ts`
- Capability matrix: `src/mcp/engine/capability-matrix.ts`

### Decision Framework
Each single-layer operation is classified as:
- **ADD**: Add to the missing layer (core function exists or is trivial)
- **KEEP-SINGLE**: Intentionally single-layer with documented rationale
- **DEPRECATE**: Remove or mark as deprecated

---

## 2. CLI-Only Operations (No MCP Equivalent)

### 2.1 Protocol Validation Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `consensus validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "consensus"`. The CLI command is a convenience wrapper. |
| `contribution validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "contribution"`. |
| `decomposition validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "decomposition"`. |
| `implementation validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "implementation"`. |
| `specification validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "specification"`. |
| `testing validate/check` | KEEP-SINGLE | Subsumed by `validate.protocol` MCP operation with `protocolType: "testing"`. |

**Rationale**: These six protocol-specific CLI commands are thin wrappers around `src/core/validation/protocols/*.ts`. The MCP `validate.protocol` operation already covers all protocol types via its `protocolType` parameter. The CLI commands exist as user-friendly shortcuts and do not need MCP equivalents.

### 2.2 Environment & Installation Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `env status/info` | KEEP-SINGLE | CLI-specific: inspects runtime binary paths, compilation status, VERSION file. Not meaningful for MCP agents. |
| `self-update` | KEEP-SINGLE | CLI-specific: manages binary updates via shell scripts. MCP agents do not self-update. |
| `upgrade` | KEEP-SINGLE | CLI-specific: runs storage migration, schema repair. Requires interactive confirmation. |
| `claude-migrate` | DEPRECATE | Legacy migration from `.claude/` to `.cleo/`. One-time operation, no longer needed for new installations. |
| `upgrade` | KEEP-SINGLE | CLI-specific: storage migration, schema repair, data integrity fixes. Requires interactive confirmation. |

### 2.3 Git & Checkpoint Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `checkpoint` | KEEP-SINGLE | CLI-specific: performs git commit of CLEO state files. Requires git binary. MCP agents can use `system.backup` for data safety. |
| `generate-changelog` | KEEP-SINGLE | CLI-specific: generates platform-specific changelog files (Mintlify, Docusaurus). File I/O operation better suited to CLI. MCP has `release.changelog` for changelog content generation. |

### 2.4 Cross-Project & Discovery Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `nexus` (all subcommands) | KEEP-SINGLE | Cross-project federation operates on global `~/.cleo/nexus/` registry. MCP server is project-scoped. Adding nexus to MCP would require cross-project filesystem access that breaks the MCP server's single-project model. |

### 2.5 Data Import/Export Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `extract` | KEEP-SINGLE | TodoWrite session sync. Merges external TodoWrite state back into CLEO. Specific to Claude Code's TodoWrite integration. |
| `import <file>` | KEEP-SINGLE | File-based task import with duplicate handling strategies. The MCP `tasks.add` handles individual task creation; bulk import from files is a CLI concern. |

### 2.6 Observability Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `otel` (all subcommands) | KEEP-SINGLE | OpenTelemetry token metrics inspection. Reads from `~/.cleo/metrics/otel/` directory. MCP agents don't need to inspect their own token usage through the task management protocol. |

### 2.7 Deprecated/Backward-Compat Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `focus` (show/set/clear/history) | DEPRECATE | Fully replaced by `start`/`stop`/`current` commands (T4756). Kept only for backward compatibility. MCP already uses `tasks.start`/`tasks.stop`/`tasks.current`. |

### 2.8 Verification Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `verify <taskId>` | KEEP-SINGLE | Verification gate management. Already covered by MCP through `tasks.update` with verification fields, and `validate.protocol` for protocol compliance checks. The CLI `verify` command provides a dedicated UX for gate management. |

### 2.9 Web UI Commands

| CLI Command | Decision | Rationale |
|---|---|---|
| `web` (start/stop/status/open) | KEEP-SINGLE | Process lifecycle management for web server. Requires spawn/kill of OS processes. Not appropriate for MCP. |

### 2.10 History Command

| CLI Command | Decision | Rationale |
|---|---|---|
| `history` | KEEP-SINGLE | Completion timeline analytics. Core function `getCompletionHistory()` exists in `src/core/stats/`. MCP already has `session.history` for session-level history. Task completion history could be accessed through existing `system.stats` or `system.log` operations. |

---

## 3. MCP-Only Operations (No CLI Equivalent)

### 3.1 Session Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `session.record.decision` | KEEP-SINGLE | MCP-specific: designed for agents to record architectural decisions during sessions. The structured `{sessionId, taskId, decision, rationale}` format is agent-centric. Human users can use notes. |
| `session.record.assumption` | KEEP-SINGLE | MCP-specific: designed for agents to record assumptions with confidence levels. Agent-centric structured data. |
| `session.context.drift` | KEEP-SINGLE | MCP-specific: analyzes context window drift during agent sessions. Not meaningful for human CLI users. |
| `session.decision.log` | KEEP-SINGLE | MCP-specific: query companion to `record.decision`. Returns structured decision audit trail for agents. |

### 3.2 Orchestrate Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `orchestrate.bootstrap` | KEEP-SINGLE | MCP-specific: brain state bootstrap for orchestrator agents. Provides pre-computed context window for agent startup. Not useful in CLI. |
| `orchestrate.critical.path` | KEEP-SINGLE | MCP-specific: longest dependency chain analysis for orchestrator planning. Agents need this for spawn ordering; humans use `orchestrate analyze` which includes this info. |
| `orchestrate.unblock.opportunities` | KEEP-SINGLE | MCP-specific: identifies unblocking opportunities for parallel work. Agent orchestration concern. |
| `orchestrate.skill.list` | KEEP-SINGLE | Already available via CLI `skills list`. This is a convenience alias within the orchestrate domain for agents. |
| `orchestrate.check` | KEEP-SINGLE | MCP-specific: spawn readiness validation. Agent checks before spawning subagents. |
| `orchestrate.skill.inject` | KEEP-SINGLE | MCP-specific: protocol injection for subagent spawning. Agent-to-agent concern. |

### 3.3 Research Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `research.contradictions` | KEEP-SINGLE | MCP-specific: finds conflicting research findings across manifest entries. Agent analysis concern for research protocol. The `research` CLI command doesn't have this but agents frequently need cross-reference analysis. |
| `research.superseded` | KEEP-SINGLE | MCP-specific: finds superseded research entries. Manifest lifecycle management for agents. |
| `research.inject` | KEEP-SINGLE | MCP-specific: gets protocol injection content for subagent spawning. |
| `research.compact` | KEEP-SINGLE | MCP-specific: manifest compaction. Automated maintenance. |
| `research.manifest.archive` | KEEP-SINGLE | MCP-specific: archives old manifest entries. Automated lifecycle. |

### 3.4 System Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `system.safestop` | ALREADY EXISTS | CLI `safestop` command exists. Both layers have this. |
| `system.inject.generate` | KEEP-SINGLE | MCP-specific: generates MVI injection content for agent doc files (CLAUDE.md, AGENTS.md). The CLI equivalent is `inject` command, but the MCP operation returns structured data for programmatic use. |
| `system.uncancel` | ALREADY EXISTS | CLI has `tasks uncancel` implicitly through task update operations. |

### 3.5 Validate Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `validate.coherence.check` | KEEP-SINGLE | MCP-specific: task graph consistency analysis. Agent-oriented validation that checks for circular dependencies, orphaned tasks, and graph integrity. CLI `validate` covers basic validation. |
| `validate.test.status` | KEEP-SINGLE | MCP-specific: test suite status query for agents making completion decisions. |
| `validate.test.coverage` | KEEP-SINGLE | MCP-specific: coverage metrics query for agents. |
| `validate.test.run` | KEEP-SINGLE | MCP-specific: triggers test execution. CLI users run tests directly. |
| `validate.compliance.record` | KEEP-SINGLE | MCP-specific: records compliance check results. Agent protocol compliance tracking. |
| `validate.compliance.summary` | KEEP-SINGLE | MCP-specific: aggregated compliance metrics for agent dashboards. |
| `validate.compliance.violations` | KEEP-SINGLE | MCP-specific: lists compliance violations for agent remediation. |

### 3.6 Skills Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `skills.list` (query) | ALREADY EXISTS | CLI `skills list` exists. Both layers have this. |
| `skills.show` (query) | ALREADY EXISTS | CLI `skills show` exists. Both layers have this. |
| `skills.find` (query) | ALREADY EXISTS | CLI `skills` command has find capability. |
| `skills.dispatch` (query) | KEEP-SINGLE | MCP-specific: simulates skill dispatch for orchestrator planning. |
| `skills.verify` (query) | KEEP-SINGLE | MCP-specific: validates skill frontmatter for skill authors. |
| `skills.dependencies` (query) | KEEP-SINGLE | MCP-specific: skill dependency tree for orchestrator. |
| `skills.install` (mutate) | KEEP-SINGLE | MCP-specific: programmatic skill installation. CLI users manage skills via filesystem. |
| `skills.uninstall` (mutate) | KEEP-SINGLE | MCP-specific: programmatic skill removal. |
| `skills.enable/disable` (mutate) | KEEP-SINGLE | MCP-specific: toggle skill availability. |
| `skills.configure` (mutate) | KEEP-SINGLE | MCP-specific: programmatic skill configuration. |
| `skills.refresh` (mutate) | KEEP-SINGLE | MCP-specific: refresh skill registry cache. |

### 3.7 Providers Domain

| MCP Operation | Decision | Rationale |
|---|---|---|
| `providers.list` (query) | KEEP-SINGLE | MCP-specific: lists registered LLM providers (Claude, Gemini, etc.). Part of CAAMP integration. |
| `providers.detect` (query) | KEEP-SINGLE | MCP-specific: detects installed providers. |
| `providers.inject.status` (query) | KEEP-SINGLE | MCP-specific: checks injection status for provider doc files. |
| `providers.inject` (mutate) | KEEP-SINGLE | MCP-specific: injects CLEO content into provider instruction files. |

---

## 4. Summary

### Decision Counts

| Decision | CLI-Only | MCP-Only | Total |
|---|---|---|---|
| KEEP-SINGLE | 19 | 38 | 57 |
| DEPRECATE | 2 | 0 | 2 |
| ADD | 0 | 0 | 0 |
| ALREADY EXISTS | 0 | 3 | 3 |

### Key Findings

1. **No operations need to be added to either layer.** The existing parity gaps are intentional and well-justified.

2. **CLI-only operations** fall into clear categories:
   - Protocol-specific validation shortcuts (6): subsumed by MCP's generic `validate.protocol`
   - Environment/installation management (5): requires system-level access
   - Cross-project federation (1): breaks MCP's single-project model
   - Data import/export (2): file-based operations
   - Observability (1): token metrics inspection
   - Web UI management (1): OS process lifecycle
   - Backward-compat aliases (1): deprecated

3. **MCP-only operations** are overwhelmingly agent-centric:
   - Session intelligence (4): decision/assumption recording, context drift
   - Orchestration internals (6): bootstrap, critical path, spawn management
   - Research lifecycle (5): contradictions, superseded, compaction
   - Validation pipeline (7): coherence, compliance, test integration
   - Skill management (11): programmatic skill lifecycle
   - Provider integration (4): CAAMP provider management

4. **Two operations should be deprecated:**
   - `claude-migrate`: Legacy one-time migration, no longer needed
   - `focus` (show/set/clear/history): Replaced by `start`/`stop`/`current`

### Design Principle Validation

The parity gap analysis confirms the shared-core architecture is working correctly:
- Both CLI and MCP call the same core functions in `src/core/`
- CLI adds human-friendly wrappers (interactive prompts, file I/O, browser launching)
- MCP adds agent-friendly structured operations (brain bootstrap, protocol injection, compliance tracking)
- Neither layer duplicates the other's unique concerns

---

## 5. Migration Path for Deprecated Operations

### `claude-migrate`
- **Current**: Migrates `.claude/` directory structure to `.cleo/`
- **Action**: Add deprecation warning to command output
- **Timeline**: Remove in next major version
- **Alternative**: Manual file moves or `cleo init` for fresh projects

### `focus` (backward-compat aliases)
- **Current**: `current` -> `current`, `start` -> `start`, `stop` -> `stop`
- **Action**: Already marked as deprecated in command descriptions (T4756)
- **Timeline**: Remove in next major version
- **Alternative**: Use `start`, `stop`, `current` commands directly

---

## 6. Core Functions Inventory

All operations in both layers delegate to shared core functions. No new core functions need to be created.

| Domain | Core Location | CLI Uses | MCP Uses |
|---|---|---|---|
| Tasks | `src/core/tasks/`, `src/core/task-work/` | Yes | Yes |
| Sessions | `src/core/sessions/` | Yes | Yes |
| Orchestration | `src/core/orchestration/` | Yes | Yes |
| Research | `src/core/research/` | Yes | Yes |
| Lifecycle | `src/core/lifecycle/` | Yes | Yes |
| Validation | `src/core/validation/` | Yes | Yes |
| Release | `src/core/release/` | Yes | Yes |
| System | `src/core/config.ts`, `src/core/stats/` | Yes | Yes |
| Skills | `src/core/skills/` (via engine) | Yes | Yes |
| Compliance | `src/core/compliance/` | Yes | Yes |
| Nexus | `src/core/nexus/` | CLI only | N/A (cross-project) |
| OTel | `src/core/otel/` | CLI only | N/A (metrics inspection) |
