---
name: SKILL-monorepo
description: >
  CLEO provider adapter for Anthropic Claude Code CLI. Default export is the adapter class for dynamic loading by AdapterManager.   T5240 Use when: (1) calling its 2479 API functions, (2) configuring @cleocode/monorepo, (3) understanding its 1732 type definitions, (4) working with its 103 classes, (5) user mentions "@cleocode/monorepo" or asks about its API.
---

# @cleocode/monorepo

CLEO provider adapter for Anthropic Claude Code CLI. Default export is the adapter class for dynamic loading by AdapterManager.   T5240

## Quick Start

```bash
npm install @cleocode/monorepo
```

```typescript
import { checkStatuslineIntegration } from './statusline.js';

const status = checkStatuslineIntegration();
if (status === 'not_configured') {
  console.log('Run cleo install to set up context monitoring');
}
```

## API

| Function | Description |
|----------|-------------|
| `checkStatuslineIntegration()` | Check if statusline integration is configured. Returns the current integration status. |
| `getStatuslineConfig()` | Get the statusline setup command for Claude Code settings. |
| `getSetupInstructions()` | Get human-readable setup instructions. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `readLatestTranscript()` | Read the most recent JSON or JSONL session file from `providerDir` and return its contents as a flat transcript string.  Files are sorted in descending order by filename — this works naturally for providers that embed timestamps in filenames. The most recently named file is read first.  Returns `null` when: - `providerDir` does not exist or cannot be read - No JSON/JSONL files are present - The most recent file contains no parseable turns |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `buildOpenCodeAgentMarkdown()` | Build the markdown content for an OpenCode agent definition file.  OpenCode agents are defined as markdown files with YAML frontmatter in the .opencode/agent/ directory. |
| `createAdapter()` | Factory function for creating adapter instances. Used by AdapterManager's dynamic import fallback. |
| `getProviderManifests()` | Get the manifests for all bundled provider adapters. |
| `discoverProviders()` | Discover all available provider adapters.  Returns a map of provider ID to adapter factory function. |
| `getPlatformPaths()` | Get OS-appropriate paths for CAAMP's global directories. |
| `getSystemInfo()` | Get a cached system information snapshot. |
| ... | 2464 more — see API reference |

## Configuration

```typescript
import type { DetectionConfig } from "@cleocode/monorepo";

const config: Partial<DetectionConfig> = {
  // Detection methods to try, in order.
  methods: [],
  // Binary name to look up on PATH (for `"binary"` method).
  binary: "...",
  // Directories to check for existence (for `"directory"` method).
  directories: "...",
  // macOS .app bundle name (for `"appBundle"` method).
  appBundle: "...",
  // Flatpak application ID (for `"flatpak"` method).
  flatpakId: "...",
};
```

See [references/CONFIGURATION.md](references/CONFIGURATION.md) for full details.

## Gotchas

- `HookEvent` is deprecated: Use `CanonicalHookEvent` from `../hooks/types.js` for the normalized CAAMP taxonomy. This type remains for backward compatibility with registry.json's `capabilities.hooks.supported` string arrays.
- `CtSkillEntry` is deprecated: Use `SkillLibraryEntry` instead.
- `CtValidationResult` is deprecated: Use `SkillLibraryValidationResult` instead.
- `CtValidationIssue` is deprecated: Use `SkillLibraryValidationIssue` instead.
- `CtProfileDefinition` is deprecated: Use `SkillLibraryProfile` instead.
- `CtDispatchMatrix` is deprecated: Use `SkillLibraryDispatchMatrix` instead.
- `CtManifest` is deprecated: Use `SkillLibraryManifest` instead.
- `CtManifestSkill` is deprecated: Use `SkillLibraryManifestSkill` instead.
- `getTaskPath` is deprecated: Use getAccessor() from './store/data-accessor.js' instead. This function   returns the database file path for legacy compatibility, but all task data access   should go through the DataAccessor interface to ensure proper SQLite interaction.   Example:     // OLD (deprecated):     const taskPath = getTaskPath(cwd);     const data = await readJsonFile(taskPath);     // NEW (correct):     const accessor = await getAccessor(cwd);     const data = await accessor.queryTasks();
- `getClaudeAgentsDir` is deprecated: Use AdapterPathProvider.getAgentInstallDir() from the active adapter instead.
- `getClaudeMemDbPath` is deprecated: Use AdapterPathProvider.getMemoryDbPath() from the active adapter instead.
- `OnSessionStartPayload` is deprecated: Use `SessionStartPayload` instead. Kept for backward compatibility.
- `OnSessionEndPayload` is deprecated: Use `SessionEndPayload` instead. Kept for backward compatibility.
- `OnToolStartPayload` is deprecated: Use `PreToolUsePayload` instead. Kept for backward compatibility.
- `OnToolCompletePayload` is deprecated: Use `PostToolUsePayload` instead. Kept for backward compatibility.
- `OnFileChangePayload` is deprecated: Use `NotificationPayload` instead. Kept for backward compatibility.
- `OnErrorPayload` is deprecated: Use `PostToolUseFailurePayload` instead. Kept for backward compatibility.
- `OnPromptSubmitPayload` is deprecated: Use `PromptSubmitPayload` instead. Kept for backward compatibility.
- `OnResponseCompletePayload` is deprecated: Use `ResponseCompletePayload` instead. Kept for backward compatibility.
- `AdapterTransportProvider` is deprecated: Use Transport instead. Will be removed after unification.
- `getRegistryPath` is deprecated: Use nexus.db via getNexusDb() instead. Retained for JSON-to-SQLite migration.
- `OnSessionStartPayloadSchema` is deprecated: Use `SessionStartPayloadSchema`. Kept for backward compatibility.
- `OnSessionEndPayloadSchema` is deprecated: Use `SessionEndPayloadSchema`. Kept for backward compatibility.
- `OnToolStartPayloadSchema` is deprecated: Use `PreToolUsePayloadSchema`. Kept for backward compatibility.
- `OnToolCompletePayloadSchema` is deprecated: Use `PostToolUsePayloadSchema`. Kept for backward compatibility.
- `OnFileChangePayloadSchema` is deprecated: Use `NotificationPayloadSchema`. Kept for backward compatibility.
- `OnErrorPayloadSchema` is deprecated: Use `PostToolUseFailurePayloadSchema`. Kept for backward compatibility.
- `OnPromptSubmitPayloadSchema` is deprecated: Use `PromptSubmitPayloadSchema`. Kept for backward compatibility.
- `OnResponseCompletePayloadSchema` is deprecated: Use `ResponseCompletePayloadSchema`. Kept for backward compatibility.
- `Capability` is deprecated: Use `AgentSkill` instead.
- `ServiceConfig` is deprecated: Use `AgentCard` instead.
- `EndpointConfig` is deprecated: Will be removed in v2.0.0.
- `DiscoveryDocument` is deprecated: Use `AgentCard` instead.
- `resolveProvidersRegistryPath()` throws: Error if `providers/registry.json` cannot be found within 8 parent levels
- `ensureProviderInstructionFile()` throws: Error if the provider ID is not found in the registry
- `ensureAllProviderInstructionFiles()` throws: Error if any provider ID is not found in the registry
- `resolveFormat()` throws: Error if format flags conflict
- `readConfig()` throws: If the file cannot be read or the format is unsupported
- `writeConfig()` throws: If the format is unsupported
- `removeConfig()` throws: If the format is unsupported
- `fetchWithTimeout()` throws: `NetworkError` on timeout or network failure
- `ensureOkResponse()` throws: `NetworkError` when `response.ok` is `false`
- `recommendSkills()` throws: Error with `code` and `issues` properties when criteria are invalid
- `loadLibraryFromModule()` throws: If the module cannot be loaded or does not implement SkillLibrary
- `buildLibraryFromFiles()` throws: If skills.json is not found at the root
- `registerSkillLibraryFromPath()` throws: Error if the library cannot be loaded from the given path
- `checkTaskExists()` throws: SafetyError if task exists and strict mode is enabled
- `verifyTaskWrite()` throws: SafetyError if verification fails
- `validateStage()` throws: Error If stage is invalid
- `setEmbeddingProvider()` throws: Error if provider dimensions do not match EMBEDDING_DIMENSIONS
- `loadAdapterFromManifest()` throws: If the module cannot be loaded or does not export a valid adapter
- `initializePipeline()` throws: CleoError If pipeline already exists or database operation fails
- `getPipeline()` throws: CleoError If database query fails
- `advanceStage()` throws: CleoError If transition is invalid or prerequisites not met
- `getCurrentStage()` throws: CleoError If database query fails
- `listPipelines()` throws: CleoError If database query fails
- `completePipeline()` throws: CleoError If pipeline not found or not in releasable state
- `cancelPipeline()` throws: CleoError If pipeline not found or already completed
- `getPipelineStatistics()` throws: CleoError If database query fails
- `validatePipelineStage()` throws: CleoError(VALIDATION_ERROR) if invalid
- `validatePipelineTransition()` throws: CleoError(VALIDATION_ERROR) if the transition is backward
- `validateEpicCreation()` throws: CleoError(VALIDATION_ERROR) in strict mode when constraints are violated.
- `validateChildStageCeiling()` throws: CleoError(VALIDATION_ERROR) in strict mode when the child stage exceeds the epic.
- `validateEpicStageAdvancement()` throws: CleoError(VALIDATION_ERROR) in strict mode when incomplete children exist.
- `bindSession()` throws: if a session is already bound (call unbindSession first).
- `parseQuery()` throws: CleoError with NEXUS_INVALID_SYNTAX for bad format.
- `withRetry()` throws: The last error thrown by `fn`, augmented with `RetryContext`   fields (`attempts`, `totalDelayMs`).
- `formatIsoDate()` throws: Error if date format is invalid or missing  T4552
- `getProjectInfo()` throws: Error If .cleo/project-info.json does not exist or is invalid JSON.
- `resolveSkillPathsForProvider()` throws: Error if provider not found
- `decrypt()` throws: If decryption fails (wrong key, corrupted data, or machine key mismatch).
- `resolveTemplate()` throws: Error If a referenced variable is not found in any scope.
- `checkPrerequisites()` throws: CleoError If validation fails
- `validateTransition()` throws: CleoError If validation fails unexpectedly
- `executeTransition()` throws: CleoError If transition is invalid
- `setStageStatus()` throws: CleoError If status transition is invalid
- `skipStage()` throws: CleoError If stage cannot be skipped
- `resolveOutputFormat()` throws: `LAFSFlagError` When `humanFlag` and `jsonFlag` are both truthy.
- `assertEnvelope()` throws: Error When the input does not conform to the envelope schema.
- `assertCompliance()` throws: `ComplianceError` When any compliance stage fails.
- `parseLafsResponse()` throws: LafsError When the envelope indicates failure (`success=false`).
- `parseLafsResponse()` throws: Error When the envelope is structurally invalid or   `requireRegisteredErrorCode` is `true` and the code is unregistered.
- `resolveFieldExtraction()` throws: `LAFSFlagError` When both `fieldFlag` and `fieldsFlag` are set.
- `resolveFlags()` throws: `LAFSFlagError` When format or field layer flags conflict.
- `getErrorCodeMapping()` throws: Error if the error type is not a known A2A error type
- `ExitCode` enum values: SUCCESS, GENERAL_ERROR, INVALID_INPUT, FILE_ERROR, NOT_FOUND, DEPENDENCY_ERROR, VALIDATION_ERROR, LOCK_TIMEOUT, CONFIG_ERROR, PARENT_NOT_FOUND, DEPTH_EXCEEDED, SIBLING_LIMIT, INVALID_PARENT_TYPE, CIRCULAR_REFERENCE, ORPHAN_DETECTED, HAS_CHILDREN, TASK_COMPLETED, CASCADE_FAILED, HAS_DEPENDENTS, CHECKSUM_MISMATCH, CONCURRENT_MODIFICATION, ID_COLLISION, SESSION_EXISTS, SESSION_NOT_FOUND, SCOPE_CONFLICT, SCOPE_INVALID, TASK_NOT_IN_SCOPE, TASK_CLAIMED, SESSION_REQUIRED, SESSION_CLOSE_BLOCKED, ACTIVE_TASK_REQUIRED, NOTES_REQUIRED, VERIFICATION_INIT_FAILED, GATE_UPDATE_FAILED, INVALID_GATE, INVALID_AGENT, MAX_ROUNDS_EXCEEDED, GATE_DEPENDENCY, VERIFICATION_LOCKED, ROUND_MISMATCH, CONTEXT_WARNING, CONTEXT_CAUTION, CONTEXT_CRITICAL, CONTEXT_EMERGENCY, CONTEXT_STALE, PROTOCOL_MISSING, INVALID_RETURN_MESSAGE, MANIFEST_ENTRY_MISSING, SPAWN_VALIDATION_FAILED, AUTONOMOUS_BOUNDARY, HANDOFF_REQUIRED, RESUME_FAILED, CONCURRENT_SESSION, NEXUS_NOT_INITIALIZED, NEXUS_PROJECT_NOT_FOUND, NEXUS_PERMISSION_DENIED, NEXUS_INVALID_SYNTAX, NEXUS_SYNC_FAILED, NEXUS_REGISTRY_CORRUPT, NEXUS_PROJECT_EXISTS, NEXUS_QUERY_FAILED, NEXUS_GRAPH_ERROR, NEXUS_RESERVED, LIFECYCLE_GATE_FAILED, AUDIT_MISSING, CIRCULAR_VALIDATION, LIFECYCLE_TRANSITION_INVALID, PROVENANCE_REQUIRED, ARTIFACT_TYPE_UNKNOWN, ARTIFACT_VALIDATION_FAILED, ARTIFACT_BUILD_FAILED, ARTIFACT_PUBLISH_FAILED, ARTIFACT_ROLLBACK_FAILED, PROVENANCE_CONFIG_INVALID, SIGNING_KEY_MISSING, SIGNATURE_INVALID, DIGEST_MISMATCH, ATTESTATION_INVALID, ADAPTER_NOT_FOUND, ADAPTER_INIT_FAILED, ADAPTER_HOOK_FAILED, ADAPTER_SPAWN_FAILED, ADAPTER_INSTALL_FAILED, NO_DATA, ALREADY_EXISTS, NO_CHANGE, TESTS_SKIPPED
- `OrchestrationLevel` enum values: HITL, Prime, ProjectLead, TeamLead, Ephemeral
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
- **`ClaudeCodeHookProvider`** — Hook provider for Claude Code.  Claude Code registers hooks via its global config at `~/.claude/settings.json`. Supported handler types: command, http, prompt, agent.  Event mapping is based on `getProviderHookProfile('claude-code')` from CAAMP 1.9.1. Async accessors (`getSupportedCanonicalEvents`, `getProviderProfile`) call CAAMP directly when available.  Since hooks are registered through the config system (managed by the install provider), `registerNativeHooks` and `unregisterNativeHooks` track registration state without performing filesystem operations.
- **`ClaudeCodeInstallProvider`** — Install provider for Claude Code.  Manages CLEO's integration with Claude Code by: 1. Ensuring CLAUDE.md contains -references to CLEO instruction files 2. Registering the brain observation plugin in ~/.claude/settings.json
- **`ClaudeCodeSpawnProvider`** — Spawn provider for Claude Code.  Spawns detached Claude CLI processes for subagent execution. Each spawn writes its prompt to a temporary file, then runs `claude --allow-insecure --no-upgrade-check <tmpFile>` as a detached, unref'd child process.
- **`ClaudeCodeTaskSyncProvider`** — Claude Code TaskSyncProvider.  Reads Claude's TodoWrite JSON state, parses [T001]-prefixed task IDs and status, and returns normalized ExternalTask[].  Optional: accepts a custom file path for testing.
- **`ClaudeCodeTransportProvider`** — Transport provider for Claude Code inter-agent communication.
- **`ClaudeCodeAdapter`** — CLEO provider adapter for Anthropic Claude Code CLI.  Bridges CLEO's adapter system with Claude Code's native capabilities: - Hooks: Maps Claude Code events (SessionStart, PostToolUse, etc.) to CAAMP events - Spawn: Launches subagent processes via the `claude` CLI - Install: Manages instruction files and brain observation plugin registration
- **`CodexHookProvider`** — Hook provider for Codex CLI.  Codex CLI registers hooks via its configuration system at ~/.codex/. Hook handlers are shell commands or script paths that execute when the corresponding event fires.  Since hooks are registered through the config system (managed by the install provider), registerNativeHooks and unregisterNativeHooks track registration state without performing filesystem operations.
- **`CodexInstallProvider`** — Install provider for Codex CLI.  Manages CLEO's integration with Codex CLI by: 1. Ensuring AGENTS.md contains -references to CLEO instruction files

## References

- [references/CONFIGURATION.md](references/CONFIGURATION.md) — Full config options
- [references/API-REFERENCE.md](references/API-REFERENCE.md) — Signatures, parameters, examples
