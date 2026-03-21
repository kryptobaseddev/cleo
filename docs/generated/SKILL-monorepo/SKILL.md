---
name: SKILL-monorepo
description: >
  Path provider for Anthropic Claude Code CLI.  Resolves Claude Code's standard directory layout: - Config dir: ~/.claude (or CLAUDE_HOME) - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS) - Agents: ~/.claude/agents - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB) Use when: (1) calling its 2066 API functions, (2) configuring @cleocode/monorepo, (3) understanding its 1396 type definitions, (4) working with its 58 classes, (5) user mentions "@cleocode/monorepo" or asks about its API.
---

# @cleocode/monorepo

Path provider for Anthropic Claude Code CLI.  Resolves Claude Code's standard directory layout: - Config dir: ~/.claude (or CLAUDE_HOME) - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS) - Agents: ~/.claude/agents - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB)

## Quick Start

```bash
npm install @cleocode/monorepo
```

```typescript
try {
  await riskyOperation();
} catch (err) {
  const error = normalizeError(err, 'Operation failed');
  console.error(error.message);
}
```

## API

| Function | Description |
|----------|-------------|
| `checkStatuslineIntegration()` | Check if statusline integration is configured. Returns the current integration status. |
| `getStatuslineConfig()` | Get the statusline setup command for Claude Code settings. |
| `getSetupInstructions()` | Get human-readable setup instructions. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `buildOpenCodeAgentMarkdown()` | Build the markdown content for an OpenCode agent definition file.  OpenCode agents are defined as markdown files with YAML frontmatter in the .opencode/agent/ directory. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `getProviderManifests()` | Get the manifests for all bundled provider adapters. |
| `discoverProviders()` | Discover all available provider adapters.  Returns a map of provider ID to adapter factory function. |
| `setFieldContext()` | Set the field extraction context for this CLI invocation. Called once from the preAction hook in src/cli/index.ts. |
| `getFieldContext()` | Get the current field extraction context. |
| `resolveFieldContext()` | Parse global field options from Commander.js parsed opts and resolve via the canonical LAFS SDK resolver (conflict detection, type narrowing). |
| `setFormatContext()` | Set the resolved format for this CLI invocation. Called once from the preAction hook in src/cli/index.ts. |
| `getFormatContext()` | Get the current resolved format. |
| `isJsonFormat()` | Check if output should be JSON format. |
| ... | 2051 more — see API reference |

## Configuration

```typescript
import type { DispatcherConfig } from "@cleocode/monorepo";

const config: Partial<DispatcherConfig> = {
  handlers: { /* ... */ },
  middlewares: [],
};
```

See [references/CONFIGURATION.md](references/CONFIGURATION.md) for full details.

## Gotchas

- `getTaskPath` is deprecated: Use getAccessor() from './store/data-accessor.js' instead. This function   returns the database file path for legacy compatibility, but all task data access   should go through the DataAccessor interface to ensure proper SQLite interaction.   Example:     // OLD (deprecated):     const taskPath = getTaskPath(cwd);     const data = await readJsonFile(taskPath);     // NEW (correct):     const accessor = await getAccessor(cwd);     const data = await accessor.queryTasks();
- `getClaudeAgentsDir` is deprecated: Use AdapterPathProvider.getAgentInstallDir() from the active adapter instead.
- `getClaudeMemDbPath` is deprecated: Use AdapterPathProvider.getMemoryDbPath() from the active adapter instead. Respects CLAUDE_MEM_DB env var, defaults to ~/.claude-mem/claude-mem.db. This is a third-party tool path; homedir() is correct here (no env-paths standard).
- `getRegistryPath` is deprecated: Use nexus.db via getNexusDb() instead. Retained for JSON-to-SQLite migration.
- `bindSession()` throws: if a session is already bound (call unbindSession first).
- `checkTaskExists()` throws: SafetyError if task exists and strict mode is enabled
- `verifyTaskWrite()` throws: SafetyError if verification fails
- `validateStage()` throws: Error If stage is invalid
- `sanitizeTaskId()` throws: SecurityError if ID is invalid
- `sanitizePath()` throws: SecurityError if path escapes project root or is invalid
- `sanitizeContent()` throws: SecurityError if content exceeds size limit
- `validateEnum()` throws: SecurityError if value is not in allowed set
- `sanitizeParams()` throws: SecurityError on validation failure
- `setEmbeddingProvider()` throws: Error if provider dimensions do not match EMBEDDING_DIMENSIONS
- `loadAdapterFromManifest()` throws: If the module cannot be loaded or does not export a valid adapter
- `parseQuery()` throws: CleoError with NEXUS_INVALID_SYNTAX for bad format.
- `initializePipeline()` throws: CleoError If pipeline already exists or database operation fails
- `getPipeline()` throws: CleoError If database query fails
- `advanceStage()` throws: CleoError If transition is invalid or prerequisites not met
- `getCurrentStage()` throws: CleoError If database query fails
- `listPipelines()` throws: CleoError If database query fails
- `completePipeline()` throws: CleoError If pipeline not found or not in releasable state
- `cancelPipeline()` throws: CleoError If pipeline not found or already completed
- `getPipelineStatistics()` throws: CleoError If database query fails
- `formatIsoDate()` throws: Error if date format is invalid or missing  T4552
- `getProjectInfo()` throws: Error If .cleo/project-info.json does not exist or is invalid JSON.
- `resolveSkillPathsForProvider()` throws: Error if provider not found
- `checkPrerequisites()` throws: CleoError If validation fails
- `validateTransition()` throws: CleoError If validation fails unexpectedly
- `executeTransition()` throws: CleoError If transition is invalid
- `setStageStatus()` throws: CleoError If status transition is invalid
- `skipStage()` throws: CleoError If stage cannot be skipped
- `ExitCode` enum values: SUCCESS, GENERAL_ERROR, INVALID_INPUT, FILE_ERROR, NOT_FOUND, DEPENDENCY_ERROR, VALIDATION_ERROR, LOCK_TIMEOUT, CONFIG_ERROR, PARENT_NOT_FOUND, DEPTH_EXCEEDED, SIBLING_LIMIT, INVALID_PARENT_TYPE, CIRCULAR_REFERENCE, ORPHAN_DETECTED, HAS_CHILDREN, TASK_COMPLETED, CASCADE_FAILED, HAS_DEPENDENTS, CHECKSUM_MISMATCH, CONCURRENT_MODIFICATION, ID_COLLISION, SESSION_EXISTS, SESSION_NOT_FOUND, SCOPE_CONFLICT, SCOPE_INVALID, TASK_NOT_IN_SCOPE, TASK_CLAIMED, SESSION_REQUIRED, SESSION_CLOSE_BLOCKED, ACTIVE_TASK_REQUIRED, NOTES_REQUIRED, VERIFICATION_INIT_FAILED, GATE_UPDATE_FAILED, INVALID_GATE, INVALID_AGENT, MAX_ROUNDS_EXCEEDED, GATE_DEPENDENCY, VERIFICATION_LOCKED, ROUND_MISMATCH, CONTEXT_WARNING, CONTEXT_CAUTION, CONTEXT_CRITICAL, CONTEXT_EMERGENCY, CONTEXT_STALE, PROTOCOL_MISSING, INVALID_RETURN_MESSAGE, MANIFEST_ENTRY_MISSING, SPAWN_VALIDATION_FAILED, AUTONOMOUS_BOUNDARY, HANDOFF_REQUIRED, RESUME_FAILED, CONCURRENT_SESSION, NEXUS_NOT_INITIALIZED, NEXUS_PROJECT_NOT_FOUND, NEXUS_PERMISSION_DENIED, NEXUS_INVALID_SYNTAX, NEXUS_SYNC_FAILED, NEXUS_REGISTRY_CORRUPT, NEXUS_PROJECT_EXISTS, NEXUS_QUERY_FAILED, NEXUS_GRAPH_ERROR, NEXUS_RESERVED, LIFECYCLE_GATE_FAILED, AUDIT_MISSING, CIRCULAR_VALIDATION, LIFECYCLE_TRANSITION_INVALID, PROVENANCE_REQUIRED, ARTIFACT_TYPE_UNKNOWN, ARTIFACT_VALIDATION_FAILED, ARTIFACT_BUILD_FAILED, ARTIFACT_PUBLISH_FAILED, ARTIFACT_ROLLBACK_FAILED, PROVENANCE_CONFIG_INVALID, SIGNING_KEY_MISSING, SIGNATURE_INVALID, DIGEST_MISMATCH, ATTESTATION_INVALID, ADAPTER_NOT_FOUND, ADAPTER_INIT_FAILED, ADAPTER_HOOK_FAILED, ADAPTER_SPAWN_FAILED, ADAPTER_INSTALL_FAILED, NO_DATA, ALREADY_EXISTS, NO_CHANGE, TESTS_SKIPPED
- `Severity` enum values: Low, Medium, High, Critical
- `ManifestIntegrity` enum values: Valid, Partial, Invalid, Missing
- `InstructionStability` enum values: Stable, Clarified, Revised, Unstable
- `SessionDegradation` enum values: None, Mild, Moderate, Severe
- `AgentReliability` enum values: High, Medium, Low, Unreliable
- `MetricCategory` enum values: Compliance, Efficiency, Session, Improvement
- `MetricSource` enum values: Task, Session, Agent, System, Orchestrator
- `AggregationPeriod` enum values: Instant, Hourly, Daily, Weekly, Monthly
- `ErrorSeverity` enum values: INFO, WARNING, ERROR, CRITICAL
- `ErrorCategory` enum values: GENERAL, HIERARCHY, CONCURRENCY, SESSION, VERIFICATION, CONTEXT, PROTOCOL, NEXUS, LIFECYCLE, SPECIAL
- `ProtocolExitCode` enum values: SUCCESS, E_GENERAL_ERROR, E_INVALID_INPUT, E_FILE_ERROR, E_NOT_FOUND, E_DEPENDENCY_ERROR, E_VALIDATION_ERROR, E_PARENT_NOT_FOUND, E_DEPTH_EXCEEDED, E_SIBLING_LIMIT, E_CIRCULAR_REFERENCE, E_SESSION_REQUIRED, E_PROTOCOL_RESEARCH, E_PROTOCOL_CONSENSUS, E_PROTOCOL_SPECIFICATION, E_PROTOCOL_DECOMPOSITION, E_PROTOCOL_IMPLEMENTATION, E_PROTOCOL_CONTRIBUTION, E_PROTOCOL_RELEASE, E_PROTOCOL_GENERIC, E_PROTOCOL_VALIDATION, E_TESTS_SKIPPED, E_LIFECYCLE_GATE_FAILED
- `ProtocolType` enum values: RESEARCH, CONSENSUS, SPECIFICATION, DECOMPOSITION, IMPLEMENTATION, CONTRIBUTION, RELEASE, VALIDATION, TESTING
- `GateLayer` enum values: SCHEMA, SEMANTIC, REFERENTIAL, PROTOCOL
- `GateStatus` enum values: PENDING, PASSED, FAILED, BLOCKED, SKIPPED
- `WorkflowGateName` enum values: IMPLEMENTED, TESTS_PASSED, QA_PASSED, CLEANUP_DONE, SECURITY_PASSED, DOCUMENTED

## Key Types

- **`ClaudeCodePathProvider`** — Path provider for Anthropic Claude Code CLI.  Resolves Claude Code's standard directory layout: - Config dir: ~/.claude (or CLAUDE_HOME) - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS) - Agents: ~/.claude/agents - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB)
- **`ClaudeCodeContextMonitorProvider`** — Context monitor provider for Claude Code.  Processes context window JSON from Claude Code and writes state files for statusline display. Also provides statusline configuration and setup instructions specific to Claude Code's settings.json.
- **`ClaudeCodeHookProvider`** — Hook provider for Claude Code.  Claude Code registers hooks via a plugin directory with a hooks.json descriptor. The actual hook scripts are shell scripts that invoke CLEO's brain observation system.  Since hooks are registered through the plugin system (installed via the install provider), registerNativeHooks and unregisterNativeHooks are effectively no-ops here — the plugin installer handles registration.
- **`ClaudeCodeInstallProvider`** — Install provider for Claude Code.  Manages CLEO's integration with Claude Code by: 1. Registering the CLEO MCP server in the project's .mcp.json 2. Ensuring CLAUDE.md contains -references to CLEO instruction files 3. Registering the brain observation plugin in ~/.claude/settings.json
- **`ClaudeCodeSpawnProvider`** — Spawn provider for Claude Code.  Spawns detached Claude CLI processes for subagent execution. Each spawn writes its prompt to a temporary file, then runs `claude --allow-insecure --no-upgrade-check <tmpFile>` as a detached, unref'd child process.
- **`ClaudeCodeTaskSyncProvider`** — Claude Code TaskSyncProvider.  Reads Claude's TodoWrite JSON state, parses [T001]-prefixed task IDs and status, and returns normalized ExternalTask[].  Optional: accepts a custom file path for testing.
- **`ClaudeCodeTransportProvider`**
- **`ClaudeCodeAdapter`** — CLEO provider adapter for Anthropic Claude Code CLI.  Bridges CLEO's adapter system with Claude Code's native capabilities: - Hooks: Maps Claude Code events (SessionStart, PostToolUse, etc.) to CAAMP events - Spawn: Launches subagent processes via the `claude` CLI - Install: Registers MCP server, instruction files, and brain observation plugin
- **`CursorHookProvider`** — Hook provider for Cursor (stub).  Cursor lacks a hook-based lifecycle event system. All mapping operations return null. Registration is a no-op.
- **`CursorInstallProvider`** — Install provider for Cursor.  Manages CLEO's integration with Cursor by: 1. Registering the CLEO MCP server in .cursor/mcp.json 2. Creating/updating .cursorrules with -references (legacy) 3. Creating .cursor/rules/cleo.mdc with -references (modern)

## References

- [references/CONFIGURATION.md](references/CONFIGURATION.md) — Full config options
- [references/API-REFERENCE.md](references/API-REFERENCE.md) — Signatures, parameters, examples
